// Lógica compartida entre la web y el script que descarga los datos cada día.
export const API = "https://api.tcgdex.net/v2/es";
const API_EN = "https://api.tcgdex.net/v2/en";

// Algunas rarezas llegan sin traducir desde la API.
export const RAREZAS = {
  "Uncommon": "Poco común",
  "Common": "Común",
  "Rare": "Rara",
  "Double rare": "Rara Doble",
  "Illustration rare": "Rara Ilustración",
  "Special illustration rare": "Rara Ilustración Especial",
  "Ultra Rare": "Ultra Rara",
  "Hyper rare": "Hiper Rara",
  "Mega Hyper Rare": "Mega Hiper Rara",
  "Futuristic Rare": "Rara Futurista",
  "Pikachu Rare": "Rara Pikachu",
  "RGB Rare": "Rara RGB",
  "None": "Sin rareza",
};

const num = (x) => (typeof x === "number" && x > 0 ? x : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

export function compactar(d) {
  const cm = d.pricing?.cardmarket || {};
  let v = Object.entries(d.variants || {})
    .filter(([k, on]) => on && k !== "wPromo")
    .map(([k]) => k);
  if (!v.length) v = ["normal"];
  return {
    id: d.id,
    n: d.localId,
    name: d.name,
    rar: RAREZAS[d.rarity] || d.rarity || "Sin rareza",
    img: d.image || null,
    cat: d.category || "",
    types: d.types || [],
    ill: d.illustrator || "",
    sid: d.set?.id || null,
    set: d.set?.name || null,
    v,
    p: {
      t: r2(num(cm.trend) ?? num(cm.avg)),
      th: r2(num(cm["trend-holo"]) ?? num(cm["avg-holo"])),
      a30: r2(num(cm.avg30)),
      a30h: r2(num(cm["avg30-holo"])),
      low: r2(num(cm.low)),
      upd: cm.updated || null,
    },
  };
}

export async function getJSON(url, fetchFn = fetch) {
  const r = await fetchFn(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
  return r.json();
}

export async function mapLimit(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      done++;
      onProgress?.(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function construirSet(id, { fetchFn = fetch, onProgress } = {}) {
  const s = await getJSON(`${API}/sets/${encodeURIComponent(id)}`, fetchFn);
  const cards = await mapLimit(
    s.cards || [],
    8,
    async (c) => {
      for (let intento = 0; intento < 3; intento++) {
        try {
          const d = await getJSON(`${API}/cards/${encodeURIComponent(c.id)}`, fetchFn);
          // Si la versión en español no trae precios, se toman de la versión en inglés (misma carta).
          if (!d.pricing?.cardmarket) {
            try {
              const en = await getJSON(`${API_EN}/cards/${encodeURIComponent(c.id)}`, fetchFn);
              if (en.pricing) d.pricing = en.pricing;
            } catch {}
          }
          return compactar(d);
        } catch (e) {
          if (intento === 2) {
            return { id: c.id, n: c.localId, name: c.name, img: c.image || null, rar: "Sin rareza", v: ["normal"], p: {}, sid: s.id, set: s.name };
          }
          await new Promise((r) => setTimeout(r, 800 * (intento + 1)));
        }
      }
    },
    onProgress
  );
  for (const c of cards) { c.sid = s.id; c.set = s.name; }
  return {
    id: s.id,
    name: s.name,
    logo: s.logo || null,
    symbol: s.symbol || null,
    fecha: s.releaseDate || null,
    serie: s.serie?.name || null,
    total: s.cardCount?.total ?? cards.length,
    oficial: s.cardCount?.official ?? null,
    actualizado: new Date().toISOString(),
    cards,
  };
}

/* Colecciones personalizadas (personalizadas.json): reúnen cartas de cualquier expansión
   cuyo nombre coincida con un patrón. Cada carta conserva su expansión de origen. */
const normal = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export async function construirPersonalizada(id, def, { fetchFn = fetch } = {}) {
  const patron = new RegExp(def.patron, "i");
  // Series que no son cartas físicas (p. ej. Pokémon TCG Pocket).
  const excluidas = new Set();
  for (const serie of def.excluirSeries || []) {
    const s = await getJSON(`${API_EN}/series/${encodeURIComponent(serie)}`, fetchFn);
    for (const x of s.sets || []) excluidas.add(x.id);
  }
  const lista = new Map();
  for (const base of [API_EN, API]) {
    // Sin fetchFn: los parámetros extra de la URL (p. ej. el antiacaché) TCGdex los toma como filtros.
    const r = await getJSON(`${base}/cards?name=${encodeURIComponent(def.buscar)}`);
    for (const c of r) if (patron.test(c.name)) lista.set(c.id, c);
  }
  const fechas = new Map();
  const fechaDe = async (sid) => {
    if (!fechas.has(sid)) {
      fechas.set(sid, getJSON(`${API_EN}/sets/${encodeURIComponent(sid)}`, fetchFn).then((s) => s.releaseDate || "").catch(() => ""));
    }
    return fechas.get(sid);
  };
  const leer = async (url) => {
    for (let intento = 0; intento < 3; intento++) {
      try { return await getJSON(url, fetchFn); }
      catch (e) {
        if (String(e.message).includes("HTTP 404")) return null;
        await new Promise((r) => setTimeout(r, 800 * (intento + 1)));
      }
    }
    return null;
  };
  const cartas = await mapLimit([...lista.keys()], 8, async (cid) => {
    const es = await leer(`${API}/cards/${encodeURIComponent(cid)}`);
    const en = await leer(`${API_EN}/cards/${encodeURIComponent(cid)}`);
    const d = es || en;
    if (!d || !d.set || excluidas.has(d.set.id)) return null;
    if (!normal(d.category).startsWith("pokemon") || !patron.test(d.name)) return null;
    if (!d.pricing?.cardmarket && en?.pricing) d.pricing = en.pricing;
    if (!d.image && en?.image) d.image = en.image;
    const c = compactar(d);
    c.fs = await fechaDe(d.set.id);
    return c;
  });
  const cards = cartas.filter(Boolean).sort((a, b) =>
    (a.fs || "9999").localeCompare(b.fs || "9999") || (a.sid || "").localeCompare(b.sid || "") ||
    String(a.n).localeCompare(String(b.n), "es", { numeric: true })
  );
  if (cards.length < (def.minimo || 1)) throw new Error(`Solo ${cards.length} cartas encontradas para ${id}`);
  return {
    id,
    name: def.name,
    personalizada: true,
    descripcion: def.descripcion || "",
    logo: null,
    symbol: null,
    fecha: null,
    serie: "Personalizada",
    total: cards.length,
    oficial: null,
    actualizado: new Date().toISOString(),
    cards,
  };
}

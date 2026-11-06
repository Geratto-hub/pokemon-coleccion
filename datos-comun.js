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

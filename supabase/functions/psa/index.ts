// Precios estimados de cartas graduadas (PSA 8, 9 y 10) a partir de PriceCharting.
// Se consulta solo cuando alguien pulsa "PSA" en una carta y se guarda 24 h en la base de datos.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });

const PC = "https://www.pricecharting.com";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; AlbumTCG/1.0; uso personal)", "Accept-Language": "en" };
const DIA = 24 * 3600e3;
// Expansiones cuyo nombre en PriceCharting no se deduce del nombre en inglés.
const SLUGS: Record<string, string> = { "30th": "pokemon-30th-celebration" };

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const sinCeros = (n: string) => n.replace(/^0+(?=\w)/, "").toLowerCase();

function analizar(nombre: string) {
  const m = nombre.match(/^(.*?)\s*(?:\[([^\]]+)\])?\s*(?:#(\S+))?\s*$/);
  return { base: (m?.[1] || nombre).trim(), variante: m?.[2] || "", numero: m?.[3] ? sinCeros(m[3]) : "" };
}

async function precioUSD() {
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR");
    const j = await r.json();
    return typeof j?.rates?.EUR === "number" ? j.rates.EUR : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  let cardId = "";
  try { cardId = String((await req.json()).card_id || ""); } catch { /* */ }
  if (!/^[\w.-]+-[\w.]+$/.test(cardId) || cardId.length > 40) return json({ error: "Carta no válida" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // Tipo de cambio USD → EUR (24 h)
  let { data: tc } = await db.from("tipo_cambio").select("usd_eur, actualizado").eq("id", 1).maybeSingle();
  if (!tc || Date.now() - new Date(tc.actualizado).getTime() > DIA) {
    const v = await precioUSD();
    if (v) { tc = { usd_eur: v, actualizado: new Date().toISOString() }; await db.from("tipo_cambio").upsert({ id: 1, ...tc }); }
  }
  const respuesta = (p: Record<string, unknown>) => json({ ...p, usd_eur: tc?.usd_eur ?? null });

  // ¿Ya lo tenemos?
  const { data: cache } = await db.from("psa_precios").select("*").eq("card_id", cardId).maybeSingle();
  if (cache && Date.now() - new Date(cache.actualizado).getTime() < DIA) return respuesta(cache);

  try {
    const setId = cardId.slice(0, cardId.lastIndexOf("-"));
    const local = sinCeros(cardId.slice(cardId.lastIndexOf("-") + 1));

    // Nombre en inglés de la carta y de la expansión
    const en = await fetch(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(cardId)}`).then((r) => (r.ok ? r.json() : null));
    if (!en) return json({ error: "Carta no encontrada" }, 404);
    const slug = SLUGS[setId] || `pokemon-${slugify(en.set?.name || setId)}`;

    // Lista de productos de la expansión en PriceCharting (7 días)
    const { data: ps } = await db.from("pc_sets").select("slug, actualizado").eq("set_id", setId).maybeSingle();
    let productos: { uri: string; nombre: string }[] = [];
    if (ps && ps.slug === slug && Date.now() - new Date(ps.actualizado).getTime() < 7 * DIA) {
      const { data } = await db.from("pc_productos").select("uri, nombre").eq("set_id", setId);
      productos = data || [];
    }
    if (!productos.length) {
      let cursor = "0";
      for (let i = 0; i < 12; i++) {
        const r = await fetch(`${PC}/console/${slug}?sort=model-number&cursor=${cursor}&format=json`, { headers: UA });
        if (!r.ok) break;
        const j = await r.json();
        const lote = (j.products || []).map((p: { productUri: string; productName: string }) => ({ uri: p.productUri, nombre: p.productName }));
        productos.push(...lote);
        if (!lote.length || !j.cursor || j.cursor === cursor) break;
        cursor = String(j.cursor);
      }
      if (!productos.length) return json({ error: "Esta expansión no está en PriceCharting" }, 404);
      await db.from("pc_sets").upsert({ set_id: setId, slug, actualizado: new Date().toISOString() });
      await db.from("pc_productos").delete().eq("set_id", setId);
      const unicos = [...new Map(productos.map((p) => [p.uri, p])).values()];
      for (let i = 0; i < unicos.length; i += 500) {
        await db.from("pc_productos").insert(unicos.slice(i, i + 500).map((p) => ({ set_id: setId, ...p })));
      }
    }

    // Buscar la carta: mismo número (o "R/RGB" para las especiales sin número) y preferir la versión normal
    const nombreEn = norm(en.name || "");
    const candidatos = productos.map((p) => ({ ...p, ...analizar(p.nombre) })).filter((p) =>
      p.numero ? p.numero === local : new RegExp(`\\b${local}/`, "i").test(p.base));
    if (!candidatos.length) return json({ error: "No he encontrado esta carta en PriceCharting" }, 404);
    const puntos = (p: ReturnType<typeof analizar> & { nombre: string }) =>
      (norm(p.base.replace(/\s+\w\/\w+$/, "")) === nombreEn ? 0 : norm(p.base).includes(nombreEn) ? 1 : 3) +
      (p.variante === "" ? 0 : p.variante === "Holo" ? 1 : /reverse/i.test(p.variante) ? 4 : 2);
    candidatos.sort((a, b) => puntos(a) - puntos(b));
    const elegido = candidatos[0];

    // Precios de la ficha del producto
    const url = `${PC}/game/${slug}/${elegido.uri}`;
    const html = await fetch(url, { headers: UA }).then((r) => (r.ok ? r.text() : ""));
    if (!html) return json({ error: "PriceCharting no responde ahora mismo" }, 502);
    const leer = (id: string) => {
      const m = html.match(new RegExp(`id="${id}"[\\s\\S]{0,400}?<span class="price js-price">\\s*([^<]*?)\\s*<`));
      const v = m ? parseFloat(m[1].replace(/[$,\s]/g, "")) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    const fila = {
      card_id: cardId,
      url,
      producto: elegido.nombre,
      ungraded: leer("used_price"),
      g8: leer("new_price"),
      g9: leer("graded_price"),
      psa10: leer("manual_only_price"),
      actualizado: new Date().toISOString(),
    };
    await db.from("psa_precios").upsert(fila);
    return respuesta(fila);
  } catch (e) {
    if (cache) return respuesta(cache); // mejor un precio de ayer que nada
    return json({ error: "No se pudieron obtener los precios: " + (e as Error).message }, 502);
  }
});

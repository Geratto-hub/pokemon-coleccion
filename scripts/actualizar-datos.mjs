// Descarga las cartas y precios de las colecciones configuradas y los guarda en data/.
// Lo ejecuta GitHub Actions cada día (ver .github/workflows/datos.yml).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { construirSet } from "../datos-comun.js";

// Evita respuestas antiguas en caché añadiendo un parámetro único a cada petición.
const marca = Date.now();
const fetchFresco = (url, opts) => fetch(url + (url.includes("?") ? "&" : "?") + "nc=" + marca, opts);

const ids = JSON.parse(await readFile(new URL("../colecciones.json", import.meta.url), "utf8"));
await mkdir(new URL("../data/", import.meta.url), { recursive: true });

for (const id of ids) {
  console.log(`Descargando ${id}…`);
  let set;
  try {
    set = await construirSet(id, { fetchFn: fetchFresco });
  } catch (e) {
    // Una expansión que falle (p. ej. aún no publicada en TCGdex) no debe impedir actualizar las demás.
    console.log(`::warning::No se pudo descargar ${id}: ${e.message}`);
    continue;
  }
  const conPrecio = set.cards.filter((c) => c.p?.t != null).length;
  console.log(`  ${set.name}: ${set.cards.length} cartas, ${conPrecio} con precio`);
  await writeFile(new URL(`../data/${id}.json`, import.meta.url), JSON.stringify(set));
}
console.log("Listo");

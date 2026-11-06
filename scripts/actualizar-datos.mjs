// Descarga las cartas y precios de las colecciones configuradas y los guarda en data/.
// Lo ejecuta GitHub Actions cada día (ver .github/workflows/datos.yml).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { construirSet } from "../datos-comun.js";

const ids = JSON.parse(await readFile(new URL("../colecciones.json", import.meta.url), "utf8"));
await mkdir(new URL("../data/", import.meta.url), { recursive: true });

for (const id of ids) {
  console.log(`Descargando ${id}…`);
  const set = await construirSet(id);
  const conPrecio = set.cards.filter((c) => c.p?.t != null).length;
  console.log(`  ${set.name}: ${set.cards.length} cartas, ${conPrecio} con precio`);
  await writeFile(new URL(`../data/${id}.json`, import.meta.url), JSON.stringify(set));
}
console.log("Listo");

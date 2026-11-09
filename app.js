import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { API, RAREZAS, compactar, construirSet, getJSON, mapLimit } from "./datos-comun.js";

const C = window.APP_CONFIG;
const sb = createClient(C.supabaseUrl, C.supabaseKey);
const FUNC = `${C.supabaseUrl}/functions/v1/admin-usuarios`;

const VARIANTES = { normal: "Normal", reverse: "Reverso", holo: "Holo", firstEdition: "1.ª edición" };
const ORDEN_RAREZA = [
  "Común", "Poco común", "Rara", "Rara Holo", "Rara Doble", "Rara Ilustración", "Ultra Rara",
  "Rara Ilustración Especial", "Hiper Rara", "Mega Hiper Rara", "Rara Pikachu", "Rara Futurista", "Rara RGB", "Sin rareza",
];

const E = {
  ids: [],            // expansiones configuradas
  sets: {},           // id -> datos del set
  cartaPorId: new Map(),
  sesion: null,
  perfil: null,
  copias: new Map(),  // "cardId|variante" -> cantidad
  deseos: new Set(),
  vista: {},          // estado de filtros por pantalla
};

/* ================= utilidades ================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (n) => (n == null ? "—" : n.toLocaleString("es-ES", { style: "currency", currency: "EUR" }));
const app = () => $("#app");
let EXTRA = {}; // imágenes manuales (imagenes-extra.json)
const img = (c, cal = "low") => EXTRA[c?.id]?.[cal] || (c?.img ? `${c.img}/${cal}.webp` : null);
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function precioVar(c, v) {
  const p = c?.p || {};
  if (v === "reverse") return p.th ?? p.t ?? null;
  return p.t ?? p.th ?? null;
}
const precio = (c) => precioVar(c, c?.v?.[0] || "normal");

function aviso(msg, error = false) {
  const a = $("#aviso");
  a.textContent = msg;
  a.className = "aviso" + (error ? " error" : "");
  a.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => (a.hidden = true), 2600);
}

function rarezaIdx(r) {
  const i = ORDEN_RAREZA.indexOf(r);
  return i === -1 ? 50 : i;
}

function leerHash() {
  const [ruta, qs] = location.hash.replace(/^#\/?/, "").split("?");
  return { partes: ruta.split("/").filter(Boolean), q: new URLSearchParams(qs || "") };
}

function cacheGet(k, maxMs) {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    if (v && Date.now() - v.t < maxMs) return v.d;
  } catch {}
  return null;
}
function cacheSet(k, d) {
  try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); } catch {}
}


/* Imágenes con alternativas: si la versión española no existe se usa la inglesa,
   y si tampoco existe se muestra un hueco con el nombre. */
const enIngles = (u) => (u && u.includes("/es/") ? u.replace("/es/", "/en/") : "");
function imgCarta(c, cal = "low", alt = "", clase = "") {
  const u = img(c, cal);
  const alts = [enIngles(u)].filter(Boolean).join("|");
  return `<img ${clase ? `class="${clase}"` : ""} loading="lazy" src="${esc(u)}" data-alt="${esc(alts)}" data-nombre="${esc(c.name)}" alt="${esc(alt)}">`;
}
function imgLogo(s, soloImagen = false) {
  const alts = [`${s.logo}.png`, enIngles(`${s.logo}.png`)].filter(Boolean).join("|");
  return `<img src="${esc(s.logo)}.webp" data-alt="${esc(alts)}" data-nombre="${esc(soloImagen ? "" : s.name)}" data-logo="1" alt="${esc(s.name)}">`;
}
document.addEventListener("error", (ev) => {
  const im = ev.target;
  if (!(im instanceof HTMLImageElement) || im.dataset.alt == null) return;
  const sig = im.dataset.alt.split("|").filter(Boolean);
  if (sig.length) { im.dataset.alt = sig.slice(1).join("|"); im.src = sig[0]; return; }
  if (im.closest(".abanico")) { im.remove(); return; }
  if (im.dataset.logo) {
    const sp = document.createElement("span"); sp.textContent = im.dataset.nombre || ""; im.replaceWith(sp); return;
  }
  const ph = document.createElement("div");
  ph.className = "sin-img" + (im.classList.contains("grande") ? " grande" : "");
  ph.textContent = im.closest(".bolsillo.falta") ? "" : (im.dataset.nombre || "Sin imagen");
  im.replaceWith(ph);
}, true);

/* ================= datos de cartas ================= */
async function cargarSet(id, onProgress) {
  if (E.sets[id]) return E.sets[id];
  let s = null;
  try {
    const r = await fetch(`data/${id}.json`, { cache: "no-cache" });
    if (r.ok) s = await r.json();
  } catch {}
  // Si los datos del servidor vienen sin precios en muchas cartas, se recalculan en el navegador.
  const respaldo = s;
  if (s && s.cards.filter((c) => c.p?.t == null && c.p?.th == null).length > s.cards.length * 0.2) s = null;
  if (!s) s = cacheGet(`set:${id}`, 12 * 3600e3);
  if (!s) {
    try {
      s = await construirSet(id, { onProgress });
      cacheSet(`set:${id}`, s);
    } catch (e) {
      if (!respaldo) throw e;
      s = respaldo;
    }
  }
  // Algunas expansiones no traen logo: se deduce de la ruta de sus imágenes.
  if (!s.logo) {
    const ref = s.cards.find((c) => c.img)?.img;
    if (ref) s.logo = ref.slice(0, ref.lastIndexOf("/")) + "/logo";
  }
  s.cards.sort((a, b) => String(a.n).localeCompare(String(b.n), "es", { numeric: true }));
  for (const c of s.cards) { c.rar = RAREZAS[c.rar] || c.rar; E.cartaPorId.set(c.id, c); }
  E.sets[id] = s;
  return s;
}

async function cargarTodos() {
  const pendientes = E.ids.filter((id) => !E.sets[id]);
  if (!pendientes.length) return;
  const prog = {};
  const pintar = () => {
    const tot = Object.values(prog).reduce((a, p) => a + p[1], 0) || 1;
    const hechos = Object.values(prog).reduce((a, p) => a + p[0], 0);
    const b = $(".cargando .barra i");
    if (b) b.style.width = `${Math.round((hechos / tot) * 100)}%`;
  };
  // Si una expansión no se puede cargar, se oculta y el resto de la web sigue funcionando.
  await Promise.all(pendientes.map((id) =>
    cargarSet(id, (d, t) => { prog[id] = [d, t]; pintar(); }).catch((e) => {
      console.warn(`No se pudo cargar ${id}:`, e);
      E.ids = E.ids.filter((x) => x !== id);
    })
  ));
}

function pantallaCarga(texto = "Cargando cartas…") {
  app().innerHTML = `<div class="cargando">${esc(texto)}<div class="barra"><i style="width:5%"></i></div></div>`;
}

/* ================= sesión y colección ================= */
async function cargarSesion() {
  const { data } = await sb.auth.getSession();
  E.sesion = data.session;
  E.perfil = null;
  E.copias.clear();
  E.deseos.clear();
  if (!E.sesion) return;
  const { data: perfil } = await sb.from("perfiles").select("usuario, es_admin").eq("id", E.sesion.user.id).maybeSingle();
  if (!perfil) {
    await sb.auth.signOut();
    E.sesion = null;
    aviso("Esta cuenta no tiene acceso a la colección", true);
    return;
  }
  E.perfil = perfil;
  const [{ data: cartas }, { data: deseos }] = await Promise.all([
    sb.from("cartas").select("card_id, variante, cantidad"),
    sb.from("deseos").select("card_id"),
  ]);
  for (const c of cartas || []) E.copias.set(`${c.card_id}|${c.variante}`, c.cantidad);
  for (const d of deseos || []) E.deseos.add(d.card_id);
}

const cuantas = (id, v) => E.copias.get(`${id}|${v}`) || 0;
function totalCopias(c) {
  let t = 0;
  for (const [k, n] of E.copias) if (k.slice(0, k.lastIndexOf("|")) === c.id) t += n;
  return t;
}
const laTengo = (c) => totalCopias(c) > 0;
function valorCopias(c) {
  let t = 0;
  for (const [k, n] of E.copias) {
    const i = k.lastIndexOf("|");
    const id = k.slice(0, i), v = k.slice(i + 1);
    if (id === c.id) t += n * (precioVar(c, v) || 0);
  }
  return t;
}

async function cambiarCopias(c, v, delta) {
  const antes = cuantas(c.id, v);
  const ahora = Math.max(0, antes + delta);
  if (ahora === antes) return;
  E.copias.set(`${c.id}|${v}`, ahora);
  if (!ahora) E.copias.delete(`${c.id}|${v}`);
  refrescarParcial(c);
  const sid = c.sid || c.id.split("-").slice(0, -1).join("-");
  const q = ahora
    ? sb.from("cartas").upsert({ card_id: c.id, set_id: sid, variante: v, cantidad: ahora, actualizado: new Date().toISOString(), user_id: E.sesion.user.id })
    : sb.from("cartas").delete().eq("card_id", c.id).eq("variante", v);
  const { error } = await q;
  if (error) {
    if (antes) E.copias.set(`${c.id}|${v}`, antes); else E.copias.delete(`${c.id}|${v}`);
    refrescarParcial(c);
    aviso("No se pudo guardar: " + error.message, true);
  }
}

async function alternarDeseo(c) {
  const tenia = E.deseos.has(c.id);
  tenia ? E.deseos.delete(c.id) : E.deseos.add(c.id);
  refrescarParcial(c);
  const { error } = tenia
    ? await sb.from("deseos").delete().eq("card_id", c.id)
    : await sb.from("deseos").insert({ card_id: c.id, user_id: E.sesion.user.id });
  if (error) {
    tenia ? E.deseos.add(c.id) : E.deseos.delete(c.id);
    refrescarParcial(c);
    aviso("No se pudo guardar: " + error.message, true);
  } else aviso(tenia ? "Quitada de la lista de deseos" : "Añadida a la lista de deseos ★");
}

// Tras cambiar una carta: actualiza el modal y repinta la vista actual sin perder el scroll.
function refrescarParcial(c) {
  if (!$("#modal").hidden && $("#modal-caja").dataset.id === c.id) pintarModal(c);
  const y = scrollY;
  render(true).then(() => scrollTo(0, y));
}

/* ================= navegación ================= */
function pintarNav() {
  const r = leerHash().partes[0] || "";
  const enlace = (h, t) => `<a href="#/${h}" class="${r === h ? "activo" : ""}">${t}</a>`;
  let html = enlace("", "Inicio") + enlace("buscar", "Buscador");
  for (const id of E.ids) {
    const s = E.sets[id];
    if (s && !E.perfil) html += `<a href="#/set/${id}" class="${leerHash().partes[1] === id && r === "set" ? "activo" : ""}">${esc(s.name)}</a>`;
  }
  if (E.perfil) {
    html += enlace("album", "Mi álbum") + enlace("deseos", "Deseos") + enlace("repetidas", "Repetidas");
    if (E.perfil.es_admin) html += enlace("admin", "Usuarios");
    html += `<a href="#/cuenta" class="usuario-chip ${r === "cuenta" ? "activo" : ""}">👤 ${esc(E.perfil.usuario)}</a>`;
    html += `<button data-accion="salir">Salir</button>`;
  } else {
    html += enlace("entrar", "Entrar");
  }
  $("#nav").innerHTML = html;
}

const RUTAS = {
  "": vistaInicio,
  buscar: vistaBuscar,
  set: vistaSet,
  album: vistaAlbum,
  deseos: vistaDeseos,
  repetidas: vistaRepetidas,
  admin: vistaAdmin,
  cuenta: vistaCuenta,
  entrar: vistaEntrar,
  configurar: vistaConfigurar,
};
const PRIVADAS = new Set(["album", "deseos", "repetidas", "cuenta", "admin"]);

async function render(silencioso = false) {
  const { partes, q } = leerHash();
  let r = partes[0] || "";
  if (!RUTAS[r]) r = "";
  if (PRIVADAS.has(r) && !E.perfil) { location.hash = "#/entrar"; return; }
  if (r === "admin" && !E.perfil.es_admin) { location.hash = "#/album"; return; }
  $("#nav").classList.remove("abierta");
  if (!silencioso && E.ids.some((id) => !E.sets[id])) pantallaCarga();
  await cargarTodos().catch((e) => console.error(e));
  pintarNav();
  await RUTAS[r](partes.slice(1), q, silencioso);
}

/* ================= componentes ================= */
function fichaHTML(c) {
  const im = img(c);
  return `<button class="ficha" data-carta="${esc(c.id)}">
    <div class="img">${im ? `${imgCarta(c, "low", c.name)}` : `<div class="sin-img">${esc(c.name)}</div>`}</div>
    <div class="nom">${esc(c.name)}</div>
    <div class="meta">${esc(c.set || "")} · ${esc(c.n)}</div>
    <div class="meta">${esc(c.rar)}</div>
    <div class="precio">${eur(precio(c))}</div>
  </button>`;
}

function tapaHTML(s, href) {
  const valor = s.cards.reduce((a, c) => a + (precio(c) || 0), 0);
  let prog = "";
  if (E.perfil) {
    const tengo = s.cards.filter(laTengo).length;
    const pct = Math.round((tengo / s.cards.length) * 100);
    prog = `<div class="progreso"><div class="progreso-barra"><i style="width:${pct}%"></i></div><small>${tengo} / ${s.cards.length} cartas · ${pct}%</small></div>`;
  }
  return `<a class="tapa" href="${href}">
    <div class="etiqueta">${s.logo ? `${imgLogo(s)}` : `<span>${esc(s.name)}</span>`}</div>
    <h3>${esc(s.name)}</h3>
    <div class="datos"><span><b>${s.cards.length}</b> cartas</span><span>Set completo: <b>${eur(valor)}</b></span>${s.fecha ? `<span>${new Date(s.fecha).toLocaleDateString("es-ES", { month: "short", year: "numeric" })}</span>` : ""}</div>
    ${prog}
  </a>`;
}

function rarezasDe(cartas) {
  return [...new Set(cartas.map((c) => c.rar))].sort((a, b) => rarezaIdx(a) - rarezaIdx(b) || a.localeCompare(b));
}
const opcionesRareza = (cartas, sel) =>
  `<option value="">Todas las rarezas</option>` + rarezasDe(cartas).map((r) => `<option ${r === sel ? "selected" : ""}>${esc(r)}</option>`).join("");

/* ================= vistas públicas ================= */
async function vistaInicio() {
  const todas = E.ids.flatMap((id) => E.sets[id]?.cards || []);
  const caras = [...todas].filter((c) => precio(c)).sort((a, b) => precio(b) - precio(a));
  const abanico = caras.filter((c) => img(c)).slice(0, 8);
  app().innerHTML = `
    <section class="portada">
      <div>
        <h1>Tu álbum de cartas Pokémon</h1>
        <p>Consulta el precio estimado de cada carta y ${E.perfil ? "lleva el control de tu colección." : "entra para llevar el control de tu colección."}</p>
        <form class="buscador-mini" data-form="busqueda-rapida">
          <input name="q" placeholder="Busca una carta… (ej. Pikachu)" aria-label="Buscar carta">
          <button class="btn azul">Buscar</button>
        </form>
        <div class="acciones">
          ${E.perfil ? `<a class="btn rojo" href="#/album">Abrir mi álbum</a>` : `<a class="btn" href="#/entrar">Entrar</a>`}
          <a class="btn" href="#/buscar?orden=precio-desc">Ver las más caras</a>
        </div>
      </div>
      <div class="abanico">${abanico.map((c) => `${imgCarta(c, "low", c.name, "").replace('loading="lazy"', "")}`).join("")}</div>
    </section>

    <section class="seccion">
      <div class="seccion-cab"><h2>Expansiones</h2></div>
      <div class="tapas">${E.ids.map((id) => E.sets[id] && tapaHTML(E.sets[id], E.perfil ? `#/album/${id}` : `#/set/${id}`)).join("")}</div>
    </section>

    <section class="seccion">
      <div class="seccion-cab"><h2>Las más valiosas</h2><a href="#/buscar?orden=precio-desc">Ver todas →</a></div>
      <div class="rejilla">${caras.slice(0, 12).map(fichaHTML).join("")}</div>
    </section>`;
}

async function vistaSet([id], q) {
  if (!E.ids.includes(id)) { location.hash = "#/"; return; }
  const s = await cargarSet(id);
  const rar = q.get("rar") || "";
  const orden = q.get("orden") || "numero";
  let cartas = s.cards.filter((c) => !rar || c.rar === rar);
  cartas = ordenar(cartas, orden);
  const valor = s.cards.reduce((a, c) => a + (precio(c) || 0), 0);
  app().innerHTML = `
    <div class="album-cab">
      <div class="logo">${s.logo ? imgLogo(s, true) : ""}</div>
      <div>
        <h1>${esc(s.name)}</h1>
        <div class="cifras">
          <div class="cifra"><small>Cartas</small><b>${s.cards.length}</b></div>
          <div class="cifra"><small>Set completo</small><b class="rojo">${eur(valor)}</b></div>
          ${s.fecha ? `<div class="cifra"><small>Salida</small><b>${new Date(s.fecha).toLocaleDateString("es-ES")}</b></div>` : ""}
        </div>
      </div>
      <div>${E.perfil ? `<a class="btn rojo" href="#/album/${id}">Abrir en mi álbum</a>` : `<a class="btn" href="#/entrar">Entrar para coleccionar</a>`}</div>
    </div>
    <div class="barra-album">
      <select class="select" data-filtro="rar">${opcionesRareza(s.cards, rar)}</select>
      <select class="select" data-filtro="orden">${opcionesOrden(orden)}</select>
    </div>
    <div class="rejilla">${cartas.map(fichaHTML).join("")}</div>`;
}

function opcionesOrden(o) {
  const ops = [["numero", "Nº de carta"], ["precio-desc", "Precio: de mayor a menor"], ["precio-asc", "Precio: de menor a mayor"], ["nombre", "Nombre"], ["rareza", "Rareza"]];
  return ops.map(([v, t]) => `<option value="${v}" ${o === v ? "selected" : ""}>${t}</option>`).join("");
}
function ordenar(cartas, o) {
  const a = [...cartas];
  const p = (c) => precio(c) ?? -1;
  if (o === "precio-desc") a.sort((x, y) => p(y) - p(x));
  else if (o === "precio-asc") a.sort((x, y) => (precio(x) ?? 1e9) - (precio(y) ?? 1e9));
  else if (o === "nombre") a.sort((x, y) => x.name.localeCompare(y.name, "es"));
  else if (o === "rareza") a.sort((x, y) => rarezaIdx(y.rar) - rarezaIdx(x.rar) || p(y) - p(x));
  else a.sort((x, y) => (x.sid || "").localeCompare(y.sid || "") || String(x.n).localeCompare(String(y.n), "es", { numeric: true }));
  return a;
}

async function buscarEnTodas(texto) {
  const k = `busq:${norm(texto)}`;
  const enCache = cacheGet(k, 6 * 3600e3);
  if (enCache) return enCache;
  const lista = await getJSON(`${API}/cards?name=${encodeURIComponent(texto)}&pagination:page=1&pagination:itemsPerPage=60`);
  const det = await mapLimit(lista, 8, (c) => getJSON(`${API}/cards/${encodeURIComponent(c.id)}`).then(compactar).catch(() => null));
  const res = det.filter(Boolean);
  cacheSet(k, res);
  return res;
}

async function vistaBuscar(_, q, silencioso) {
  const texto = q.get("q") || "";
  const set = q.get("set") || "";
  const rar = q.get("rar") || "";
  const min = q.get("min") || "";
  const max = q.get("max") || "";
  const orden = q.get("orden") || (texto ? "relevancia" : "precio-desc");
  const todas = q.get("todas") === "1";
  const pag = Math.max(1, +q.get("p") || 1);

  const locales = E.ids.flatMap((id) => E.sets[id]?.cards || []);
  let base = locales;
  let errorRemoto = "";
  if (todas && texto.trim().length >= 2) {
    if (!silencioso) {
      app().innerHTML = `<div class="buscador"><div class="cargando">Buscando en todas las expansiones…</div></div>`;
    }
    try {
      const remotos = await buscarEnTodas(texto.trim());
      for (const c of remotos) if (!E.cartaPorId.has(c.id)) E.cartaPorId.set(c.id, c);
      base = remotos.map((c) => E.cartaPorId.get(c.id));
    } catch (e) {
      errorRemoto = "No se pudo consultar el catálogo completo ahora mismo; muestro solo las expansiones de la web.";
    }
  }
  const t = norm(texto.trim());
  let res = base.filter((c) =>
    (!t || norm(c.name).includes(t) || norm(c.ill).includes(t) || String(c.n) === t) &&
    (!set || c.sid === set) &&
    (!rar || c.rar === rar) &&
    (!min || (precio(c) ?? -1) >= +min) &&
    (!max || (precio(c) ?? 1e9) <= +max)
  );
  if (orden === "relevancia" && t) {
    const score = (c) => (norm(c.name) === t ? 0 : norm(c.name).startsWith(t) ? 1 : 2);
    res.sort((a, b) => score(a) - score(b) || (precio(b) ?? -1) - (precio(a) ?? -1));
  } else res = ordenar(res, orden === "relevancia" ? "precio-desc" : orden);

  const POR_PAG = 25;
  const paginas = Math.max(1, Math.ceil(res.length / POR_PAG));
  const trozo = res.slice((pag - 1) * POR_PAG, pag * POR_PAG);
  const setsOpc = E.ids.map((id) => `<option value="${id}" ${set === id ? "selected" : ""}>${esc(E.sets[id]?.name || id)}</option>`).join("");

  app().innerHTML = `
    <div class="buscador">
      <h1>Buscador de cartas y precios</h1>
      <form data-form="buscar">
        <div class="barra-busqueda">
          <input name="q" value="${esc(texto)}" placeholder="Nombre de la carta, ilustrador o número…" aria-label="Buscar" autocomplete="off">
          <button>Buscar</button>
        </div>
        <div class="filtros">
          <select class="select" name="set" ${todas ? "disabled" : ""}><option value="">Todas las expansiones de la web</option>${setsOpc}</select>
          <select class="select" name="rar">${opcionesRareza(base, rar)}</select>
          <input class="input" name="min" type="number" min="0" step="0.01" placeholder="Precio mín. €" value="${esc(min)}">
          <input class="input" name="max" type="number" min="0" step="0.01" placeholder="Precio máx. €" value="${esc(max)}">
          <select class="select" name="orden">
            <option value="relevancia" ${orden === "relevancia" ? "selected" : ""}>Más relevantes</option>
            ${opcionesOrden(orden)}
          </select>
          <label class="check"><input type="checkbox" name="todas" value="1" ${todas ? "checked" : ""}> Buscar en todas las expansiones Pokémon</label>
        </div>
      </form>
      ${errorRemoto ? `<p class="error">${esc(errorRemoto)}</p>` : ""}
      ${todas && texto.trim().length < 2 ? `<p class="resumen-busqueda">Escribe al menos 2 letras para buscar en todo el catálogo.</p>` : ""}
      <div class="resumen-busqueda">${res.length.toLocaleString("es-ES")} resultado${res.length === 1 ? "" : "s"}${todas && res.length >= 60 ? " (se muestran los 60 primeros del catálogo; afina la búsqueda)" : ""}</div>
      <div class="resultados">
        ${trozo.map((c) => `
          <button class="resultado" data-carta="${esc(c.id)}">
            ${img(c) ? imgCarta(c, "low", "") : `<div class="mini"></div>`}
            <div>
              <div class="t">${esc(c.name)}</div>
              <div class="s">${esc(c.set || "")} · Nº ${esc(c.n)} · ${esc(c.rar)}${c.ill ? ` · Ilus. ${esc(c.ill)}` : ""}</div>
            </div>
            <div class="pr"><b>${eur(precio(c))}</b><small>${c.p?.a30 ? `media 30 d: ${eur(c.p.a30)}` : "tendencia Cardmarket"}</small></div>
          </button>`).join("") || `<div class="vacio-msg">No hay cartas que coincidan con la búsqueda.</div>`}
      </div>
      ${paginas > 1 ? `<div class="paginacion">${Array.from({ length: paginas }, (_, i) => i + 1).map((n) =>
        `<button class="btn peq ${n === pag ? "azul" : ""}" data-pag="${n}">${n}</button>`).join("")}</div>` : ""}
    </div>`;
}

/* ================= vistas privadas ================= */
async function vistaAlbum([id], q) {
  if (!id) return vistaResumenAlbum();
  if (!E.ids.includes(id)) { location.hash = "#/album"; return; }
  const s = await cargarSet(id);
  const filtro = q.get("ver") || "todas";
  const rar = q.get("rar") || "";
  const txt = norm(q.get("q") || "");

  const tengo = s.cards.filter(laTengo);
  const faltan = s.cards.filter((c) => !laTengo(c));
  const repes = s.cards.filter((c) => totalCopias(c) > 1);
  const deseadas = s.cards.filter((c) => E.deseos.has(c.id));
  const valorTengo = s.cards.reduce((a, c) => a + valorCopias(c), 0);
  const costeFalta = faltan.reduce((a, c) => a + (precio(c) || 0), 0);
  const pct = Math.round((tengo.length / s.cards.length) * 100);

  const grupos = { todas: s.cards, tengo, faltan, repetidas: repes, deseos: deseadas };
  let cartas = (grupos[filtro] || s.cards).filter((c) => (!rar || c.rar === rar) && (!txt || norm(c.name).includes(txt) || String(c.n) === txt));

  const chip = (k, t, n) => `<a class="chip ${filtro === k ? "activo" : ""}" href="#/album/${id}?${new URLSearchParams({ ...Object.fromEntries(q), ver: k })}">${t} <span class="n">${n}</span></a>`;

  const paginas = [];
  for (let i = 0; i < cartas.length; i += 9) paginas.push(cartas.slice(i, i + 9));

  app().innerHTML = `
    <div class="album-cab">
      <div class="logo">${s.logo ? imgLogo(s, true) : ""}</div>
      <div>
        <h1>${esc(s.name)}</h1>
        <div class="cifras">
          <div class="cifra"><small>Tengo</small><b>${tengo.length} / ${s.cards.length}</b></div>
          <div class="cifra"><small>Valor de lo que tengo</small><b class="rojo">${eur(valorTengo)}</b></div>
          <div class="cifra"><small>Completarlo costaría</small><b class="azul">${eur(costeFalta)}</b></div>
        </div>
      </div>
      <div class="pct">${pct}%<small>completado</small></div>
    </div>
    <div class="barra-album">
      ${chip("todas", "Todas", s.cards.length)}
      ${chip("tengo", "Tengo", tengo.length)}
      ${chip("faltan", "Me faltan", faltan.length)}
      ${chip("repetidas", "Repetidas", repes.length)}
      ${chip("deseos", "★ Deseos", deseadas.length)}
    </div>
    <div class="barra-album">
      <input class="input" data-filtro="q" placeholder="Buscar en este álbum…" value="${esc(q.get("q") || "")}">
      <select class="select" data-filtro="rar">${opcionesRareza(s.cards, rar)}</select>
    </div>
    ${cartas.length ? `
    <div class="libro" data-libro="${esc(id)}">
      <button class="flecha izq" data-pasar="-1" aria-label="Página anterior">‹</button>
      <div class="carpeta libro-abierto">${paginas.map((p, i) => `
        <div class="pagina ${i % 2 ? "pag-dcha" : "pag-izq"}" data-pag-libro="${i}" hidden>
          <div class="bolsillos">${p.map(bolsilloHTML).join("")}${"<div class='bolsillo vacio'></div>".repeat(9 - p.length)}</div>
          <span class="num-pag">PÁG. ${i + 1}</span>
        </div>`).join("")}
        <div class="pagina pag-dcha pagina-fin" data-pag-libro="fin" hidden><div class="fin-album"><span class="titulo-pixel">FIN DEL ÁLBUM</span></div></div>
      </div>
      <button class="flecha der" data-pasar="1" aria-label="Página siguiente">›</button>
    </div>
    <div class="libro-nav">
      <button class="btn peq" data-pasar="inicio" aria-label="Primera página">« Inicio</button>
      <select class="select" data-ir-pagina aria-label="Ir a página"></select>
      <button class="btn peq" data-pasar="fin" aria-label="Última página">Final »</button>
    </div>` : `<div class="tarjeta vacio-msg"><div class="titulo-pixel">¡Nada por aquí!</div>No hay cartas con este filtro.</div>`}`;
  iniciarLibro(`${id}|${filtro}|${rar}|${txt}`, paginas.length);
}

function bolsilloHTML(c) {
  const n = totalCopias(c);
  const im = img(c);
  return `<div class="bolsillo ${n ? "" : "falta"}" data-carta="${esc(c.id)}" role="button" tabindex="0" aria-label="${esc(c.name)}">
    ${im ? imgCarta(c, "low", n ? c.name : "") : ""}
    ${n ? "" : `<div class="hueco"><span>${esc(c.n)}<em>${esc(c.name)}</em></span></div>`}
    ${n > 0 ? `<span class="cant">×${n}</span>` : ""}
    ${E.deseos.has(c.id) ? `<span class="deseo" title="En tu lista de deseos">★</span>` : ""}
    <button class="mas" data-mas="${esc(c.id)}" title="Añadir una copia (${esc(VARIANTES[c.v[0]] || c.v[0])})" aria-label="Añadir una copia">+</button>
  </div>`;
}

async function vistaResumenAlbum() {
  const sets = E.ids.map((id) => E.sets[id]).filter(Boolean);
  const todas = sets.flatMap((s) => s.cards);
  const valor = todas.reduce((a, c) => a + valorCopias(c), 0);
  const unicas = todas.filter(laTengo).length;
  const copias = [...E.copias.values()].reduce((a, b) => a + b, 0);
  const repes = todas.reduce((a, c) => a + Math.max(0, totalCopias(c) - 1), 0);
  app().innerHTML = `
    <div class="resumen">
      <div class="cifra"><small>Valor total de mi colección</small><b class="rojo">${eur(valor)}</b></div>
      <div class="cifra"><small>Cartas distintas</small><b>${unicas} / ${todas.length}</b></div>
      <div class="cifra"><small>Copias en total</small><b>${copias}</b></div>
      <div class="cifra"><small>Repetidas</small><b class="azul">${repes}</b></div>
      <div class="cifra"><small>En deseos</small><b>${E.deseos.size}</b></div>
    </div>
    <div class="seccion-cab"><h2>Mis álbumes</h2></div>
    <div class="tapas">${sets.map((s) => tapaHTML(s, `#/album/${s.id}`)).join("")}</div>`;
}

function listaCartasTabla(filas, cols) {
  return `<div class="tabla-envoltura"><table class="tabla">
    <thead><tr><th></th><th>Carta</th>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${c.t}</th>`).join("")}</tr></thead>
    <tbody>${filas.map((c) => `<tr class="clic" data-carta="${esc(c.id)}">
      <td>${img(c) ? imgCarta(c, "low", "") : ""}</td>
      <td><b>${esc(c.name)}</b><br><small>${esc(c.set || "")} · ${esc(c.n)} · ${esc(c.rar)}</small></td>
      ${cols.map((col) => `<td class="${col.num ? "num" : ""}">${col.f(c)}</td>`).join("")}
    </tr>`).join("")}</tbody></table></div>`;
}

async function vistaDeseos() {
  const ids = [...E.deseos];
  const faltan = ids.filter((id) => !E.cartaPorId.has(id));
  if (faltan.length) {
    await mapLimit(faltan, 6, (id) => getJSON(`${API}/cards/${encodeURIComponent(id)}`).then((d) => E.cartaPorId.set(id, compactar(d))).catch(() => {}));
  }
  const cartas = ids.map((id) => E.cartaPorId.get(id)).filter(Boolean).sort((a, b) => (precio(b) ?? -1) - (precio(a) ?? -1));
  const pendientes = cartas.filter((c) => !laTengo(c));
  const total = pendientes.reduce((a, c) => a + (precio(c) || 0), 0);
  app().innerHTML = `
    <div class="resumen">
      <div class="cifra"><small>Cartas en la lista</small><b>${cartas.length}</b></div>
      <div class="cifra"><small>Aún no las tengo</small><b>${pendientes.length}</b></div>
      <div class="cifra"><small>Conseguirlas costaría</small><b class="rojo">${eur(total)}</b></div>
    </div>
    <div class="tarjeta">
      <h2>★ Lista de deseos</h2>
      ${cartas.length ? listaCartasTabla(cartas, [
        { t: "Estado", f: (c) => (laTengo(c) ? `<span class="ok">¡Conseguida!</span>` : "Pendiente") },
        { t: "Precio", num: true, f: (c) => `<b>${eur(precio(c))}</b>` },
      ]) : `<div class="vacio-msg"><div class="titulo-pixel">Lista vacía</div>Abre una carta y pulsa «Añadir a deseos».</div>`}
    </div>`;
}

async function vistaRepetidas() {
  const todas = E.ids.flatMap((id) => E.sets[id]?.cards || []);
  const repes = todas.filter((c) => totalCopias(c) > 1).map((c) => {
    const extra = totalCopias(c) - 1;
    // valor de las copias sobrantes: se asume que te quedas la más valiosa
    const precios = [];
    for (const v of c.v) for (let i = 0; i < cuantas(c.id, v); i++) precios.push(precioVar(c, v) || 0);
    precios.sort((a, b) => b - a);
    return { c, extra, valor: precios.slice(1).reduce((a, b) => a + b, 0) };
  }).sort((a, b) => b.valor - a.valor);
  const totalExtra = repes.reduce((a, r) => a + r.extra, 0);
  const totalValor = repes.reduce((a, r) => a + r.valor, 0);
  const info = new Map(repes.map((r) => [r.c.id, r]));
  app().innerHTML = `
    <div class="resumen">
      <div class="cifra"><small>Cartas con repetidas</small><b>${repes.length}</b></div>
      <div class="cifra"><small>Copias sobrantes</small><b class="azul">${totalExtra}</b></div>
      <div class="cifra"><small>Valor de las sobrantes</small><b class="rojo">${eur(totalValor)}</b></div>
    </div>
    <div class="tarjeta">
      <h2>Repetidas para cambiar o vender</h2>
      ${repes.length ? listaCartasTabla(repes.map((r) => r.c), [
        { t: "Copias", num: true, f: (c) => c.v.filter((v) => cuantas(c.id, v)).map((v) => `${cuantas(c.id, v)} ${VARIANTES[v] || v}`).join("<br>") },
        { t: "Sobran", num: true, f: (c) => `<b>${info.get(c.id).extra}</b>` },
        { t: "Valor sobrantes", num: true, f: (c) => `<b>${eur(info.get(c.id).valor)}</b>` },
      ]) : `<div class="vacio-msg"><div class="titulo-pixel">Sin repetidas</div>Cuando tengas más de una copia de una carta aparecerá aquí.</div>`}
    </div>`;
}


/* ================= libro (álbum página a página) ================= */
const porVista = () => (innerWidth >= 900 ? 2 : 1);
function iniciarLibro(clave, total) {
  if (!total) return;
  const L = E.vista.libro;
  if (!L || L.clave !== clave) E.vista.libro = { clave, idx: 0, total };
  else L.total = total;
  mostrarLibro();
}
function mostrarLibro(dir = 0) {
  const L = E.vista.libro;
  const cont = $(".libro-abierto");
  if (!L || !cont) return;
  const n = porVista();
  const max = Math.max(0, Math.floor((L.total - 1) / n) * n);
  L.idx = Math.min(Math.max(0, Math.floor(L.idx / n) * n), max);
  cont.classList.toggle("doble", n === 2);
  cont.querySelectorAll("[data-pag-libro]").forEach((p) => {
    const i = p.dataset.pagLibro === "fin" ? L.total : +p.dataset.pagLibro;
    const visible = i >= L.idx && i < L.idx + n && (p.dataset.pagLibro !== "fin" || (n === 2 && L.total % 2 === 1));
    p.hidden = !visible;
    p.classList.remove("entra-sig", "entra-ant");
    if (visible && dir) { void p.offsetWidth; p.classList.add(dir > 0 ? "entra-sig" : "entra-ant"); }
  });
  $('.flecha.izq').disabled = L.idx === 0;
  $('.flecha.der').disabled = L.idx >= max;
  const sel = $("[data-ir-pagina]");
  if (sel) {
    const ops = [];
    for (let i = 0; i <= max; i += n) {
      const fin = Math.min(i + n, L.total);
      ops.push(`<option value="${i}" ${i === L.idx ? "selected" : ""}>${n === 2 && fin - i === 2 ? `Páginas ${i + 1}–${fin}` : `Página ${i + 1}`} de ${L.total}</option>`);
    }
    sel.innerHTML = ops.join("");
  }
}
function pasarPagina(accion) {
  const L = E.vista.libro;
  if (!L || !$(".libro-abierto")) return;
  const n = porVista();
  const antes = L.idx;
  if (accion === "inicio") L.idx = 0;
  else if (accion === "fin") L.idx = L.total;
  else L.idx += +accion * n;
  const dir = Math.sign(L.idx - antes);
  mostrarLibro(dir);
  if (L.idx !== antes) $(".libro")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
let anchoPrevio = innerWidth;
addEventListener("resize", () => {
  if ((anchoPrevio >= 900) !== (innerWidth >= 900)) mostrarLibro();
  anchoPrevio = innerWidth;
});
let toqueX = null;
document.addEventListener("touchstart", (ev) => { toqueX = ev.target.closest(".libro") ? ev.touches[0].clientX : null; }, { passive: true });
document.addEventListener("touchend", (ev) => {
  if (toqueX == null) return;
  const dx = ev.changedTouches[0].clientX - toqueX;
  toqueX = null;
  if (Math.abs(dx) > 60) pasarPagina(dx < 0 ? 1 : -1);
}, { passive: true });

/* ================= modal de carta ================= */
async function abrirCarta(id) {
  let c = E.cartaPorId.get(id);
  if (!c) {
    try { c = compactar(await getJSON(`${API}/cards/${encodeURIComponent(id)}`)); E.cartaPorId.set(id, c); }
    catch { return aviso("No se pudo cargar la carta", true); }
  }
  pintarModal(c);
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
}
function cerrarModal() {
  $("#modal").hidden = true;
  document.body.style.overflow = "";
}
function pintarModal(c) {
  const caja = $("#modal-caja");
  caja.dataset.id = c.id;
  const p = c.p || {};
  const tieneReverso = c.v.includes("reverse");
  const cmUrl = `https://www.cardmarket.com/es/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name)}`;
  caja.innerHTML = `
    <button class="cerrar" data-accion="cerrar" aria-label="Cerrar">✕</button>
    <div>${img(c) ? imgCarta(c, "high", c.name, "grande") : `<div class="grande sin-img">${esc(c.name)}</div>`}</div>
    <div>
      <h2>${esc(c.name)}</h2>
      <div class="sub">${esc(c.set || "")} · Nº ${esc(c.n)}</div>
      <div class="etiquetas">
        <span class="etq rar">${esc(c.rar)}</span>
        ${c.cat ? `<span class="etq">${esc(c.cat)}</span>` : ""}
        ${(c.types || []).map((t) => `<span class="etq">${esc(t)}</span>`).join("")}
        ${c.ill ? `<span class="etq">Ilus. ${esc(c.ill)}</span>` : ""}
      </div>
      <div class="precios">
        <div class="cifra dest"><small>Precio estimado</small><b>${eur(p.t ?? p.th)}</b></div>
        <div class="cifra"><small>Media 30 días</small><b>${eur(p.a30)}</b></div>
        <div class="cifra"><small>Desde</small><b>${eur(p.low)}</b></div>
        ${tieneReverso ? `<div class="cifra"><small>Reverso</small><b>${eur(p.th)}</b></div>` : ""}
      </div>
      <p class="sub" style="font-size:13px">Tendencia de Cardmarket${p.upd ? `, actualizada el ${new Date(p.upd).toLocaleDateString("es-ES")}` : ""}. <a href="${cmUrl}" target="_blank" rel="noopener">Ver en Cardmarket ↗</a></p>
      ${E.perfil ? `
        <div class="mis-copias">
          <h3>MIS COPIAS</h3>
          ${c.v.map((v) => `
            <div class="variante">
              <div class="vn">${esc(VARIANTES[v] || v)}<small>${eur(precioVar(c, v))} / ud.</small></div>
              <div class="contador">
                <button data-copia="${esc(v)}" data-delta="-1" aria-label="Quitar una">−</button>
                <output>${cuantas(c.id, v)}</output>
                <button class="mas" data-copia="${esc(v)}" data-delta="1" aria-label="Añadir una">+</button>
              </div>
            </div>`).join("")}
          <div class="variante"><div class="vn">Valor de mis copias</div><b>${eur(valorCopias(c))}</b></div>
        </div>
        <div class="acciones-carta">
          <button class="btn ${E.deseos.has(c.id) ? "azul" : ""}" data-accion="deseo">${E.deseos.has(c.id) ? "★ En mi lista de deseos" : "☆ Añadir a deseos"}</button>
        </div>` : `<div class="acciones-carta"><a class="btn rojo" href="#/entrar" data-accion="cerrar">Entra para añadirla a tu colección</a></div>`}
    </div>`;
}

/* ================= acceso ================= */
const emailDe = (u) => `${u.trim().toLowerCase()}@${C.dominioUsuarios}`;

async function vistaEntrar() {
  if (E.perfil) { location.hash = "#/album"; return; }
  app().innerHTML = `
    <div class="acceso"><form class="tarjeta" data-form="entrar">
      <h1>ENTRAR</h1>
      <p class="sub" style="margin:0">Accede con el usuario y la contraseña que te ha dado el administrador.</p>
      <label class="campo">Usuario<input name="usuario" autocomplete="username" required autocapitalize="none"></label>
      <label class="campo">Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="error" data-error></p>
      <button class="btn rojo">Entrar</button>
      <p class="sub" style="margin:0;font-size:13px" data-config></p>
    </form></div>`;
  llamarFuncion({ accion: "hay_admin" }).then((r) => {
    if (r && r.hay_admin === false) $("[data-config]").innerHTML = `¿Primera vez? <a href="#/configurar">Crea la cuenta de administrador</a>.`;
  }).catch(() => {});
}

async function vistaConfigurar() {
  app().innerHTML = `
    <div class="acceso"><form class="tarjeta" data-form="configurar">
      <h1>CONFIGURACIÓN INICIAL</h1>
      <p class="sub" style="margin:0">Crea la cuenta de administrador. Necesitas el código de configuración que guardaste en Supabase.</p>
      <label class="campo">Código de configuración<input name="codigo" type="password" required></label>
      <label class="campo">Tu usuario<input name="usuario" required pattern="[a-z0-9_.\\-]{3,20}" title="3-20 caracteres: minúsculas, números, punto, guion o guion bajo" autocapitalize="none"></label>
      <label class="campo">Contraseña (mín. 8)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <p class="error" data-error></p>
      <button class="btn rojo">Crear administrador</button>
    </form></div>`;
}

async function vistaCuenta() {
  app().innerHTML = `
    <div class="acceso"><form class="tarjeta" data-form="cuenta">
      <h1>MI CUENTA</h1>
      <p style="margin:0">Usuario: <b>${esc(E.perfil.usuario)}</b>${E.perfil.es_admin ? " · administrador" : ""}</p>
      <label class="campo">Nueva contraseña (mín. 8)<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label class="campo">Repite la contraseña<input name="password2" type="password" minlength="8" required autocomplete="new-password"></label>
      <p class="error" data-error></p>
      <button class="btn azul">Cambiar contraseña</button>
    </form></div>`;
}

async function llamarFuncion(body) {
  const { data } = await sb.auth.getSession();
  const r = await fetch(FUNC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: C.supabaseKey,
      ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

async function vistaAdmin() {
  app().innerHTML = `
    <div class="tarjeta">
      <h2>Dar de alta a un usuario</h2>
      <form class="form-fila" data-form="crear-usuario">
        <label class="campo">Usuario<input name="usuario" required pattern="[a-z0-9_.\\-]{3,20}" title="3-20 caracteres: minúsculas, números, punto, guion o guion bajo" autocapitalize="none"></label>
        <label class="campo">Contraseña (mín. 8)<input name="password" type="text" minlength="8" required autocomplete="off"></label>
        <label class="check" style="display:flex;gap:6px;align-items:center;font-weight:800;padding-bottom:10px"><input type="checkbox" name="es_admin"> Administrador</label>
        <button class="btn rojo">Crear</button>
      </form>
      <p class="error" data-error></p>
    </div>
    <div class="tarjeta"><h2>Usuarios</h2><div data-lista>Cargando…</div></div>`;
  pintarUsuarios();
}

async function pintarUsuarios() {
  const cont = $("[data-lista]");
  if (!cont) return;
  try {
    const { usuarios } = await llamarFuncion({ accion: "listar" });
    cont.innerHTML = `<div class="tabla-envoltura"><table class="tabla">
      <thead><tr><th>Usuario</th><th>Rol</th><th>Alta</th><th></th></tr></thead>
      <tbody>${usuarios.map((u) => `<tr>
        <td><b>${esc(u.usuario)}</b></td>
        <td>${u.es_admin ? "Administrador" : "Coleccionista"}</td>
        <td>${new Date(u.creado).toLocaleDateString("es-ES")}</td>
        <td class="num">
          <form class="form-fila" data-form="reset" data-id="${esc(u.id)}" style="justify-content:flex-end">
            <input class="input" name="password" type="text" minlength="8" placeholder="Nueva contraseña" required style="width:170px">
            <button class="btn peq">Cambiar</button>
            ${u.usuario !== E.perfil.usuario ? `<button type="button" class="btn peq rojo" data-borrar="${esc(u.id)}" data-nombre="${esc(u.usuario)}">Borrar</button>` : ""}
          </form>
        </td></tr>`).join("")}</tbody></table></div>`;
  } catch (e) {
    cont.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}

/* ================= eventos ================= */
function actualizarHash(cambios, base) {
  const { partes, q } = leerHash();
  for (const [k, v] of Object.entries(cambios)) v ? q.set(k, v) : q.delete(k);
  const ruta = base ?? partes.join("/");
  location.hash = `#/${ruta}${q.toString() ? "?" + q : ""}`;
}

document.addEventListener("click", async (ev) => {
  const t = ev.target;
  const mas = t.closest("[data-mas]");
  if (mas) {
    ev.stopPropagation();
    const c = E.cartaPorId.get(mas.dataset.mas);
    if (c) { await cambiarCopias(c, c.v[0], 1); aviso(`+1 ${c.name}`); }
    return;
  }
  const copia = t.closest("[data-copia]");
  if (copia) {
    const c = E.cartaPorId.get($("#modal-caja").dataset.id);
    if (c) cambiarCopias(c, copia.dataset.copia, +copia.dataset.delta);
    return;
  }
  const pasar = t.closest("[data-pasar]");
  if (pasar) { pasarPagina(pasar.dataset.pasar); return; }
  const acc = t.closest("[data-accion]")?.dataset.accion;
  if (acc === "cerrar") { if (t.closest("a")) cerrarModal(); else { ev.preventDefault(); cerrarModal(); } return; }
  if (acc === "menu") { $("#nav").classList.toggle("abierta"); return; }
  if (acc === "salir") { await sb.auth.signOut(); await cargarSesion(); location.hash = "#/"; render(); return; }
  if (acc === "deseo") { const c = E.cartaPorId.get($("#modal-caja").dataset.id); if (c) alternarDeseo(c); return; }
  const carta = t.closest("[data-carta]");
  if (carta) { abrirCarta(carta.dataset.carta); return; }
  const pag = t.closest("[data-pag]");
  if (pag) { actualizarHash({ p: pag.dataset.pag === "1" ? "" : pag.dataset.pag }); scrollTo(0, 0); return; }
  const borrar = t.closest("[data-borrar]");
  if (borrar) {
    if (borrar.dataset.confirmar !== "1") {
      borrar.dataset.confirmar = "1";
      borrar.textContent = `¿Borrar a ${borrar.dataset.nombre}?`;
      setTimeout(() => { if (borrar.isConnected) { borrar.dataset.confirmar = ""; borrar.textContent = "Borrar"; } }, 4000);
      return;
    }
    try { await llamarFuncion({ accion: "borrar", id: borrar.dataset.borrar }); aviso("Usuario borrado"); pintarUsuarios(); }
    catch (e) { aviso(e.message, true); }
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("#modal").hidden) cerrarModal();
  if ((ev.key === "ArrowRight" || ev.key === "ArrowLeft") && $("#modal").hidden && !ev.target.closest("input, select, textarea") && $(".libro-abierto")) {
    ev.preventDefault();
    pasarPagina(ev.key === "ArrowRight" ? 1 : -1);
  }
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches(".bolsillo[data-carta]")) { ev.preventDefault(); abrirCarta(ev.target.dataset.carta); }
});

document.addEventListener("change", (ev) => {
  if (ev.target.matches("[data-ir-pagina]")) {
    const L = E.vista.libro; const antes = L.idx; L.idx = +ev.target.value; mostrarLibro(Math.sign(L.idx - antes)); return;
  }
  const f = ev.target.closest("[data-filtro]");
  if (f) { actualizarHash({ [f.dataset.filtro]: f.value }); return; }
  const form = ev.target.closest('form[data-form="buscar"]');
  if (form && ev.target.name !== "q") enviarBusqueda(form);
});

let tBusq;
document.addEventListener("input", (ev) => {
  const f = ev.target.closest('[data-filtro="q"]');
  if (f) { clearTimeout(tBusq); tBusq = setTimeout(() => actualizarHash({ q: f.value }), 350); }
});

function enviarBusqueda(form) {
  const fd = new FormData(form);
  const p = new URLSearchParams();
  for (const [k, v] of fd) if (v) p.set(k, v);
  location.hash = `#/buscar${p.toString() ? "?" + p : ""}`;
}

document.addEventListener("submit", async (ev) => {
  const form = ev.target;
  const tipo = form.dataset.form;
  if (!tipo) return;
  ev.preventDefault();
  const fd = Object.fromEntries(new FormData(form));
  const err = form.querySelector("[data-error]") || form.parentElement.querySelector("[data-error]");
  const boton = form.querySelector("button:not([type=button])");
  const fallo = (m) => { if (err) err.textContent = m; else aviso(m, true); if (boton) boton.disabled = false; };
  if (err) err.textContent = "";

  if (tipo === "busqueda-rapida") { location.hash = `#/buscar?q=${encodeURIComponent(fd.q || "")}`; return; }
  if (tipo === "buscar") { enviarBusqueda(form); return; }
  if (boton) boton.disabled = true;

  if (tipo === "entrar") {
    const { error } = await sb.auth.signInWithPassword({ email: emailDe(fd.usuario), password: fd.password });
    if (error) return fallo(/invalid/i.test(error.message) ? "Usuario o contraseña incorrectos" : error.message);
    await cargarSesion();
    if (!E.perfil) return fallo("Esta cuenta no tiene acceso");
    location.hash = "#/album";
    return;
  }
  if (tipo === "configurar") {
    try {
      await llamarFuncion({ accion: "inicial", codigo: fd.codigo, usuario: fd.usuario.trim().toLowerCase(), password: fd.password });
      const { error } = await sb.auth.signInWithPassword({ email: emailDe(fd.usuario), password: fd.password });
      if (error) throw error;
      await cargarSesion();
      aviso("¡Administrador creado!");
      location.hash = "#/admin";
    } catch (e) { fallo(e.message); }
    return;
  }
  if (tipo === "cuenta") {
    if (fd.password !== fd.password2) return fallo("Las contraseñas no coinciden");
    const { error } = await sb.auth.updateUser({ password: fd.password });
    if (error) return fallo(error.message);
    form.reset(); boton.disabled = false; aviso("Contraseña cambiada");
    return;
  }
  if (tipo === "crear-usuario") {
    try {
      await llamarFuncion({ accion: "crear", usuario: fd.usuario.trim().toLowerCase(), password: fd.password, es_admin: !!fd.es_admin });
      aviso(`Usuario ${fd.usuario} creado`);
      form.reset(); boton.disabled = false; pintarUsuarios();
    } catch (e) { fallo(e.message); }
    return;
  }
  if (tipo === "reset") {
    try {
      await llamarFuncion({ accion: "password", id: form.dataset.id, password: fd.password });
      aviso("Contraseña actualizada"); form.reset(); boton.disabled = false;
    } catch (e) { fallo(e.message); }
  }
});

window.addEventListener("hashchange", () => { cerrarModal(); render(); scrollTo(0, 0); });

/* ================= arranque ================= */
(async function iniciar() {
  try {
    E.ids = await fetch("colecciones.json", { cache: "no-cache" }).then((r) => r.json());
  } catch { E.ids = ["me03", "me04", "me05", "30th", "me06"]; }
  try { EXTRA = await fetch("imagenes-extra.json", { cache: "no-cache" }).then((r) => r.json()); } catch {}
  await cargarSesion().catch((e) => console.error(e));
  sb.auth.onAuthStateChange((evento) => {
    if (evento === "SIGNED_OUT" && E.perfil) { cargarSesion().then(() => render()); }
  });
  render();
})();

// Función de administración de usuarios.
// Solo un administrador puede crear, listar, borrar o cambiar contraseñas.
// La acción "inicial" crea el primer administrador usando el código SETUP_CODE
// y deja de funcionar en cuanto existe algún administrador.
import { createClient } from "jsr:@supabase/supabase-js@2";

const DOMINIO = "usuarios.pokemon-coleccion.app";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const validarUsuario = (u: unknown) =>
  typeof u === "string" && /^[a-z0-9_.-]{3,20}$/.test(u);
const validarPassword = (p: unknown) => typeof p === "string" && p.length >= 8 && p.length <= 72;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Petición no válida" }, 400); }
  const accion = body.accion;

  const crear = async (usuario: string, password: string, esAdmin: boolean) => {
    const { data, error } = await admin.auth.admin.createUser({
      email: `${usuario}@${DOMINIO}`, password, email_confirm: true,
      user_metadata: { usuario },
    });
    if (error) {
      const msg = /already|registered|exists/i.test(error.message) ? "Ese usuario ya existe" : error.message;
      return json({ error: msg }, 400);
    }
    const { error: e2 } = await admin.from("perfiles").insert({ id: data.user.id, usuario, es_admin: esAdmin });
    if (e2) {
      await admin.auth.admin.deleteUser(data.user.id);
      return json({ error: e2.message.includes("duplicate") ? "Ese usuario ya existe" : e2.message }, 400);
    }
    return json({ ok: true, usuario });
  };

  // --- Primer administrador ---
  if (accion === "inicial") {
    const codigo = Deno.env.get("SETUP_CODE");
    if (!codigo) return json({ error: "El código de configuración no está definido" }, 400);
    const { count } = await admin.from("perfiles").select("id", { count: "exact", head: true }).eq("es_admin", true);
    if ((count ?? 0) > 0) return json({ error: "Ya existe un administrador" }, 403);
    if (body.codigo !== codigo) return json({ error: "Código incorrecto" }, 403);
    if (!validarUsuario(body.usuario)) return json({ error: "Usuario no válido (3-20 caracteres: minúsculas, números, . _ -)" }, 400);
    if (!validarPassword(body.password)) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
    return crear(body.usuario as string, body.password as string, true);
  }

  if (accion === "hay_admin") {
    const { count } = await admin.from("perfiles").select("id", { count: "exact", head: true }).eq("es_admin", true);
    return json({ hay_admin: (count ?? 0) > 0 });
  }

  // --- El resto requiere ser administrador ---
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = await admin.auth.getUser(token);
  if (!u?.user) return json({ error: "Sesión no válida" }, 401);
  const { data: yo } = await admin.from("perfiles").select("es_admin").eq("id", u.user.id).maybeSingle();
  if (!yo?.es_admin) return json({ error: "Solo un administrador puede hacer esto" }, 403);

  if (accion === "crear") {
    if (!validarUsuario(body.usuario)) return json({ error: "Usuario no válido (3-20 caracteres: minúsculas, números, . _ -)" }, 400);
    if (!validarPassword(body.password)) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
    return crear(body.usuario as string, body.password as string, body.es_admin === true);
  }

  if (accion === "listar") {
    const { data, error } = await admin.from("perfiles").select("id, usuario, es_admin, creado").order("creado");
    if (error) return json({ error: error.message }, 400);
    return json({ usuarios: data });
  }

  if (accion === "borrar") {
    if (body.id === u.user.id) return json({ error: "No puedes borrarte a ti mismo" }, 400);
    const { error } = await admin.auth.admin.deleteUser(String(body.id));
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  if (accion === "password") {
    if (!validarPassword(body.password)) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
    const { error } = await admin.auth.admin.updateUserById(String(body.id), { password: body.password as string });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "Acción desconocida" }, 400);
});

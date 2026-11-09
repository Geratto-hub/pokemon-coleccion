-- Amigos: solicitudes, lista y consulta de colecciones.
-- Las tablas solo se leen; todos los cambios pasan por las funciones de abajo.

create table public.amistades (
  id uuid primary key default gen_random_uuid(),
  solicitante uuid not null references auth.users(id) on delete cascade,
  destinatario uuid not null references auth.users(id) on delete cascade,
  estado text not null default 'pendiente' check (estado in ('pendiente','aceptada')),
  creado timestamptz not null default now(),
  respondido timestamptz,
  check (solicitante <> destinatario)
);
create unique index amistades_pareja on public.amistades (least(solicitante, destinatario), greatest(solicitante, destinatario));
create index amistades_destinatario on public.amistades (destinatario);
create index amistades_solicitante on public.amistades (solicitante);
alter table public.amistades enable row level security;
create policy "ver mis amistades" on public.amistades for select to authenticated
  using ((select auth.uid()) in (solicitante, destinatario));

create function privado.son_amigos(a uuid, b uuid) returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (
    select 1 from public.amistades
    where estado = 'aceptada'
      and least(solicitante, destinatario) = least(a, b)
      and greatest(solicitante, destinatario) = greatest(a, b)
  );
$$;
revoke all on function privado.son_amigos(uuid, uuid) from public, anon, authenticated;

create function privado.yo() returns uuid
language plpgsql stable security definer set search_path to '' as $$
begin
  if auth.uid() is null or not privado.es_miembro() then
    raise exception 'Tienes que iniciar sesión';
  end if;
  return auth.uid();
end;
$$;

create function public.enviar_solicitud_amistad(p_usuario text) returns text
language plpgsql security definer set search_path to '' as $$
declare
  v_yo uuid := privado.yo();
  v_otro uuid;
  v_fila public.amistades;
begin
  select id into v_otro from public.perfiles where usuario = lower(trim(p_usuario));
  if v_otro is null then raise exception 'No existe ningún usuario con ese nombre'; end if;
  if v_otro = v_yo then raise exception 'No puedes añadirte a ti mismo'; end if;
  select * into v_fila from public.amistades
    where least(solicitante, destinatario) = least(v_yo, v_otro)
      and greatest(solicitante, destinatario) = greatest(v_yo, v_otro)
    for update;
  if not found then
    insert into public.amistades (solicitante, destinatario) values (v_yo, v_otro);
    return 'enviada';
  end if;
  if v_fila.estado = 'aceptada' then raise exception 'Ya sois amigos'; end if;
  if v_fila.solicitante = v_yo then raise exception 'Ya le has enviado una solicitud'; end if;
  -- Los dos se han pedido amistad: queda aceptada.
  update public.amistades set estado = 'aceptada', respondido = now() where id = v_fila.id;
  return 'aceptada';
end;
$$;

create function public.responder_solicitud_amistad(p_id uuid, p_aceptar boolean) returns void
language plpgsql security definer set search_path to '' as $$
declare v_yo uuid := privado.yo();
begin
  if p_aceptar then
    update public.amistades set estado = 'aceptada', respondido = now()
      where id = p_id and destinatario = v_yo and estado = 'pendiente';
  else
    delete from public.amistades where id = p_id and destinatario = v_yo and estado = 'pendiente';
  end if;
  if not found then raise exception 'Esta solicitud ya no está disponible'; end if;
end;
$$;

create function public.eliminar_amistad(p_id uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare
  v_yo uuid := privado.yo();
  v_fila public.amistades;
begin
  delete from public.amistades where id = p_id and v_yo in (solicitante, destinatario) returning * into v_fila;
  if not found then raise exception 'Esta amistad ya no existe'; end if;
end;
$$;

create function public.mis_amistades()
returns table (id uuid, otro uuid, usuario text, estado text, soy_solicitante boolean, creado timestamptz)
language plpgsql stable security definer set search_path to '' as $$
declare v_yo uuid := privado.yo();
begin
  return query
    select a.id, p.id, p.usuario, a.estado, a.solicitante = v_yo, a.creado
    from public.amistades a
    join public.perfiles p on p.id = case when a.solicitante = v_yo then a.destinatario else a.solicitante end
    where v_yo in (a.solicitante, a.destinatario)
    order by p.usuario;
end;
$$;

create function public.coleccion_amigo(p_amigo uuid)
returns table (card_id text, set_id text, variante text, cantidad integer)
language plpgsql stable security definer set search_path to '' as $$
declare v_yo uuid := privado.yo();
begin
  if not privado.son_amigos(v_yo, p_amigo) then raise exception 'Solo puedes ver la colección de tus amigos'; end if;
  return query
    select c.card_id, c.set_id, c.variante, c.cantidad
    from public.cartas c where c.user_id = p_amigo and c.cantidad > 0;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'enviar_solicitud_amistad(text)','responder_solicitud_amistad(uuid,boolean)','eliminar_amistad(uuid)',
    'mis_amistades()','coleccion_amigo(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function privado.yo() from public, anon;
grant execute on function privado.yo() to authenticated;
grant usage on schema privado to authenticated;

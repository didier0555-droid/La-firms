-- ============================================================
-- LA FIRMS · AJUSTES PARA TRABAJAR CON EL ESQUEMA DE 7 TABLAS
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Es seguro repetirlo. No borra datos.
-- ============================================================

-- 1) Columnas que faltan para no perder funciones del sitio ---------------
--    citas.notas       <- "Cuéntanos tu idea" del formulario de reserva.
--    finance.categoria <- campo "Categoría" del formulario de finanzas.
alter table public.citas add column if not exists notas text not null default '';
alter table public.finance_transactions add column if not exists categoria text not null default '';

-- 2) Datos iniciales: servicios y barberos --------------------------------
--    Sin esto, ninguna reserva puede quedar guardada (citas necesita
--    servicio_id y barbero_id reales).
insert into public.servicios (nombre, precio, activo)
select v.nombre, v.precio, true
from (values
  ('Corte básico', 15000),
  ('Corte + barba', 20000),
  ('Corte, diseño y textura', 25000)
) as v(nombre, precio)
where not exists (select 1 from public.servicios s where s.nombre = v.nombre);

insert into public.barberos (nombre, especialidad, activo)
select 'Camilo Gil', 'Experto en cortes con diseño', true
where not exists (select 1 from public.barberos b where b.nombre = 'Camilo Gil');

-- 3) Función segura para que un visitante reserve sin ver datos privados ---
--    Crea el cliente y la cita en una sola operación. Corre con permisos
--    del dueño (security definer), así NO hay que abrir la tabla clientes
--    al público. El sitio la llama con: db.rpc('crear_cita', {...})
--    Los IDs de tus tablas son uuid, por eso se declaran con %type.
drop function if exists public.crear_cita(text, text, date, text, text, text);
create or replace function public.crear_cita(
  p_nombre text,
  p_telefono text,
  p_fecha date,
  p_hora text,
  p_servicio text,
  p_notas text default ''
) returns public.citas.id%type
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cliente_id public.clientes.id%type;
  v_servicio_id public.servicios.id%type;
  v_barbero_id public.barberos.id%type;
  v_cita_id public.citas.id%type;
begin
  insert into public.clientes (nombre, telefono)
  values (p_nombre, p_telefono)
  returning id into v_cliente_id;

  select id into v_servicio_id from public.servicios where nombre = p_servicio limit 1;

  select id into v_barbero_id from public.barberos where activo = true order by id limit 1;

  insert into public.citas (fecha, hora, estado, notas, cliente_id, servicio_id, barbero_id)
  values (p_fecha, p_hora, 'pendiente', coalesce(p_notas, ''), v_cliente_id, v_servicio_id, v_barbero_id)
  returning id into v_cita_id;

  return v_cita_id;
end;
$$;

grant execute on function public.crear_cita(text, text, date, text, text, text) to anon, authenticated;

-- 4) Permisos de lectura para el panel de administración -------------------
--    El panel (usuario autenticado) necesita leer los catálogos para
--    mostrar el nombre del cliente, servicio y barbero de cada cita.
drop policy if exists "clientes_select_admin" on public.clientes;
create policy "clientes_select_admin" on public.clientes
  for select to authenticated using (true);

drop policy if exists "servicios_select_admin" on public.servicios;
create policy "servicios_select_admin" on public.servicios
  for select to authenticated using (true);

drop policy if exists "barberos_select_admin" on public.barberos;
create policy "barberos_select_admin" on public.barberos
  for select to authenticated using (true);

-- 5) Comprobación: cuántas filas quedaron --------------------------------
select 'servicios' as tabla, count(*) as filas from public.servicios
union all select 'barberos', count(*) from public.barberos
union all select 'clientes', count(*) from public.clientes
union all select 'citas', count(*) from public.citas;

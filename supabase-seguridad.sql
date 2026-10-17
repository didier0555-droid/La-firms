-- =====================================================================
--  SEGURIDAD: cerrar el acceso público (anónimo) a la tabla `citas`.
--
--  Qué hace:
--    1) Borra TODAS las políticas actuales de `citas` (incluidas las que
--       dejan entrar al rol anónimo o al público).
--    2) Activa Row Level Security por si estuviera desactivado.
--    3) Crea solo las políticas del panel (usuarios autenticados / admin).
--
--  Tras ejecutarlo, el público ya NO podrá leer ni crear citas directamente.
--  La reserva del sitio seguirá funcionando porque entra por la función
--  `crear_cita` (security definer), que no depende de estos permisos.
--
--  Ejecútalo en el SQL Editor de Supabase. Es seguro repetirlo.
-- =====================================================================

-- 1) Elimina cualquier política existente sobre `citas`
do $$
declare p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'citas'
  loop
    execute format('drop policy %I on public.citas', p.policyname);
  end loop;
end $$;

-- 2) Asegura que RLS esté activo
alter table public.citas enable row level security;

-- 3) Políticas solo para el panel (autenticados)
create policy citas_select_admin on public.citas
  for select to authenticated using (true);

create policy citas_update_admin on public.citas
  for update to authenticated using (true) with check (true);

create policy citas_insert_admin on public.citas
  for insert to authenticated with check (true);

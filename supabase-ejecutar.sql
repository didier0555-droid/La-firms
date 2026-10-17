-- =====================================================================
--  EJECUTAR EN EL SQL EDITOR DE SUPABASE  (todo en uno)
--    1) Borra los datos de prueba
--    2) Cierra el acceso público a la tabla `citas`
--  Es seguro repetirlo.
-- =====================================================================

-- ---------- 1) LIMPIEZA DE DATOS DE PRUEBA ----------

delete from public.citas
where id in (
        'a7b7d81e-7445-4f16-8668-1cdbe74a3310',
        '0d76227a-b1aa-49d1-87bc-fb3fdf81fde5'
      )
   or notas ilike '%prueba%';

delete from public.service_reviews
where id = 'db732d3f-7a1d-463f-bd12-0a50ba0d7867'
   or cliente_nombre in ('Cliente de Prueba', 'Prueba', 'Prueba Tecnica');

delete from public.clientes
where telefono in ('0000000000', '3100000000', '3111111111');

-- ---------- 2) SEGURIDAD DE `citas` ----------

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

alter table public.citas enable row level security;

create policy citas_select_admin on public.citas
  for select to authenticated using (true);

create policy citas_update_admin on public.citas
  for update to authenticated using (true) with check (true);

create policy citas_insert_admin on public.citas
  for insert to authenticated with check (true);

-- ---------- 3) RESULTADO ----------

select 'citas' as tabla, count(*) as quedan from public.citas
union all select 'service_reviews', count(*) from public.service_reviews
union all select 'clientes', count(*) from public.clientes;

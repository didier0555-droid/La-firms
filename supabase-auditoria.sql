-- =====================================================================
--  AUDITORIA DE SEGURIDAD (SOLO LECTURA) -- no modifica nada.
--  Ejecuta en el SQL Editor de Supabase y revisa los resultados.
-- =====================================================================

-- 1) ¿Esta activado Row Level Security en cada tabla?
--    rls_activo DEBE ser "SI" en todas.
select c.relname as tabla,
       case when c.relrowsecurity then 'SI' else 'NO  <-- PELIGRO' end as rls_activo,
       case when c.relforcerowsecurity then 'SI' else 'no' end as rls_forzado
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- 2) Todas las politicas: quien puede leer / crear / editar / borrar.
--    En "roles" veras {anon} = visitante sin login, {authenticated} = con login,
--    {public} = ambos (equivale a "todo el mundo").
select tablename  as tabla,
       policyname as politica,
       cmd        as operacion,          -- SELECT / INSERT / UPDATE / DELETE / ALL
       roles      as roles,
       coalesce(qual, '-')       as condicion_using,
       coalesce(with_check, '-') as condicion_check
from pg_policies
where schemaname = 'public'
order by tablename, cmd;

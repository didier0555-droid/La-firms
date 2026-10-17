-- =====================================================================
--  LIMPIEZA de los datos de prueba creados al verificar la conexión.
--  Ejecútalo en el SQL Editor de Supabase. Es seguro repetirlo.
-- =====================================================================

-- 1) Citas de prueba (creadas por las pruebas de la función crear_cita)
delete from public.citas
where id in (
        'a7b7d81e-7445-4f16-8668-1cdbe74a3310',
        '0d76227a-b1aa-49d1-87bc-fb3fdf81fde5'
      )
   or notas ilike '%prueba%';

-- 2) Reseñas de prueba
delete from public.service_reviews
where id = 'db732d3f-7a1d-463f-bd12-0a50ba0d7867'
   or cliente_nombre in ('Cliente de Prueba', 'Prueba', 'Prueba Tecnica');

-- 3) Clientes de prueba
delete from public.clientes
where telefono in ('0000000000', '3100000000', '3111111111');

-- 4) Comprobación: cuántas filas quedan
select 'citas' as tabla, count(*) as quedan from public.citas
union all select 'service_reviews', count(*) from public.service_reviews
union all select 'clientes', count(*) from public.clientes;

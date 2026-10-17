-- ============================================================
-- LA FIRMS · Migración a Supabase (PostgreSQL)
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query -> Run
-- ============================================================

-- 1) TABLA: citas -----------------------------------------------------------
-- Reservas que los clientes crean desde index.html.
-- Solo el panel de administración (tu usuario) puede leerlas.
create table if not exists public.citas (
  id bigint generated always as identity primary key,
  nombre text not null check (char_length(nombre) between 1 and 100),
  telefono text not null check (char_length(telefono) between 1 and 40),
  direccion text not null default '',
  correo text not null default '',
  mensaje text not null default '' check (char_length(mensaje) <= 1000),
  appointment_date date,
  appointment_time text check (
    appointment_time is null or appointment_time ~ '^([01][0-9]|2[0-3]):(00|30)$'
  ),
  service text check (
    service is null
    or service in ('Corte básico', 'Corte + barba', 'Corte, diseño y textura')
  ),
  status text not null default 'pendiente' check (
    status in ('pendiente', 'confirmada', 'atendida', 'cancelada')
  ),
  created_at timestamptz not null default now()
);

-- Índice para el filtro por mes del panel de citas
create index if not exists idx_citas_fecha on public.citas (appointment_date);

-- 2) TABLA: service_reviews ------------------------------------------------
-- Opiniones públicas con estrellas (se muestran en index.html).
create table if not exists public.service_reviews (
  id bigint generated always as identity primary key,
  name text not null default '' check (char_length(name) <= 40),
  rating integer not null check (rating between 1 and 5),
  comment text not null check (char_length(comment) between 1 and 600),
  created_at timestamptz not null default now()
);

-- 3) TABLA: finance_transactions -------------------------------------------
-- Ingresos y gastos del negocio. Datos privados del administrador.
create table if not exists public.finance_transactions (
  id bigint generated always as identity primary key,
  type text not null check (type in ('ingreso', 'gasto')),
  category text not null check (char_length(category) between 1 and 60),
  description text not null check (char_length(description) between 1 and 160),
  amount_cop bigint not null check (amount_cop > 0),
  transaction_date date not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_finanzas_fecha
  on public.finance_transactions (transaction_date);

-- 4) ROW LEVEL SECURITY ----------------------------------------------------
-- Sin esto, cualquier persona con la clave anon podria leer/todo tocar.
alter table public.citas enable row level security;
alter table public.service_reviews enable row level security;
alter table public.finance_transactions enable row level security;

-- citas: cualquiera puede reservar; nadie sin sesión puede leer los datos
-- de los clientes (teléfonos, correos); solo el admin lee y cambia el estado.
create policy "citas_insert_publico" on public.citas
  for insert to anon, authenticated
  with check (true);

create policy "citas_select_admin" on public.citas
  for select to authenticated
  using (true);

create policy "citas_update_admin" on public.citas
  for update to authenticated
  using (true)
  with check (true);

-- service_reviews: las opiniones son públicas (se leen y se crean),
-- pero nadie puede editarlas ni borrarlas.
create policy "opiniones_select_publico" on public.service_reviews
  for select to anon, authenticated
  using (true);

create policy "opiniones_insert_publico" on public.service_reviews
  for insert to anon, authenticated
  with check (true);

-- finance_transactions: acceso completo unicamente para el admin.
create policy "finanzas_select_admin" on public.finance_transactions
  for select to authenticated
  using (true);

create policy "finanzas_insert_admin" on public.finance_transactions
  for insert to authenticated
  with check (true);

create policy "finanzas_update_admin" on public.finance_transactions
  for update to authenticated
  using (true)
  with check (true);

create policy "finanzas_delete_admin" on public.finance_transactions
  for delete to authenticated
  using (true);

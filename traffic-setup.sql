-- Traffic tracking: site_visits table
-- Supabase SQL Editor-e ei pura code ekbar run korun.

create table if not exists public.site_visits (
  id bigint generated always as identity primary key,
  visitor_id text not null,
  day date not null,
  path text,
  created_at timestamptz not null default now()
);

create index if not exists site_visits_day_idx on public.site_visits (day);

alter table public.site_visits enable row level security;

-- Jekono visitor (login na thakleo) visit record korte parbe
drop policy if exists "site visits insert" on public.site_visits;
create policy "site visits insert" on public.site_visits
  for insert to anon, authenticated
  with check (true);

-- Shudhu admin email dekhte parbe
drop policy if exists "site visits admin read" on public.site_visits;
create policy "site visits admin read" on public.site_visits
  for select to authenticated
  using (lower(auth.jwt() ->> 'email') = '702640shamil@admin.com');

notify pgrst, 'reload schema';

-- Visitor-er desh (country code, jemon BD, US)
alter table public.site_visits add column if not exists country text;
notify pgrst, 'reload schema';

-- Page sections: admin-defined sections (name + serial + content) shown on selected category pages
-- Supabase SQL Editor-e ekbar run korun.

create table if not exists public.page_sections (
  id bigint generated always as identity primary key,
  name text not null default '',
  serial int not null default 0,
  pages text[] not null default '{}',
  movie_ids jsonb not null default '[]'::jsonb,
  groups jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.page_sections enable row level security;

drop policy if exists "page sections read" on public.page_sections;
create policy "page sections read" on public.page_sections
  for select to anon, authenticated
  using (true);

drop policy if exists "page sections admin write" on public.page_sections;
create policy "page sections admin write" on public.page_sections
  for all to authenticated
  using (lower(auth.jwt() ->> 'email') = '702640shamil@admin.com')
  with check (lower(auth.jwt() ->> 'email') = '702640shamil@admin.com');

alter table public.page_sections add column if not exists groups jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';

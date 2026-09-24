-- Run ONCE in Supabase -> SQL Editor (safe to re-run).
-- Per-content "Tera Play" On/Off toggle. Existing content = OFF, new content = ON (set by Add Content form).
alter table public.movies
  add column if not exists "teraPlayEnabled" boolean default false;

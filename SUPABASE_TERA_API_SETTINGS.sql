-- Run ONCE in Supabase -> SQL Editor (safe to re-run / idempotent).
-- Multi-API pool for Terabox Watch: ekadhik resolver API save rakha jay.
-- Ekta-r credit/limit shesh hole (401/403/429 / quota error) proxy (api/tera.js)
-- automatic porer active API-te switch kore dey - kono code change/deploy lage na.
-- Admin -> Watch Button tab-e pura list, current active API, remaining play count dekha jay.

create extension if not exists pgcrypto;

create table if not exists public.tera_apis (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'API',
  endpoint text not null,
  api_key text not null,
  key_name text not null default 'secret',
  credit_limit integer,              -- optional; null = limit jana nei, tobu used_count count hobe
  used_count integer not null default 0,
  status text not null default 'active' check (status in ('active','exhausted','disabled')),
  priority integer not null default 0,   -- choto shonkha age try hoy
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

alter table public.tera_apis enable row level security;

-- Sobai (logged-out visitor soho) select korte parbe - noile Play button ki API use korbe seta jante parbe na.
drop policy if exists "tera_apis_select_all" on public.tera_apis;
create policy "tera_apis_select_all" on public.tera_apis for select using (true);

-- Shudhu fixed Admin email (script.js -> ADMIN_TRIGGER_EMAIL) insert/update/delete korte parbe.
drop policy if exists "tera_apis_admin_write" on public.tera_apis;
create policy "tera_apis_admin_write" on public.tera_apis
  for all
  using (lower((auth.jwt() ->> 'email')) = lower('702640Shamil@admin.com'))
  with check (lower((auth.jwt() ->> 'email')) = lower('702640Shamil@admin.com'));

-- Purono single-config (site_settings key='tera_api') thakle - migrate kore ekta row banao.
insert into public.tera_apis (name, endpoint, api_key, key_name, priority)
select 'Migrated API', value->>'endpoint', value->>'key', coalesce(value->>'keyName','secret'), 0
from public.site_settings
where key = 'tera_api'
  and not exists (select 1 from public.tera_apis)
on conflict do nothing;

-- Kichu-i na thakle (notun setup) - ekta default seed row.
insert into public.tera_apis (name, endpoint, api_key, key_name, priority, credit_limit)
select 'PlayTeraBox', 'https://api.playterabox.com/api/proxy', 'pk_cltx4au47sqf03z97t9tl', 'secret', 0, 998
where not exists (select 1 from public.tera_apis);

-- ---- RPC functions: proxy/anon shudhu ei duita function call korte pare (RLS bypass na kore) ----
-- Successful play-r por usage count barano + limit chhule automatic exhausted mark
create or replace function public.tera_api_record_use(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tera_apis
  set used_count = used_count + 1,
      last_used_at = now(),
      status = case when credit_limit is not null and used_count + 1 >= credit_limit then 'exhausted' else status end
  where id = p_id;
end;
$$;
grant execute on function public.tera_api_record_use(uuid) to anon, authenticated;

-- API 401/403/429 (credit/limit shesh) dile eta call hoy, list theke ei API-ke sorie deoya hoy
create or replace function public.tera_api_mark_exhausted(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tera_apis set status = 'exhausted' where id = p_id;
end;
$$;
grant execute on function public.tera_api_mark_exhausted(uuid) to anon, authenticated;

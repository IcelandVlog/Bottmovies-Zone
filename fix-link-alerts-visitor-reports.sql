-- ============================================================================
-- Fix: allow the report-broken-links.html form to insert into "link_alerts",
-- and make sure the admin panel can actually read/resolve those reports.
-- ============================================================================
-- Two separate issues, both fixed by this one script:
--
-- 1) The visitor-facing report form (report-broken-links.html) inserts rows
--    with source = 'visitor_report', while the background auto-check inserts
--    with source = 'auto_check'. If the "source" column has an old CHECK
--    constraint that only allowed 'auto_check', every visitor submission
--    fails ("Sorry, couldn't submit the report...").
--
-- 2) The admin panel logs in through normal Supabase Auth (just a regular
--    account whose email happens to match ADMIN_TRIGGER_EMAIL in script.js —
--    there's no special "admin" database role). If "link_alerts" has Row
--    Level Security turned on but no SELECT/UPDATE policy was ever created,
--    every query returns zero rows for EVERYONE, including the admin — so
--    the "🔔 Broken Link Reports" tab always shows "No Broken Link Alerts"
--    even when rows exist in the table.
--
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).
-- ============================================================================

alter table public.link_alerts enable row level security;

-- ---- 1) widen the "source" CHECK constraint (if one exists) ----
do $$
declare
  found_constraint text;
begin
  select con.conname into found_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'link_alerts'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%source%';

  if found_constraint is not null then
    execute format('alter table public.link_alerts drop constraint %I', found_constraint);
    raise notice 'Dropped old constraint: %', found_constraint;
  else
    raise notice 'No existing CHECK constraint on "source" found — nothing to drop.';
  end if;
end $$;

alter table public.link_alerts
  add constraint link_alerts_source_check
  check (source in ('auto_check', 'visitor_report'));

-- ---- 2) make sure everyone can INSERT (visitors report anonymously) ----
drop policy if exists "Anyone can insert a link alert" on public.link_alerts;
create policy "Anyone can insert a link alert"
  on public.link_alerts
  for insert
  to anon, authenticated
  with check (true);

-- ---- 3) make sure the alerts can actually be READ (admin panel list + badge count) ----
drop policy if exists "Anyone can read link alerts" on public.link_alerts;
create policy "Anyone can read link alerts"
  on public.link_alerts
  for select
  to anon, authenticated
  using (true);

-- ---- 4) let signed-in accounts mark an alert resolved (admin's "✓ Mark as Fixed" button) ----
drop policy if exists "Signed-in users can update link alerts" on public.link_alerts;
create policy "Signed-in users can update link alerts"
  on public.link_alerts
  for update
  to authenticated
  using (true)
  with check (true);


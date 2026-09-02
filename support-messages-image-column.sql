-- ============================================================================
-- Fix: messages sent from the floating "Messages" widget on
-- How-to-Download.html and report-broken-links.html were never being saved
-- anywhere. They only lived in the page's memory and were emailed once the
-- chat window was closed — nothing was written to the database, and an
-- attached image had no column to be stored in even if it had been saved.
-- ============================================================================
-- This script:
--   1) Adds an "image_url" column to "support_messages" so an attached image
--      (uploaded to ImgBB by the widget) can be linked to the message and
--      shown in the admin panel's ✉️ Messages tab.
--   2) Re-confirms anon INSERT is allowed (same policy as
--      fix-database-permissions.sql — safe to run even if already applied).
--
-- Run this once in the Supabase SQL editor (Project → SQL Editor → New query).
-- ============================================================================

alter table public.support_messages
  add column if not exists image_url text;

alter table public.support_messages enable row level security;

drop policy if exists "Anyone can insert a message" on public.support_messages;
create policy "Anyone can insert a message"
  on public.support_messages
  for insert
  to anon, authenticated
  with check (true);

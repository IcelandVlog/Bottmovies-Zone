-- Run this once in Supabase Dashboard -> SQL Editor -> New query -> Run
-- This adds the two columns needed for the new Homepage Hero Banner feature.

alter table movies add column if not exists featured boolean default false;
alter table movies add column if not exists featured_order integer;
alter table movies add column if not exists featured_image text;

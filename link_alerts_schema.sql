-- ============================================================
-- link_report_comments table — one-time setup for the live
-- comment thread on report-broken-links.html (visitors post a
-- broken-link report as a comment, no email required).
--
-- Run this once in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

create table if not exists public.link_report_comments (
    id           bigint generated always as identity primary key,
    parent_id    bigint references public.link_report_comments(id) on delete cascade,
    guest_name   text not null default 'Guest',
    content      text not null,
    is_admin     boolean not null default false,
    created_at   timestamptz not null default now()
);

-- Speeds up loading the top-level (non-reply) comments page by page
create index if not exists link_report_comments_top_level_idx
    on public.link_report_comments (created_at desc)
    where parent_id is null;

-- Speeds up loading replies for a batch of top-level comments
create index if not exists link_report_comments_parent_idx
    on public.link_report_comments (parent_id);

-- The page talks to Supabase using the public "anon" key from the browser
-- (same key already used elsewhere on the site), so RLS needs to allow
-- that role to insert reports/replies and read them back.
alter table public.link_report_comments enable row level security;

create policy "Anyone can post a report or reply"
    on public.link_report_comments for insert
    to anon
    with check (true);

create policy "Anyone can read report comments"
    on public.link_report_comments for select
    to anon
    using (true);

-- Lets the admin panel (which authenticates client-side, then uses the
-- same anon key) delete spam/resolved reports if you wire that up later.
create policy "Anyone can delete report comments"
    on public.link_report_comments for delete
    to anon
    using (true);

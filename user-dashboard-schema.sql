-- ====================================================================
-- USER DASHBOARD (Profile / Favorites / My Requests / Change Password)
-- একবার Supabase Dashboard > SQL Editor এ পুরো ফাইলটা Run করুন
-- ====================================================================
-- এই স্ক্রিপ্ট যা যা করে:
--   ১) profiles টেবিলে avatar_url কলাম যোগ করে (Profile Picture এর জন্য)
--   ২) requests টেবিলে user_id কলাম যোগ করে, যাতে "My Requests" ট্যাবে
--      একজন ইউজার শুধু নিজের করা request গুলোই দেখতে পায়
--   ৩) favorites টেবিল তৈরি করে (Favorites / Watchlist এর জন্য)
--
-- এরপর "Storage" সেকশনে (নিচে দেখুন) avatars নামে একটা Public bucket
-- বানাতে হবে — ঠিক posters bucket এর মতোই — Profile Picture আপলোডের জন্য।

-- ---------- ১. profiles টেবিলে avatar_url কলাম ----------
alter table public.profiles
    add column if not exists avatar_url text;

-- profiles টেবিলের public select policy আগে থেকেই আছে (username_profiles_schema.sql এ),
-- সেটা avatar_url সহ পুরো row পড়তে দেয়, তাই এখানে নতুন select policy লাগবে না।
-- update policy ("Users can update own profile") ও আগে থেকেই আছে, avatar_url আপডেট করতেও
-- সেটা কাজ করবে (কলাম-লেভেল কোনো restriction নেই)।

-- ---------- ২. requests টেবিলে user_id কলাম (কে request করেছে) ----------
alter table public.requests
    add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists requests_user_id_idx
    on public.requests (user_id);

-- লগইন করা ইউজার যাতে শুধু নিজের request গুলো ফিল্টার করে দেখতে পারে (সাধারণ SELECT পলিসি
-- আগে থেকেই "Anyone can read requests" হিসেবে আছে fix-database-permissions.sql এ,
-- সেটা user_id দিয়ে ফিল্টার করা query কেও কাজ করতে দেয়, তাই এখানে আলাদা policy লাগছে না)

-- ---------- ৩. favorites টেবিল (❤️ Favorites / Watchlist) ----------
create table if not exists public.favorites (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references auth.users(id) on delete cascade,
    movie_id     text not null,          -- movies.id কে text হিসেবে রাখা হয়েছে, id type যাই হোক না কেন
    movie_title  text,
    movie_poster text,
    movie_type   text,                   -- 'movie' বা 'tv'
    movie_year   text,
    created_at   timestamptz not null default now(),
    unique (user_id, movie_id)            -- একই মুভি একজন ইউজার দুইবার favorite করতে পারবে না
);

create index if not exists favorites_user_id_idx
    on public.favorites (user_id);

alter table public.favorites enable row level security;

-- নিজের favorites নিজে দেখতে পারবে, অন্য কারো favorites কেউ দেখতে পারবে না
drop policy if exists "Users can view own favorites" on public.favorites;
create policy "Users can view own favorites"
    on public.favorites for select
    to authenticated
    using (auth.uid() = user_id);

-- নিজের নামে favorite যোগ করতে পারবে
drop policy if exists "Users can insert own favorites" on public.favorites;
create policy "Users can insert own favorites"
    on public.favorites for insert
    to authenticated
    with check (auth.uid() = user_id);

-- নিজের favorite মুছে ফেলতে (❤️ Remove) পারবে
drop policy if exists "Users can delete own favorites" on public.favorites;
create policy "Users can delete own favorites"
    on public.favorites for delete
    to authenticated
    using (auth.uid() = user_id);

-- ====================================================================
-- STORAGE (Profile Picture আপলোডের জন্য) — এই অংশটা SQL Editor এ চলবে না,
-- ম্যানুয়ালি করতে হবে (posters bucket যেভাবে বানানো হয়েছিল ঠিক সেভাবেই):
--
--   Supabase Dashboard → Storage → New Bucket
--     Name: avatars
--     Public bucket: ✅ ON
--
--   এরপর Storage → avatars → Policies এ গিয়ে নিচের ৩টা policy যোগ করুন
--   (অথবা Storage → Policies পেজ থেকে "New Policy" → এই SQL গুলো paste করুন):
-- ====================================================================

-- লগইন করা ইউজাররা avatars bucket এ ছবি আপলোড করতে পারবে
drop policy if exists "Authenticated users can upload avatars" on storage.objects;
create policy "Authenticated users can upload avatars"
    on storage.objects for insert
    to authenticated
    with check (bucket_id = 'avatars');

-- সবাই (bucket public হওয়ায়) avatars দেখতে পারবে
drop policy if exists "Anyone can view avatars" on storage.objects;
create policy "Anyone can view avatars"
    on storage.objects for select
    to public
    using (bucket_id = 'avatars');

-- লগইন করা ইউজাররা পুরনো avatar আপডেট/মুছতে পারবে (নতুন ছবি আপলোড করলে)
drop policy if exists "Authenticated users can update avatars" on storage.objects;
create policy "Authenticated users can update avatars"
    on storage.objects for update
    to authenticated
    using (bucket_id = 'avatars');

drop policy if exists "Authenticated users can delete avatars" on storage.objects;
create policy "Authenticated users can delete avatars"
    on storage.objects for delete
    to authenticated
    using (bucket_id = 'avatars');

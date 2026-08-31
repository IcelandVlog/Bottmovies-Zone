-- ====================================================================
-- DOWNLOAD HISTORY (User Dashboard > Download History ট্যাব)
-- একবার Supabase Dashboard > SQL Editor এ পুরো ফাইলটা Run করুন
-- ====================================================================
-- এই স্ক্রিপ্ট download_history নামে একটা নতুন টেবিল বানায়, যেখানে লগইন করা
-- ইউজার কোনো মুভি/সিরিজের "Download ..." বাটনে ক্লিক করলে একটা রো সেভ হয়।
-- ইউজার তার নিজের Dashboard > Download History ট্যাবে পুরো লিস্ট দেখতে পারবে,
-- এবং যেকোনো এন্ট্রি নিজে চাইলে Remove করে ফেলতে পারবে (favorites/My Requests এর মতোই)।

create table if not exists public.download_history (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references auth.users(id) on delete cascade,
    movie_id     text not null,          -- movies.id কে text হিসেবে রাখা হয়েছে, id type যাই হোক না কেন
    movie_title  text,
    movie_poster text,
    movie_type   text,                   -- 'movie' বা 'tv'
    movie_year   text,
    link_label   text,                   -- কোন কোয়ালিটি/লিংক থেকে ডাউনলোড করা হয়েছে (যেমন: "720p [350MB]")
    created_at   timestamptz not null default now()
    -- ইচ্ছাকৃতভাবে কোনো unique constraint নেই — একই মুভি একাধিকবার ডাউনলোড করলে প্রতিবারই আলাদা history entry হিসেবে সেভ হবে
);

create index if not exists download_history_user_id_idx
    on public.download_history (user_id);

alter table public.download_history enable row level security;

-- নিজের download history নিজে দেখতে পারবে, অন্য কারো history কেউ দেখতে পারবে না
drop policy if exists "Users can view own download history" on public.download_history;
create policy "Users can view own download history"
    on public.download_history for select
    to authenticated
    using (auth.uid() = user_id);

-- নিজের নামে download history এন্ট্রি যোগ করতে পারবে (ডাউনলোড বাটনে ক্লিক করলে)
drop policy if exists "Users can insert own download history" on public.download_history;
create policy "Users can insert own download history"
    on public.download_history for insert
    to authenticated
    with check (auth.uid() = user_id);

-- নিজের download history থেকে যেকোনো এন্ট্রি মুছে ফেলতে (🗑 Remove) পারবে
drop policy if exists "Users can delete own download history" on public.download_history;
create policy "Users can delete own download history"
    on public.download_history for delete
    to authenticated
    using (auth.uid() = user_id);

-- ====================================================================
-- USERNAME SUPPORT (একবার Supabase Dashboard > SQL Editor এ Run করুন)
-- ====================================================================
-- এই স্ক্রিপ্ট চালানোর পর:
--   ১) প্রতিটা account এর একটা unique username থাকবে (দুইজন একই username নিতে পারবে না)
--   ২) Username দিয়েও Login করা যাবে (email দরকার নেই)
--   ৩) Header/Dashboard এ পুরো email এর বদলে শুধু username দেখানো যাবে
--
-- আগে থেকে account থাকলে (যেমন Admin account) তাদের কোনো profile row থাকবে না -
-- সেক্ষেত্রে front-end automatically email এর @ এর আগের অংশটা username হিসেবে দেখাবে।

-- ---------- ১. profiles টেবিল ----------
create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    username text not null,
    created_at timestamptz not null default now()
);

-- একই username (case-insensitive) দুইবার নেওয়া যাবে না
create unique index if not exists profiles_username_lower_idx
    on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "Public can check username availability" on public.profiles;
create policy "Public can check username availability"
    on public.profiles for select
    using (true); -- শুধু username/id দেখা যাবে, email এখানে রাখা হয়নি তাই নিরাপদ

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
    on public.profiles for update
    using (auth.uid() = id);

-- ---------- ২. নতুন account তৈরি হলে profiles এ username বসিয়ে দেওয়ার trigger ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    uname text;
begin
    uname := trim(coalesce(new.raw_user_meta_data->>'username', ''));
    if uname = '' then
        uname := split_part(new.email, '@', 1);
    end if;

    if exists (select 1 from public.profiles where lower(username) = lower(uname)) then
        raise exception 'username_taken';
    end if;

    insert into public.profiles (id, username) values (new.id, uname);
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ---------- ৩. Username দিয়ে email খুঁজে বের করার ফাংশন (Login এর জন্য) ----------
create or replace function public.get_email_for_username(uname text)
returns text
language sql
security definer
set search_path = public, auth
as $$
    select u.email
    from public.profiles p
    join auth.users u on u.id = p.id
    where lower(p.username) = lower(uname)
    limit 1;
$$;

grant execute on function public.get_email_for_username(text) to anon, authenticated;

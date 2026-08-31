-- ====================================================================
-- FULL NAME FIELD (Profile > Name — Registration এর সময় সেট হয়)
-- একবার Supabase Dashboard > SQL Editor এ পুরো ফাইলটা Run করুন
-- ====================================================================
-- এই স্ক্রিপ্ট যা যা করে:
--   ১) profiles টেবিলে full_name কলাম যোগ করে
--   ২) নতুন account তৈরি হওয়ার trigger (handle_new_user) আপডেট করে, যাতে
--      Registration ফর্মের "Full Name" ফিল্ডটা signup এর সময়েই profiles.full_name এ সেভ হয়ে যায়
--
-- এটা Run করার পর থেকে নতুন যারা Register করবে তাদের Full Name সেভ হবে।
-- এর আগে থেকে যাদের account আছে, তাদের full_name খালি (NULL) থাকবে — Profile ট্যাবে
-- সেক্ষেত্রে "—" দেখানো হবে, এটা normal, কিছু ভাঙবে না।

-- ---------- ১. profiles টেবিলে full_name কলাম ----------
alter table public.profiles
    add column if not exists full_name text;

-- ---------- ২. handle_new_user() ফাংশন আপডেট (username এর পাশাপাশি full_name ও সেভ করবে) ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    uname text;
    fname text;
begin
    uname := trim(coalesce(new.raw_user_meta_data->>'username', ''));
    if uname = '' then
        uname := split_part(new.email, '@', 1);
    end if;

    fname := trim(coalesce(new.raw_user_meta_data->>'full_name', ''));

    if exists (select 1 from public.profiles where lower(username) = lower(uname)) then
        raise exception 'username_taken';
    end if;

    insert into public.profiles (id, username, full_name)
    values (new.id, uname, nullif(fname, ''));
    return new;
end;
$$;

-- trigger আগে থেকেই on_auth_user_created নামে আছে, ফাংশন replace করলেই আপডেটেড লজিক কার্যকর হয়ে যাবে,
-- আলাদা করে trigger আবার বানানোর দরকার নেই।

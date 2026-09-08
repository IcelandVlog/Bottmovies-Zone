-- এই ফাংশনটা Supabase Dashboard -> SQL Editor এ গিয়ে Run করুন (একবারই যথেষ্ট)
-- এটা চেক করে দেয় দেওয়া email দিয়ে আসলেই কোনো account (auth.users এ) আছে কিনা

create or replace function public.check_email_exists(check_email text)
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users
    where lower(email) = lower(check_email)
  );
$$;

-- anon (লগইন না করা ভিজিটর) এবং authenticated (লগইন করা ইউজার) — দুই পক্ষকেই
-- এই ফাংশনটা কল করার permission দেওয়া হচ্ছে, কারণ Forgot Password ফর্মটা
-- লগইন করার আগেই ব্যবহার হয়
grant execute on function public.check_email_exists(text) to anon, authenticated;

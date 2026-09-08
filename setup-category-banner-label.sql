-- Ei SQL ta ekbar Supabase Dashboard -> SQL Editor e run korte hobe, tarpor
-- Admin Panel -> Navigation tab theke protita category-r jonno custom
-- "banner text" add/edit/update kora jabe (category page-e gele upore
-- notice banner-e ei lekha ta dekhabe).
--
-- Ei column already thakle ei script safe-e re-run kora jay, kono error dibe na.

alter table public.categories
    add column if not exists banner_label text;

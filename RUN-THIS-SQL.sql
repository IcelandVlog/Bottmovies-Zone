-- Run ONCE in Supabase -> SQL Editor.
-- Adds the "Default server" setting for the Watch Button (1 = Server 01, 2 = Server 02).
alter table public.movies add column if not exists "watchServer" smallint;

-- optional: ask the API to pick up the new column immediately
notify pgrst, 'reload schema';

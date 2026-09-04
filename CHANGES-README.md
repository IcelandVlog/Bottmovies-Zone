# Homepage Hero Banner — What Was Added

## 1) Database (do this first)
Run `SUPABASE_SETUP.sql` in your Supabase project's SQL Editor. It adds two
new columns to the `movies` table:
- `featured` (boolean) — true if admin manually added this item to the home banner
- `featured_order` (integer) — controls the slide order

## 2) Files changed
- `index.html` — added the `<section id="heroBanner">` markup (right below the
  header, above the movie grid) and a new "🎬 Homepage Banner" tab inside the
  Admin Panel sidebar.
- `script.js` — added all hero banner logic (see the block titled
  `HOME HERO BANNER FUNCTIONS`) and the admin tab logic (see
  `Homepage Banner tab` section near the Recycle Bin code).
- `style.css` — added `.hero-banner...` styles (desktop + mobile responsive)
  and `.admin-banner-...` styles for the new admin tab, at the very end of the file.

## 3) How it behaves
- **Home page only**: the banner is only visible when you're on Home (category
  `all`). Switching to any other category/page hides it immediately and stops
  its autoplay timer (no wasted background requests).
- **Admin control**: Admin Panel → 🎬 Homepage Banner. Search content on the
  right, click "+ Add" to push it into the left "Currently in Banner" list,
  reorder with ↑ / ↓, remove with ✖, then click "💾 Save Banner".
- **Auto fallback**: If admin hasn't added anything, the homepage automatically
  shows the top 5–7 most-viewed (Trending) titles instead — no empty banner.
- **Separate TMDB poster**: Each slide's background image is fetched
  independently from TMDB (the widescreen "backdrop", not the portrait poster
  used in the movie grid) via a dedicated `fetchHeroBackdrop()` function with
  its own cache — exactly as requested, kept separate from the normal poster logic.
- **Responsive**: on small screens the banner switches to a taller portrait-ish
  layout, hides the arrow buttons (swipe left/right still works), and the
  "Watch Now" button becomes full-width.

## 4) Deploy
Just replace your existing `index.html`, `script.js`, and `style.css` with the
ones in this zip (everything else is untouched), push to your repo, and run
the SQL once. No other setup needed — it reuses your existing Supabase
project, TMDB key, and admin login already in `script.js`.

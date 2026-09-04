# Homepage Hero Banner — What Was Added

## 1) Database (do this first)
Run `SUPABASE_SETUP.sql` in your Supabase project's SQL Editor. It adds three
new columns to the `movies` table:
- `featured` (boolean) — true if admin manually added this item to the home banner
- `featured_order` (integer) — controls the slide order (lower number = shown first)
- `featured_image` (text) — optional custom banner image URL; leave blank to
  auto-load a widescreen backdrop from TMDB instead

## 2) Files changed
- `index.html` — the `<section id="heroBanner">` markup on the homepage (above
  the movie grid), plus a new "🎞️ Hero Banner" tab inside the Admin Panel sidebar.
- `script.js` — hero banner rendering/autoplay logic (see the block titled
  `HOME HERO BANNER FUNCTIONS`) and the admin tab logic (see
  `Hero Banner tab` section near the Recycle Bin code: `renderAdminBannerList` /
  `saveBannerSettings`).
- `style.css` — `.hero-banner...` styles (desktop + mobile responsive) and
  `.admin-banner-...` styles for the new admin tab.

## 3) How it behaves
- **Home page only**: the banner is only visible when you're on Home (category
  `all`). Switching to any other category/page hides it immediately and stops
  its autoplay timer (no wasted background requests).
- **Admin control**: Admin Panel → 🎞️ Hero Banner. Each title in the list has:
  - a "Show in Banner" checkbox (this is `featured`)
  - an Order number box (this is `featured_order`, lower = earlier in the slider)
  - an optional Custom Image URL box (this is `featured_image`)
  Change what you need, click **Save** on that row — it updates Supabase and
  the homepage banner refreshes immediately (no page reload needed).
- **Auto fallback**: If nothing is marked "Show in Banner" yet, the homepage
  automatically shows the 6 most recently added titles instead — the banner
  is never empty.
- **Separate TMDB poster**: Each slide's background image is fetched
  independently from TMDB (the widescreen "backdrop", not the portrait poster
  used in the movie grid) via a dedicated `fetchHeroBackdrop()` function with
  its own cache. If a `featured_image` URL is set for a title, that's used
  instead and the TMDB fetch is skipped for that slide.
- **Responsive**: on small screens the banner switches to a taller portrait-ish
  layout and hides the arrow buttons (swipe left/right still works).

## 4) Deploy
Replace your existing `index.html`, `script.js`, `style.css`, and
`SUPABASE_SETUP.sql` with the ones in this zip, push to your repo, and run the
SQL once (safe to re-run — it uses `if not exists`). No other setup needed —
it reuses your existing Supabase project, TMDB key, and admin login already
in `script.js`.

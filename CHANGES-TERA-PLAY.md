# Terabox Play (API) — setup

1. Run `SUPABASE_TERA_PLAY.sql` in Supabase SQL Editor (adds `teraPlayEnabled`).
   Do this BEFORE deploying — the Add Content form now saves this column.
2. `script.js` -> `TERA_API_CONFIG` is already set for PlayTeraBox (`https://api.playterabox.com/api/proxy`, header `secret`, param `url`) and `TERA_API_KEY` holds the key.
   If GET fails (CORS/4xx) it automatically retries once with POST + JSON body. If nothing plays, open DevTools -> Console and check the `[Tera Play]` raw response log.
3. Admin -> Watch Button tab: each content has a "📦 Tera Play: On/Off" pill (auto-saves).
   New content added via Add Content = ON by default.
4. Frontend: Terabox links in the Download list get a "▶ Play" button (only when Tera Play is ON).
   Click -> API resolves stream URL -> inline player (HLS supported) + "Direct Download" button.

## Server-side proxy (CORS fix)
- `api/tera.js` = Vercel function, `functions/api/tera.js` = Cloudflare Pages function. Host-er jonno jeta lage sheta-i kaj korbe.
- Frontend age `/api/tera?url=...` try kore, na hole direct API. Panel-e error-er reason dekhay (`TERA_API_CONFIG.debug`); thik hole `false` koro.
- Optional: hosting dashboard-e env var `TERA_API_KEY` set koro.

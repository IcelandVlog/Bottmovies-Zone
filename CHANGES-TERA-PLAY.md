# Terabox Play (API) — setup

1. Run `SUPABASE_TERA_PLAY.sql` in Supabase SQL Editor (adds `teraPlayEnabled`).
   Do this BEFORE deploying — the Add Content form now saves this column.
2. In `script.js`, fill `TERA_API_CONFIG.endpoint` (+ linkParam / keyMode / keyName per your API docs).
   API key is already in `TERA_API_KEY`. While `endpoint` is empty the Play button stays hidden.
3. Admin -> Watch Button tab: each content has a "📦 Tera Play: On/Off" pill (auto-saves).
   New content added via Add Content = ON by default.
4. Frontend: Terabox links in the Download list get a "▶ Play" button (only when Tera Play is ON).
   Click -> API resolves stream URL -> inline player (HLS supported) + "Direct Download" button.

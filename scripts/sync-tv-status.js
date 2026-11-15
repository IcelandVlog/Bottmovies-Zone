#!/usr/bin/env node
/*
 * Proti din TMDB theke series-er ongoing tathya check kore Supabase-er "tvStatus" column-e save kore.
 * Device-er browser ar TMDB-te jaay na - sheshe ei DB-r tathya-i dekhano hoy.
 *
 * Use:  node scripts/sync-tv-status.js
 * Node 18+ (fetch built-in). Kono npm package lagbe na.
 * TMDB key ar Supabase URL/key script.js theke neya hoy (ei duita-i already public frontend-e ache).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const pick = (re) => { const m = src.match(re); return m ? m[1] : null; };
const TMDB_KEY = pick(/TMDB_API_KEY\s*=\s*["']([^"']+)["']/);
const TMDB_BASE = pick(/TMDB_BASE_URL\s*=\s*["']([^"']+)["']/) || 'https://api.themoviedb.org/3';
const SB_URL = pick(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
const SB_KEY = pick(/SUPABASE_KEY\s*=\s*["']([^"']+)["']/);
if (!TMDB_KEY || !SB_URL || !SB_KEY) throw new Error('script.js theke TMDB/Supabase config paoa jay ni');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const todayYMD = () => new Date().toISOString().slice(0, 10);
const sbHeaders = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };

async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
}

async function seasonInfo(tmdbId, season) {
    const data = await getJson(`${TMDB_BASE}/tv/${tmdbId}/season/${season}?api_key=${TMDB_KEY}`);
    if (!data) return null;
    const dates = (data.episodes || []).map(e => e.air_date).filter(Boolean).sort();
    if (!dates.length) return null;
    const today = todayYMD();
    const released = dates.filter(d => d <= today);
    return { released: released.length, finalAired: dates[dates.length - 1] };
}

async function buildStatus(tmdbId) {
    const detail = await getJson(`${TMDB_BASE}/tv/${tmdbId}?api_key=${TMDB_KEY}`);
    if (!detail) return null;
    const last = detail.last_episode_to_air || {};
    const next = detail.next_episode_to_air || {};
    const status = {
        day: todayYMD(),
        lastAir: last.air_date || null,
        lastSeason: last.season_number || null,
        nextAir: next.air_date || null,
        nextSeason: next.season_number || null,
        seasonFinal: null,
        seasonReleased: 0,
        tmdbStatus: detail.status || null
    };
    if (status.lastSeason) {
        const info = await seasonInfo(tmdbId, status.lastSeason).catch(() => null);
        if (info) {
            status.seasonFinal = info.finalAired;
            status.seasonReleased = info.released;
        }
    }
    return status;
}

(async () => {
    const rowsRes = await fetch(`${SB_URL}/rest/v1/movies?select=id,tmdbId,tmdbType,deleted_at&tmdbType=eq.tv`, { headers: sbHeaders });
    if (!rowsRes.ok) throw new Error('Supabase read failed: ' + rowsRes.status);
    const rows = (await rowsRes.json()).filter(r => r.tmdbId && !r.deleted_at);
    console.log('TV series to check:', rows.length);

    let ok = 0, failed = 0;
    const CONCURRENCY = 5;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
        await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (r) => {
            try {
                const status = await buildStatus(r.tmdbId);
                if (!status) { failed++; return; }
                const patch = await fetch(`${SB_URL}/rest/v1/movies?id=eq.${r.id}`, {
                    method: 'PATCH',
                    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                    body: JSON.stringify({ tvStatus: status })
                });
                if (patch.ok) ok++; else failed++;
            } catch (e) { failed++; }
        }));
        await sleep(150);
    }
    console.log(`Done. saved: ${ok}, failed: ${failed}`);
})().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});

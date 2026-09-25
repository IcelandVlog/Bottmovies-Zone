// Cloudflare Pages Function:  GET /api/tera?url=<terabox link>
// Multi-API pool: Supabase table "tera_apis" theke active API-r list (priority order-e) pore,
// ekta fail (401/403/429) korle exhausted mark kore porer ta try kore. Success hole used_count barano hoy.
const FALLBACK_ENDPOINT = 'https://api.playterabox.com/api/proxy';
const FALLBACK_KEY = 'pk_cltx4au47sqf03z97t9tl';
const SUPABASE_URL = 'https://borglnmrvjafodkqhhhv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Q3WcdMEHLJO7SkO3Sd7BDQ_Ohu8xAp9';
const TERA_RE = /(terabox|1024tera|teraboxapp|terafileshare|teraboxlink|4funbox|mirrobox|teraboxshare|momerybox|tibibox|nephobox|freeterabox)/i;
const json = (obj, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

let poolCache = null;
const POOL_TTL_MS = 15 * 1000;

function supabaseRpc(fn, params) {
  return fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params)
  }).catch((e) => console.warn('[Tera Play] rpc ' + fn + ' fail:', e));
}

async function getActiveApiPool(force) {
  if (!force && poolCache && Date.now() - poolCache.ts < POOL_TTL_MS) return poolCache.list;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/tera_apis?status=eq.active&select=id,endpoint,api_key,key_name,name&order=priority.asc,created_at.asc', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Accept: 'application/json' }
    });
    if (r.ok) {
      const list = await r.json();
      poolCache = { ts: Date.now(), list };
      return list;
    }
  } catch (e) { /* fallback nichey */ }
  return poolCache ? poolCache.list : [{ id: null, endpoint: FALLBACK_ENDPOINT, api_key: FALLBACK_KEY, key_name: 'secret', name: 'Fallback' }];
}

export async function onRequestGet({ request }) {
  const link = new URL(request.url).searchParams.get('url') || '';
  if (!link || !TERA_RE.test(link)) return json({ error: 'valid terabox url lagbe' }, 400);

  const pool = await getActiveApiPool(false);
  if (!pool.length) return json({ error: 'Kono active Terabox API nei. Admin -> Watch Button tab theke ekta API add/reactivate korun.' }, 502);

  const log = [];
  for (const api of pool) {
    const url = api.endpoint + '?' + (api.key_name || 'secret') + '=' + encodeURIComponent(api.api_key) + '&url=' + encodeURIComponent(link);
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const text = await r.text();
      if (r.ok) {
        if (api.id) supabaseRpc('tera_api_record_use', { p_id: api.id });
        return json(text, 200);
      }
      log.push(`${api.name}: HTTP ${r.status} ${text.slice(0, 120)}`);
      if ([401, 403, 429].includes(r.status)) {
        if (api.id) { await supabaseRpc('tera_api_mark_exhausted', { p_id: api.id }); poolCache = null; }
        continue;
      }
    } catch (e) {
      log.push(`${api.name}: ${String((e && e.message) || e)}`);
    }
  }
  return json({ error: 'Pool-er sob API try kora hoyeche, kono ta-i success dey ni.', tried: log }, 502);
}

// Vercel Serverless Function:  GET /api/tera?url=<terabox link>
// Multi-API pool: Supabase table "tera_apis"-e ekadhik API save thake (priority order-e).
// Ekta try kore fail (401/403/429) korle -> oi API-ke "exhausted" mark kore Supabase-e save kore,
// tarpor porer active API try kore. Success hole "used_count" barano hoy (RPC: tera_api_record_use).
// Admin -> Watch Button tab theke API add/edit/delete/reorder kora jay - kono deploy lagbe na.
const https = require('https');

const FALLBACK_ENDPOINT = 'https://api.playterabox.com/api/proxy';
const FALLBACK_KEY = 'pk_cltx4au47sqf03z97t9tl';
const SUPABASE_URL = 'https://borglnmrvjafodkqhhhv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Q3WcdMEHLJO7SkO3Sd7BDQ_Ohu8xAp9'; // publishable/anon key - script.js-eo eki key public
const TERA_RE = /(terabox|1024tera|teraboxapp|terafileshare|teraboxlink|4funbox|mirrobox|teraboxshare|momerybox|tibibox|nephobox|freeterabox)/i;

let poolCache = null; // { ts, list }
const POOL_TTL_MS = 15 * 1000; // choto TTL - ekta exhausted hole porer request druto notun list dekhbe

function rawRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body ? Buffer.from(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers: h, timeout: 25000 }, (r) => {
      let buf = '';
      r.on('data', (c) => (buf += c));
      r.on('end', () => resolve({ status: r.statusCode, text: buf }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function supabaseRpc(fn, params) {
  const body = JSON.stringify(params);
  return rawRequest('POST', SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Accept: 'application/json'
  }, body).catch((e) => { console.warn('[Tera Play] rpc ' + fn + ' fail:', e); });
}

async function getActiveApiPool(force) {
  if (!force && poolCache && Date.now() - poolCache.ts < POOL_TTL_MS) return poolCache.list;
  try {
    const r = await rawRequest('GET', SUPABASE_URL + '/rest/v1/tera_apis?status=eq.active&select=id,endpoint,api_key,key_name,name&order=priority.asc,created_at.asc', {
      apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Accept: 'application/json'
    });
    if (r.status === 200) {
      const list = JSON.parse(r.text) || [];
      poolCache = { ts: Date.now(), list };
      return list;
    }
  } catch (e) { /* fallback nichey */ }
  // Supabase-e table na thakle / unreachable hole - hardcoded ekta API diye chalu rakho
  return poolCache ? poolCache.list : [{ id: null, endpoint: FALLBACK_ENDPOINT, api_key: FALLBACK_KEY, key_name: 'secret', name: 'Fallback' }];
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-tera-proxy', '1');
  const link = (req.query && req.query.url) || (req.body && req.body.url) || '';
  if (!link || !TERA_RE.test(String(link))) return res.status(400).json({ error: 'valid terabox url lagbe' });

  let pool = await getActiveApiPool(false);
  if (!pool.length) return res.status(502).json({ error: 'Kono active Terabox API nei. Admin -> Watch Button tab theke ekta API add/reactivate korun.' });

  const log = [];
  for (let i = 0; i < pool.length; i++) {
    const api = pool[i];
    const url = api.endpoint + '?' + (api.key_name || 'secret') + '=' + encodeURIComponent(api.api_key) + '&url=' + encodeURIComponent(link);
    try {
      const r = await rawRequest('GET', url, { Accept: 'application/json' });
      if (r.status >= 200 && r.status < 300) {
        if (api.id) supabaseRpc('tera_api_record_use', { p_id: api.id }); // fire-and-forget
        return res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8').send(r.text);
      }
      log.push(`${api.name}: HTTP ${r.status} ${r.text.slice(0, 120).replace(/\s+/g, ' ')}`);
      if ([401, 403, 429].includes(r.status)) {
        if (api.id) { await supabaseRpc('tera_api_mark_exhausted', { p_id: api.id }); poolCache = null; }
        continue; // porer API try koro
      }
      // onno error (400/404/500 ইত্যাদি) - ei API-r nijer shomossha na-o hote pare, tobu porer ta-o try kore dekhi
    } catch (e) {
      log.push(`${api.name}: ${String((e && e.message) || e)}`);
    }
  }
  res.status(502).json({ error: 'Pool-er sob API try kora hoyeche, kono ta-i success dey ni.', tried: log });
};

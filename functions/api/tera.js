// Cloudflare Pages Function:  GET /api/tera?url=<terabox link>
const API = 'https://api.playterabox.com/api/proxy';
const FALLBACK_KEY = 'pk_cltx4au47sqf03z97t9tl';
const TERA_RE = /(terabox|1024tera|teraboxapp|terafileshare|teraboxlink|4funbox|mirrobox|teraboxshare|momerybox|tibibox|nephobox|freeterabox)/i;
const json = (obj, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function onRequestGet({ request, env }) {
  const link = new URL(request.url).searchParams.get('url') || '';
  if (!link || !TERA_RE.test(link)) return json({ error: 'valid terabox url lagbe' }, 400);
  const key = (env && env.TERA_API_KEY) || FALLBACK_KEY;
  const log = [];
  for (const name of ['secret', 'key']) {
    try {
      const r = await fetch(API + '?url=' + encodeURIComponent(link) + '&' + name + '=' + encodeURIComponent(key), { headers: { Accept: 'application/json' } });
      const text = await r.text();
      if (r.ok) return json(text, 200);
      log.push('GET ?url&' + name + ' -> ' + r.status + ' ' + text.slice(0, 120));
      if ([401, 403, 429].includes(r.status)) break;
    } catch (e) { log.push('GET ?url&' + name + ' -> ' + String((e && e.message) || e)); }
  }
  return json({ error: 'upstream API success dey ni', tried: log }, 502);
}

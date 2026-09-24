// Cloudflare Pages Function:  GET /api/tera?url=<terabox link>
// (Cloudflare Pages-e host korle eta kaj korbe. Pages -> Settings -> Variables-e TERA_API_KEY set korte paro.)
const API = 'https://api.playterabox.com/api/proxy';
const FALLBACK_KEY = 'pk_cltx4au47sqf03z97t9tl';
const TERA_RE = /(terabox|1024tera|teraboxapp|terafileshare|teraboxlink|4funbox|mirrobox|teraboxshare|momerybox|tibibox|nephobox|freeterabox)/i;
const json = (obj, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function onRequestGet({ request, env }) {
  const link = new URL(request.url).searchParams.get('url') || '';
  if (!link || !TERA_RE.test(link)) return json({ error: 'valid terabox url lagbe' }, 400);
  const headers = { secret: (env && env.TERA_API_KEY) || FALLBACK_KEY, Accept: 'application/json' };
  try {
    let r = await fetch(API + '?url=' + encodeURIComponent(link), { headers });
    if ([400, 404, 405, 415].includes(r.status)) {
      r = await fetch(API, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link }) });
    }
    return json(await r.text(), r.status);
  } catch (e) {
    return json({ error: 'upstream fail: ' + String((e && e.message) || e) }, 502);
  }
}

// Vercel Serverless Function:  GET /api/tera?url=<terabox link>
// Browser -> (same origin) -> ei function -> PlayTeraBox API. CORS problem nei, API key browser-e jay na.
// Vercel Dashboard -> Settings -> Environment Variables-e TERA_API_KEY set korle oita use hobe.
const API = 'https://api.playterabox.com/api/proxy';
const FALLBACK_KEY = 'pk_cltx4au47sqf03z97t9tl';
const TERA_RE = /(terabox|1024tera|teraboxapp|terafileshare|teraboxlink|4funbox|mirrobox|teraboxshare|momerybox|tibibox|nephobox|freeterabox)/i;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const link = (req.query && req.query.url) || (req.body && req.body.url) || '';
  if (!link || !TERA_RE.test(String(link))) return res.status(400).json({ error: 'valid terabox url lagbe' });
  const key = process.env.TERA_API_KEY || FALLBACK_KEY;
  const headers = { secret: key, Accept: 'application/json' };
  try {
    let r = await fetch(API + '?url=' + encodeURIComponent(link), { headers });
    if ([400, 404, 405, 415].includes(r.status)) {
      r = await fetch(API, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link }) });
    }
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json; charset=utf-8').send(text);
  } catch (e) {
    res.status(502).json({ error: 'upstream fail: ' + String(e && e.message || e) });
  }
};

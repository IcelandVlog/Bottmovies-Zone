// Vercel Serverless Function:  GET /api/tera?url=<terabox link>
// Browser -> (same origin) -> ei function -> PlayTeraBox API. CORS problem nei, API key browser-e jay na.
// Vercel Dashboard -> Settings -> Environment Variables-e TERA_API_KEY set korle oita use hobe.
const https = require('https');
const API = 'https://api.playterabox.com/api/proxy';
const FALLBACK_KEY = 'pk_cltx4au47sqf03z97t9tl';
const TERA_RE = /(terabox|1024tera|teraboxapp|terafileshare|teraboxlink|4funbox|mirrobox|teraboxshare|momerybox|tibibox|nephobox|freeterabox)/i;

// fetch GET-e body pathate dey na, tai https module (playground-er curl: GET + --data '{"url":"..."}' er moto)
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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-tera-proxy', '1');
  const link = (req.query && req.query.url) || (req.body && req.body.url) || '';
  if (!link || !TERA_RE.test(String(link))) return res.status(400).json({ error: 'valid terabox url lagbe' });
  const key = process.env.TERA_API_KEY || FALLBACK_KEY;
  const headers = { secret: key, Accept: 'application/json' };

  // Docs: GET https://api.playterabox.com/api/proxy?secret=<KEY>&url=<terabox link>
  const encoded = API + '?secret=' + encodeURIComponent(key) + '&url=' + encodeURIComponent(link);
  const raw = API + '?secret=' + encodeURIComponent(key) + '&url=' + link; // docs example-er moto encode chhara
  const attempts = [['GET (encoded url)', () => rawRequest('GET', encoded, headers)]];
  if (raw !== encoded) attempts.push(['GET (raw url)', () => rawRequest('GET', raw, headers)]);
  const log = [];
  for (const [name, run] of attempts) {
    try {
      const r = await run();
      if (r.status >= 200 && r.status < 300) {
        return res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8').send(r.text);
      }
      log.push(name + ' -> ' + r.status + ' ' + r.text.slice(0, 120).replace(/\s+/g, ' '));
      if (r.status === 401 || r.status === 403 || r.status === 429) break; // key/credit problem, retry kore lav nei
    } catch (e) {
      log.push(name + ' -> ' + String((e && e.message) || e));
    }
  }
  res.status(502).json({ error: 'upstream API success dey ni', tried: log });
};

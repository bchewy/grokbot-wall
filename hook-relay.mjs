// Exposes ONLY POST /webhooks/luma from the wall server, for use behind a public tunnel
// (e.g. `cloudflared tunnel --url http://localhost:8790`). Everything else is 404.
import http from 'node:http';
const TARGET = process.env.TARGET || 'http://localhost:8787';
const PORT = Number(process.env.RELAY_PORT || 8790);
http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/webhooks/luma') { res.writeHead(404); return res.end('not found'); }
  let body = ''; req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const r = await fetch(TARGET + '/webhooks/luma', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-headers': Object.keys(req.headers).join(',') }, body });
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text());
    } catch (e) { res.writeHead(502); res.end('relay error'); }
  });
}).listen(PORT, () => console.log(`hook relay on :${PORT} → ${TARGET}/webhooks/luma`));

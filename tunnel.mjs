#!/usr/bin/env node
// Optional: instant check-ins. Opens a cloudflared quick tunnel that exposes ONLY the webhook
// relay, registers a Luma webhook (guest.updated) pointing at it, and removes the webhook on exit.
// The wall re-polls Luma the moment a webhook lands (~1 s) instead of waiting for the next poll.
// Usage: npm run tunnel   (needs `brew install cloudflared`; run alongside `npm start`)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
} catch {}
const KEY = process.env.LUMA_API_KEY;
if (!KEY) { console.error('LUMA_API_KEY missing in .env'); process.exit(1); }
const WALL_PORT = Number(process.env.PORT || 8787), RELAY_PORT = Number(process.env.RELAY_PORT || 8790);
const LUMA = 'https://public-api.luma.com';
const luma = async (p, body) => {
  const r = await fetch(LUMA + p, { method: body ? 'POST' : 'GET', headers: { 'x-luma-api-key': KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Luma ${r.status} ${j.message || ''}`); return j;
};
const ours = w => /\/webhooks\/luma$/.test(w.url || '');
async function removeOurWebhooks() {
  const list = await luma('/v1/webhooks/list').catch(() => ({ entries: [] }));
  for (const w of (list.entries || []).filter(ours)) { await luma('/v1/webhooks/delete', { id: w.id }).catch(() => {}); console.log(`  – removed webhook ${w.id}`); }
}

const relay = spawn(process.execPath, [path.join(ROOT, 'hook-relay.mjs')], { env: { ...process.env, RELAY_PORT: String(RELAY_PORT), TARGET: `http://localhost:${WALL_PORT}` }, stdio: 'inherit' });
const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${RELAY_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
cf.on('error', e => { console.error(`cloudflared failed to start (${e.message}). Install it with: brew install cloudflared`); cleanup(1); });

let url = null, webhookId = null;
const onLine = async chunk => {
  if (url) return;
  const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m) return;
  url = m[0];
  console.log(`\n  ⚡ tunnel  ${url}  (Cloudflare needs ~10 s before it routes)`);
  try {
    await removeOurWebhooks();
    const res = await luma('/v2/webhooks/create', { url: `${url}/webhooks/luma`, event_types: ['guest.updated'] }); const w = res.webhook || res;
    webhookId = w.id; console.log(`  ⚡ webhook ${webhookId} → guest.updated  (Ctrl-C removes it)\n`);
  } catch (e) { console.error('  could not register webhook:', e.message); }
};
cf.stdout.on('data', onLine); cf.stderr.on('data', onLine);

let done = false;
async function cleanup(code = 0) {
  if (done) return; done = true;
  console.log('\n  shutting down…');
  if (webhookId) await luma('/v1/webhooks/delete', { id: webhookId }).then(() => console.log(`  – removed webhook ${webhookId}`)).catch(() => {});
  cf.kill(); relay.kill(); process.exit(code);
}
process.on('SIGINT', () => cleanup(0)); process.on('SIGTERM', () => cleanup(0));
cf.on('exit', c => { if (!done) { console.error(`cloudflared exited (${c})`); cleanup(1); } });

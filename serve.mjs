#!/usr/bin/env node
// Grok Bot check-in wall: static server + Luma API proxy + shared allocation state.
// Usage:  LUMA_API_KEY=... node serve.mjs   (or put the key in .env)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---- .env (only fills vars that are not already set) ----
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');   // an explicitly empty env var wins over .env
  }
} catch {}

const KEY = process.env.LUMA_API_KEY || '';
const PORT = Number(process.env.PORT || 8787);
const LUMA = 'https://public-api.luma.com';
const CODES_FILE = fs.existsSync(path.join(ROOT, 'data/codes.json')) ? 'data/codes.json' : 'data/codes.example.json';
if (CODES_FILE.includes('example')) console.warn('  ! data/codes.json not found — using the placeholder codes from data/codes.example.json');
const CODES = JSON.parse(fs.readFileSync(path.join(ROOT, CODES_FILE), 'utf8'));
const STATE_FILE = path.join(ROOT, 'data/state.json');

let state = { allocations: [], config: { eventId: process.env.LUMA_EVENT_ID || null, poolMode: 'A-then-B', pollMs: 5000 } };
try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); state = { ...state, ...s, config: { ...state.config, ...(s.config || {}) } }; } catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
// backfill code indexes on allocations made before `n` existed
for (const a of state.allocations) for (const c of a.codes || []) if (!c.n) { const i = (CODES[c.pool] || []).findIndex(x => x.code === c.code); if (i >= 0) c.n = i + 1; }

// ---- email (Resend) ----
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'Grok Bot <onboarding@resend.dev>';
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || '';
const EMAIL_SUBJECT = process.env.EMAIL_SUBJECT || `Your Cursor credits from ${process.env.EVENT_NAME || 'Grok Bot Meetup'}`;
const EVENT_NAME = process.env.EVENT_NAME || '';
const EMAIL_EVENT = process.env.EMAIL_EVENT_NAME || EVENT_NAME || 'Grok Bot Meetup';
const EMAIL_DRY_RUN = /^(1|true|yes)$/i.test(process.env.EMAIL_DRY_RUN || '');
const EMAIL_TEST_TO = process.env.EMAIL_TEST_TO || '';           // if set, every guest email is redirected here
const EMAIL_OFF = /^(1|true|yes)$/i.test(process.env.EMAIL_OFF || '');
const emailEnabled = () => !EMAIL_OFF && (EMAIL_DRY_RUN || Boolean(RESEND_KEY));
const emailInfo = () => ({ enabled: emailEnabled(), dryRun: EMAIL_DRY_RUN, from: EMAIL_FROM, testTo: EMAIL_TEST_TO, hasKey: Boolean(RESEND_KEY) });
const isEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));
const escHtml = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// timeout covers connect + headers + body (a stalled body read is what wedged the queue on event day)
async function fetchJsonWithTimeout(url, init, ms = 20000) { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms); try { const r = await fetch(url, { ...init, signal: ac.signal }); const body = await r.json().catch(() => ({})); return { status: r.status, ok: r.ok, body }; } finally { clearTimeout(t); } }

function renderEmail(a) {
  const first = String(a.name || '').trim().split(/\s+/)[0] || 'there';
  const many = a.codes.length > 1;
  const hero = PUBLIC_URL ? `${PUBLIC_URL}/assets/hero-blue.jpg` : '';   // needs a public URL for mail clients to fetch it
  const BLUE = '#0B72E1', INK = '#111318', MUTED = '#5b606b', LINE = '#e6e8ee', PANEL = '#f3f4f7';
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif";
  const codeBlocks = a.codes.map(c => `
    <tr><td style="padding:0 0 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:12px;background:${PANEL}">
        <tr><td style="padding:18px 20px 6px;font:600 11px/1 ${font};letter-spacing:.14em;color:${MUTED};text-transform:uppercase">Cursor credits${many ? ` &middot; ${escHtml(CODES.labels?.[c.pool] || c.pool)}` : ''} &middot; your code</td></tr>
        <tr><td style="padding:0 20px 14px;font:600 24px/1.3 Menlo,Consolas,'Courier New',monospace;color:${INK};letter-spacing:.03em;word-break:break-all">${escHtml(c.code)}</td></tr>
        <tr><td style="padding:0 20px 18px">
          <a href="${escHtml(c.url)}" style="display:inline-block;background:${BLUE};color:#ffffff;font:600 15px/1 ${font};text-decoration:none;padding:14px 24px;border-radius:10px">Redeem credits on cursor.com</a>
          <div style="padding-top:10px;font:12px/1.6 ${font};color:${MUTED}">or open <a href="${escHtml(c.url)}" style="color:${BLUE}">${escHtml(c.url)}</a></div>
        </td></tr>
      </table>
    </td></tr>`).join('');
  const STEPS = [
    ['Account + app', 'Create a fresh Cursor account, or sign in to an existing <b>personal</b> one. Download Grok Bot from <a href="https://x.ai/bot" style="color:' + BLUE + '">x.ai/bot</a> (Mac or Windows) and sign in.'],
    ['Start the trial', 'Activate the Grok Bot trial and enter card details when asked. There is usually no OTP and no charge at this step. You land in Grok Bot onboarding; the free trial runs until you hit 100% usage (resets every 7 days on free plans).'],
    ['Redeem the credits', 'Stay logged into that same Cursor account and open the credits link above. Click <b>Get Started</b>. The credits land on cursor.com/dashboard under Billing.'],
    ['When the trial hits its limit', 'The free trial is only a few minutes of real use. When it stops you get a popup: <b>Upgrade with Grok</b> or <b>Upgrade to Pro</b>. Choose <b>Upgrade to Pro</b>; that is the path that applies your Cursor credit.'],
    ['Checkout', 'You land on Cursor&rsquo;s Stripe page with the credit already applied, so the total should be <b>$0</b>. Enter card details and complete checkout. Tax is drawn from the credits too.'],
  ];
  const NOTES = [
    'The credits link works until it is redeemed. Make sure you are on the correct <b>non-Team</b> account before you click Get Started.',
    'A card is required twice on a fresh account: once for trial verification, once for the $0 Pro checkout. No charge at the trial in our test run.',
    'Don&rsquo;t pick <b>Upgrade with Grok</b>. That goes to x.ai / Google sign-in and does not apply this Cursor credit.',
    'Credits won&rsquo;t work on a Team plan.',
    'If the credits don&rsquo;t show after redeeming: hard refresh, or log out and back in, then check Dashboard &rsaquo; Credits.',
  ];
  const stepRows = STEPS.map(([title, body], i) => `
    <tr>
      <td valign="top" style="padding:0 14px 18px 0;width:32px"><div style="width:30px;height:30px;border-radius:15px;background:${BLUE};color:#fff;font:700 14px/30px ${font};text-align:center">${i + 1}</div></td>
      <td valign="top" style="padding:0 0 18px;font:14px/1.6 ${font};color:${INK}"><div style="font-weight:700;padding:4px 0 2px">${title}</div><div style="color:#3a3f4a">${body}</div></td>
    </tr>`).join('');
  const noteRows = NOTES.map(n => `<tr><td valign="top" style="padding:0 10px 8px 0;font:14px/1.6 ${font};color:${BLUE}">&bull;</td><td style="padding:0 0 8px;font:14px/1.6 ${font};color:#3a3f4a">${n}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escHtml(EMAIL_SUBJECT)}</title></head>
<body style="margin:0;padding:0;background:${PANEL};font-family:${font}">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">Your Cursor credits code from ${escHtml(EMAIL_EVENT)}, plus how to redeem it.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PANEL};padding:28px 12px"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid ${LINE}">
      ${hero ? `<tr><td style="line-height:0"><img src="${hero}" width="600" alt="Grok Bot" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>` : ""}
      <tr><td style="padding:30px 32px 0">
        <div style="font:600 11px/1 ${font};letter-spacing:.14em;color:${MUTED};text-transform:uppercase">${escHtml(EMAIL_EVENT)}</div>
        <div style="padding-top:12px;font:700 26px/1.25 ${font};color:${INK}">Hi ${escHtml(first)}, you&rsquo;re checked in.</div>
        <div style="padding:12px 0 22px;font:15px/1.65 ${font};color:#3a3f4a">Thanks for coming. Grok Bot has set aside your Cursor credits &mdash; ${many ? 'here are your codes' : 'here is your code'}, followed by the exact steps to turn ${many ? 'them' : 'it'} into a Pro plan for the Build.</div>
      </td></tr>
      <tr><td style="padding:0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${codeBlocks}</table></td></tr>
      <tr><td style="padding:8px 32px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid ${BLUE};background:#eef5fd;border-radius:0 10px 10px 0"><tr><td style="padding:12px 16px;font:14px/1.6 ${font};color:${INK}"><b>Before you start:</b> use the credits link on a <b>single-user</b> Cursor account (not a Team plan), in the same browser you&rsquo;ll use for the steps below.</td></tr></table>
      </td></tr>
      <tr><td style="padding:28px 32px 0">
        <div style="font:700 18px/1.3 ${font};color:${INK};padding-bottom:16px">How to redeem</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stepRows}</table>
        <div style="font:14px/1.6 ${font};color:#3a3f4a;padding:2px 0 0">Grok Bot picks up the plan on its own and usage resets to around 1%. You&rsquo;re all set.</div>
      </td></tr>
      <tr><td style="padding:26px 32px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PANEL};border-radius:12px"><tr><td style="padding:18px 20px 12px">
          <div style="font:700 15px/1.3 ${font};color:${INK};padding-bottom:10px">Notes</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${noteRows}</table>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:26px 32px 30px;font:12px/1.7 ${font};color:${MUTED};border-top:1px solid ${LINE}">Sent by the check-in desk at ${escHtml(EMAIL_EVENT)}, a community event. Stuck? Just reply to this email.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  const strip = t => t.replace(/<[^>]+>/g, '').replace(/&rsquo;/g, "'").replace(/&rsaquo;/g, '>').replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&bull;/g, '•').replace(/&amp;/g, '&');
  const text = `Hi ${first}, you're checked in at ${EMAIL_EVENT}.

Thanks for coming. ${many ? 'Here are your Cursor referral codes' : 'Here is your Cursor referral code'}:

${a.codes.map(c => `  ${c.code}\n  ${c.url}`).join('\n\n')}

BEFORE YOU START
Use the credits link on a single-user Cursor account (not a Team plan), in the same browser you'll use for the steps below.

HOW TO REDEEM
${STEPS.map(([t, b], i) => `${i + 1}. ${t}\n   ${strip(b)}`).join('\n\n')}

Grok Bot picks up the plan on its own and usage resets to around 1%. You're all set.

NOTES
${NOTES.map(n => `- ${strip(n)}`).join('\n')}

Stuck? Just reply to this email.
`;
  return { subject: EMAIL_SUBJECT, html, text };
}

async function deliver(a, { to, tag = '' } = {}) {
  const msg = renderEmail(a);
  const dest = to || EMAIL_TEST_TO || a.email;
  const subject = (!to && EMAIL_TEST_TO ? `[TEST → ${a.email}] ` : '') + tag + msg.subject;
  const at = new Date().toISOString();
  if (EMAIL_DRY_RUN) { console.log(`  ✉ dry-run → ${dest}  (${a.name || a.key})`); return { status: 'dry', to: dest, at, subject }; }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetchJsonWithTimeout('https://api.resend.com/emails', {
        method: 'POST', headers: { authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: EMAIL_FROM, to: [dest], reply_to: EMAIL_REPLY_TO || undefined, subject, html: msg.html, text: msg.text }),
      });
      const body = r.body;
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) return { status: 'failed', to: dest, at, error: `${r.status} ${body.message || body.name || ''}`.trim() };
      console.log(`  ✉ sent → ${dest}  (${a.name || a.key})  ${body.id || ''}`);
      return { status: 'sent', to: dest, at, id: body.id || null };
    } catch (e) { if (attempt === 3) return { status: 'failed', to: dest, at, error: String(e.message || e) }; await sleep(1000); }
  }
  return { status: 'failed', to: dest, at, error: '429 rate limited (gave up)' };
}

// ---- access token: everything except the Luma webhook needs it when WALL_TOKEN is set ----
const WALL_TOKEN = process.env.WALL_TOKEN || '';
const authed = (req, url) => !WALL_TOKEN || (req.headers['x-wall-key'] || url.searchParams.get('key')) === WALL_TOKEN;

// ---- Luma polling (server-side): the server owns check-in detection, allocation and email ----
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const luma = { event: null, total: 0, guests: new Map(), lastSync: 0, error: '', fullAt: 0, timer: null, running: false };
async function lumaGet(p, q) {
  const u = new URL(LUMA + p); Object.entries(q || {}).forEach(([k, v]) => v != null && u.searchParams.set(k, v));
  const r = await fetch(u, { headers: { 'x-luma-api-key': KEY, accept: 'application/json' } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Luma ${r.status} ${j.message || ''}`.trim()); return j;
}
async function lumaPost(p, body) {
  const r = await fetch(LUMA + p, { method: 'POST', headers: { 'x-luma-api-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Luma ${r.status} ${j.message || ''}`.trim()); return j;
}
const normGuest = e => {
  const t = e.event_tickets || []; const ci = e.checked_in_at || t.map(x => x.checked_in_at).filter(Boolean).sort()[0] || null;
  const name = e.user_name || [e.user_first_name, e.user_last_name].filter(Boolean).join(' ') || e.user_email || 'Guest';
  return { key: String(e.user_email || e.user_id || e.id).toLowerCase(), id: e.id, name, email: e.user_email || '', checkedInAt: ci, approval: e.approval_status };
};
async function resolveEvent() {
  if (state.config.eventId) { const ev = await lumaGet('/v1/events/get', { event_id: state.config.eventId }); return ev.event || ev; }
  const after = new Date(Date.now() - 18 * 3600e3).toISOString();
  const j = await lumaGet('/v1/calendars/events/list', { after, pagination_limit: 10, sort_column: 'start_at', sort_direction: 'asc' });
  const ev = (j.entries || []).map(e => e.event || e)[0]; if (!ev) throw new Error('no upcoming events on this calendar'); return ev;
}
async function pollLuma() {
  if (!KEY || luma.running) return; luma.running = true;
  try {
    if (!luma.event) {
      const ev = await resolveEvent(); luma.event = { id: ev.id, name: ev.name, start_at: ev.start_at };
      const gc = ev.guest_counts && ev.guest_counts.approved; if (gc) luma.total = gc.guests || 0;
      console.log(`  ◎ luma event ${ev.id} "${ev.name}"`);
    }
    const full = Date.now() - luma.fullAt > 60_000; let cursor = null, pages = 0, stop = false, count = 0;
    do {
      const j = await lumaGet('/v1/events/guests/list', { event_id: luma.event.id, approval_status: 'approved', pagination_limit: 50, sort_column: 'checked_in_at', sort_direction: 'desc nulls last', pagination_cursor: cursor });
      for (const e of j.entries || []) {
        const g = normGuest(e); luma.guests.set(g.key, g); count++;
        if (g.checkedInAt) { if (!state.allocations.some(a => a.key === g.key)) { const a = allocate({ ...g, source: 'luma' }); console.log(`  ✓ check-in ${g.name}  → ${a.codes.map(c => c.pool + '#' + c.n).join('+') || 'no codes left'}`); } }
        else if (!full) stop = true;
      }
      cursor = j.next_cursor; pages++; if (!j.has_more || stop || pages > 40) break;
    } while (cursor);
    if (full) { luma.fullAt = Date.now(); luma.total = count; }
    luma.lastSync = Date.now(); luma.error = '';
  } catch (e) { luma.error = e.message; console.log(`  ✗ luma: ${e.message}`); }
  finally { luma.running = false; }
}
function schedulePoll(ms) { clearTimeout(luma.timer); luma.timer = setTimeout(async () => { await pollLuma(); schedulePoll(state.config.pollMs || 5000); }, ms); }
async function registerWebhook() {
  if (!KEY || !PUBLIC_URL) return;
  try {
    const want = `${PUBLIC_URL}/webhooks/luma`;
    const ours = ((await lumaGet('/v1/webhooks/list')).entries || []).filter(w => /\/webhooks\/luma$/.test(w.url || ''));
    const keep = ours.find(w => w.url === want && w.status === 'active');
    for (const w of ours) if (w !== keep) await lumaPost('/v1/webhooks/delete', { id: w.id }).catch(() => {});
    if (keep) console.log(`  ⚡ webhook ${keep.id} → ${want}`);
    else { const j = await lumaPost('/v2/webhooks/create', { url: want, event_types: ['guest.updated'] }); console.log(`  ⚡ webhook ${(j.webhook || j).id} → ${want}`); }
  } catch (e) { console.log(`  ⚡ webhook registration failed: ${e.message}`); }
}

// ---- Luma webhook receiver (diagnostic + nudge): logs what Luma sends, and lets the wall re-poll immediately ----
const hookLog = []; let lastWebhookAt = null;
function recordWebhook(req, b) {
  const g = b.data || {}; const tickets = g.event_tickets || [];
  const entry = {
    at: new Date().toISOString(), type: b.type || '?',
    guest: g.user_name || (g.user_email ? g.user_email.replace(/^(..).*@/, '$1…@') : g.id || null),
    approval: g.approval_status || null,
    checked_in_at: g.checked_in_at || tickets.map(t => t.checked_in_at).filter(Boolean)[0] || null,
    signature_headers: Object.keys(req.headers).filter(h => /luma|signature|secret|webhook/i.test(h)),
  };
  hookLog.unshift(entry); if (hookLog.length > 100) hookLog.pop();
  lastWebhookAt = entry.at; if (KEY && Date.now() - luma.lastSync > 1000) schedulePoll(150);   // nudge, but never faster than 1/s
  console.log(`  ⚡ webhook ${entry.type}  ${entry.guest || ''}  approval=${entry.approval || '-'}  checked_in_at=${entry.checked_in_at || '-'}`);
  return entry;
}

const mailQueue = []; let mailBusy = false;
function enqueueMail(a, { force = false } = {}) {
  const at = new Date().toISOString();
  if (!emailEnabled()) { a.mail = { status: 'skipped', reason: 'email not configured', at }; return; }
  if (!isEmail(a.email)) { a.mail = { status: 'skipped', reason: 'no email', at }; return; }
  if (!a.codes.length) { a.mail = { status: 'skipped', reason: 'no codes', at }; return; }
  if (!force && a.mail && (a.mail.status === 'sent' || a.mail.status === 'queued')) return;
  a.mail = { status: 'queued', at };
  mailQueue.push(a.key); pumpMail();
}
async function pumpMail() {
  if (mailBusy) { console.log(`  ✉ pump busy (queue ${mailQueue.length})`); return; } mailBusy = true;
  console.log(`  ✉ pump start (queue ${mailQueue.length})`);
  try {
    while (mailQueue.length) {
      const key = mailQueue.shift(); const a = state.allocations.find(x => x.key === key); if (!a) { console.log(`  ✉ skip ${key}: no allocation`); continue; }
      console.log(`  ✉ sending → ${a.email} (${a.name || a.key})`);
      const tries = ((a.mail && a.mail.tries) || 0) + 1;
      try { a.mail = await Promise.race([deliver(a), sleep(90_000).then(() => ({ status: 'failed', to: a.email, at: new Date().toISOString(), error: 'send timed out' }))]); }
      catch (e) { a.mail = { status: 'failed', to: a.email, at: new Date().toISOString(), error: String(e.message || e) }; }
      a.mail.tries = tries;
      save();
      if (a.mail.status === 'failed') console.log(`  ✉ FAILED → ${a.mail.to}: ${a.mail.error}`);
      await sleep(600);  // Resend default limit is 2 req/s
    }
  } finally { mailBusy = false; }
}
// self-heal: anything still 'queued' after 90 s (a crash, restart or stall) goes back on the queue
function requeueStale(all = false) {   // all=true on startup: the in-memory queue is gone, so every 'queued' is orphaned
  if (!emailEnabled()) return;
  const now = Date.now(); let n = 0;
  for (const a of state.allocations) {
    const m = a.mail;
    const transient = m && m.status === 'failed' && (m.tries || 0) < 3 && /timed out|abort|ECONN|fetch failed|network|rate limited/i.test(m.error || '') && now - new Date(m.at).getTime() > 60_000;
    if (!m || transient || (m.status === 'queued' && (all || now - new Date(m.at).getTime() > 30_000))) {
      if (!isEmail(a.email) || !a.codes.length || mailQueue.includes(a.key)) continue;
      a.mail = { status: 'queued', at: new Date().toISOString(), tries: (m && m.tries) || 0 }; mailQueue.push(a.key); n++;
    }
  }
  if (n) { console.log(`  ✉ re-queued ${n} stale email(s)`); save(); pumpMail(); }
}
setTimeout(() => requeueStale(true), 2000); setInterval(() => requeueStale(false), 20_000);

function allocate(body) {
  const key = String(body.key || '').trim().toLowerCase();
  if (!key) throw new Error('key required');
  const existing = state.allocations.find(a => a.key === key);
  if (existing) return existing;
  const used = new Set(state.allocations.flatMap(a => a.codes.map(c => c.code)));
  const pick = pool => { const i = (CODES[pool] || []).findIndex(c => !used.has(c.code)); return i >= 0 ? { pool, code: CODES[pool][i].code, url: CODES[pool][i].url, n: i + 1 } : null; };
  const codes = [];
  if (state.config.poolMode === 'both') {
    for (const p of ['A', 'B']) { const c = pick(p); if (c) codes.push(c); }
  } else {
    for (const p of (state.config.poolMode === 'B-then-A' ? ['B', 'A'] : ['A', 'B'])) { const c = pick(p); if (c) { codes.push(c); break; } }
  }
  const a = {
    key, name: String(body.name || '').slice(0, 120), email: String(body.email || '').slice(0, 200),
    checkedInAt: body.checkedInAt || null, source: body.source === 'manual' ? 'manual' : 'luma',
    at: new Date().toISOString(), codes,
  };
  state.allocations.push(a);
  enqueueMail(a);
  save();
  return a;
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const publicState = () => ({ allocations: state.allocations, config: state.config, pools: { A: CODES.A.length, B: CODES.B.length }, labels: CODES.labels, lastWebhookAt, luma: { serverPolls: Boolean(KEY), event: luma.event, total: luma.total, lastSync: luma.lastSync, error: luma.error } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/webhooks/luma' && req.method === 'POST') { recordWebhook(req, await readBody(req)); return json(res, 200, { ok: true }); }
    if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
      const f = path.join(ROOT, 'assets', path.normalize(url.pathname.slice('/assets/'.length)).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(path.join(ROOT, 'assets')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      const type = /\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.png$/i.test(f) ? 'image/png' : /\.svg$/i.test(f) ? 'image/svg+xml' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=86400' }); return fs.createReadStream(f).pipe(res);
    }
    if (!authed(req, url)) {
      if ((req.headers.accept || '').includes('text/html')) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>Grok Bot</title><body style="background:#000;color:#8a8f9a;font:14px Menlo,monospace;padding:40px">● locked — open the wall with <code>?key=…</code></body>'); }
      return json(res, 401, { message: 'missing or wrong key' });
    }
    if (url.pathname === '/guests') return json(res, 200, { guests: [...luma.guests.values()] });
    if (url.pathname === '/health') return json(res, 200, { ok: true, luma: Boolean(KEY), serverPolls: Boolean(KEY), auth: Boolean(WALL_TOKEN), eventName: EVENT_NAME, eventId: state.config.eventId, pools: { A: CODES.A.length, B: CODES.B.length }, email: emailInfo() });
    if (url.pathname === '/state' && req.method === 'GET') return json(res, 200, publicState());
    if (url.pathname === '/allocate' && req.method === 'POST') return json(res, 200, { allocation: allocate(await readBody(req)) });
    if (url.pathname === '/config' && req.method === 'POST') {
      const b = await readBody(req);
      const prevEvent = state.config.eventId;
      for (const k of ['eventId', 'poolMode', 'pollMs']) if (k in b) state.config[k] = b[k];
      save(); if (state.config.eventId !== prevEvent) { luma.event = null; luma.fullAt = 0; luma.guests.clear(); } if (KEY) schedulePoll(200); return json(res, 200, { config: state.config });
    }
    if (url.pathname === '/webhooks/log') return json(res, 200, { lastWebhookAt, events: hookLog });
    if (url.pathname === '/email/send' && req.method === 'POST') {
      const b = await readBody(req); const a = state.allocations.find(x => x.key === String(b.key || '').toLowerCase());
      if (!a) return json(res, 404, { message: 'no allocation for that key' });
      enqueueMail(a, { force: true }); save(); return json(res, 200, { allocation: a });
    }
    if (url.pathname === '/email/status') return json(res, 200, { busy: mailBusy, queue: [...mailQueue], version: 'v4' });
    if (url.pathname === '/email/sweep' && req.method === 'POST') { const before = mailQueue.length; requeueStale(); return json(res, 200, { queuedBefore: before, queue: [...mailQueue], busy: mailBusy }); }
    if (url.pathname === '/email/send-now' && req.method === 'POST') {
      const b = await readBody(req); const a = state.allocations.find(x => x.key === String(b.key || '').toLowerCase());
      if (!a) return json(res, 404, { message: 'no allocation for that key' });
      if (!emailEnabled() || !isEmail(a.email) || !a.codes.length) return json(res, 400, { message: 'cannot send for this allocation' });
      a.mail = await deliver(a); a.mail.tries = ((a.mail && a.mail.tries) || 0) + 1; save(); return json(res, 200, { allocation: a });
    }
    if (url.pathname === '/email/test' && req.method === 'POST') {
      const b = await readBody(req); const to = String(b.to || '').trim();
      if (!isEmail(to)) return json(res, 400, { message: 'valid "to" address required' });
      if (!emailEnabled()) return json(res, 503, { message: 'email not configured (set RESEND_API_KEY, or EMAIL_DRY_RUN=1)' });
      const sample = { key: 'test', name: b.name || 'Test Guest', email: to, codes: [{ pool: 'A', code: 'TEST-CODE-NOT-REAL', url: 'https://cursor.com/referral?code=TEST-CODE-NOT-REAL' }] };
      if (state.config.poolMode === 'both') sample.codes.push({ pool: 'B', code: 'POOLB-TEST-CODE', url: 'https://cursor.com/referral?code=POOLB-TEST-CODE' });
      const result = await deliver(sample, { to, tag: '[TEST] ' });
      return json(res, result.status === 'failed' ? 502 : 200, { result, info: emailInfo() });
    }
    if (url.pathname === '/release' && req.method === 'POST') {
      const b = await readBody(req); const key = String(b.key || '').toLowerCase();
      const i = state.allocations.findIndex(x => x.key === key); if (i < 0) return json(res, 404, { message: 'no allocation for that key' });
      const [a] = state.allocations.splice(i, 1); save();
      console.log(`  ↩ released ${a.name || a.key}  (${a.codes.map(c => c.pool + '#' + c.n).join('+') || 'no codes'}) — back in the pool`);
      if (KEY) { luma.fullAt = 0; schedulePoll(400); }
      return json(res, 200, { ok: true, released: a });
    }
    if (url.pathname === '/reset' && req.method === 'POST') {
      if (state.allocations.length) fs.writeFileSync(STATE_FILE.replace(/\.json$/, `.backup-${Date.now()}.json`), JSON.stringify(state, null, 2));
      state.allocations = []; save(); luma.fullAt = 0; if (KEY) schedulePoll(500); return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/luma/')) {
      if (!KEY) return json(res, 503, { message: 'LUMA_API_KEY not set on the server' });
      const qs = [...url.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const target = LUMA + url.pathname.slice('/luma'.length) + (qs ? '?' + qs : '');
      const init = { method: req.method, headers: { 'x-luma-api-key': KEY, accept: 'application/json' } };
      if (req.method === 'POST') { init.body = JSON.stringify(await readBody(req)); init.headers['content-type'] = 'application/json'; }
      const up = await fetch(target, init);
      const text = await up.text();
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
      return res.end(text);
    }
    // static
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(ROOT, 'dist', file);
    if (!full.startsWith(path.join(ROOT, 'dist')) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const type = full.endsWith('.html') ? 'text/html; charset=utf-8' : full.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    fs.createReadStream(full).pipe(res);
  } catch (e) {
    json(res, 500, { message: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`\n  ● Grok Bot check-in wall`);
  console.log(`    local   http://localhost:${PORT}`);
  if (lan) console.log(`    lan     http://${lan}:${PORT}   (open on a second device for the desk)`);
  console.log(`    luma    ${KEY ? `API key loaded · server polls every ${Math.round((state.config.pollMs || 5000) / 1000)}s` : 'NO API KEY → wall runs in demo mode (set LUMA_API_KEY in .env)'}`);
  console.log(`    auth    ${WALL_TOKEN ? 'token set → open /?key=' + WALL_TOKEN.slice(0, 4) + '…' : 'OPEN — set WALL_TOKEN before exposing this publicly'}`);
  if (PUBLIC_URL) console.log(`    public  ${PUBLIC_URL}`);
  console.log(`    codes   A=${CODES.A.length}  B=${CODES.B.length}   allocated so far: ${state.allocations.length}`);
  const ei = emailInfo();
  console.log(`    email   ${!ei.enabled ? 'OFF (set RESEND_API_KEY in .env)' : ei.dryRun ? 'DRY RUN (logs only)' : 'Resend · from ' + ei.from + (ei.testTo ? ' · ALL mail redirected to ' + ei.testTo : '')}`);
  console.log(`    state   ${path.relative(process.cwd(), STATE_FILE)}\n`);
  if (KEY) { schedulePoll(300); registerWebhook(); }
});

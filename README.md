# Grok Bot · Check-in Wall

A single-file Three.js "terminal" for a Grok Bot meetup: guests check in on Luma, a
full-screen ASCII Grok Bot greets each one by name on the venue screen, and every guest is
emailed a Cursor referral code (credits) the moment they check in.

Everything on screen is one WebGL character grid: a 3D Grok Bot rendered through an ASCII
shader, morphing between the eight official Grok Bot silhouettes in the brand colours; a
drifting headline and colour field on a finer grid behind it; a live check-in feed and a
block-letter welcome as overlays. Click or tap the art for an ASCII shockwave.

The server does the work: it polls Luma (and accepts its webhook), allocates one code per
guest, and emails it via Resend. The wall page is a viewer. A hidden staff console handles
lookups, resends, manual check-ins, and a CSV export.

## Quick start (local, demo mode)

```sh
npm start                      # builds dist/index.html and serves http://localhost:8787
```

With no `.env` the wall runs a demo with fake guests and placeholder codes. Press `Space`
to fake a check-in, `F` for fullscreen.

## Running it for real

1. `cp .env.example .env` and fill in:
   - `EVENT_NAME` — the headline on the wall and the name in the email.
   - `LUMA_API_KEY` (Luma → Settings → Developer → API Keys) and `LUMA_EVENT_ID` (`evt-…`).
   - `RESEND_API_KEY` and `EMAIL_FROM` (the sender domain must be verified in Resend).
   - `WALL_TOKEN` — any secret; the wall is opened as `/?key=<token>`.
   - `PUBLIC_URL` — the public https URL once hosted (used for the email hero image and to
     self-register the Luma webhook).
2. Put your referral codes in `data/codes.json` (same shape as `data/codes.example.json`:
   two pools, each a list of `{code, url}`). Codes are handed out one per guest, pool A
   first; "one from each pool" is a setting in the staff console.
3. `npm start`, open `http://localhost:8787/?key=<token>` and press `F`.

Rehearsal switches in `.env`: `EMAIL_DRY_RUN=1` logs instead of sending; `EMAIL_TEST_TO`
redirects every guest email to you. Clear both before doors open. Restart after editing.

## Hosting (Docker on a box + Cloudflare tunnel)

```sh
git clone <this repo> && cd grokbot-wall
cp .env.example .env            # fill it in as above
cp data/codes.example.json data/codes.json   # then replace with your real codes
docker compose up -d --build    # wall on 127.0.0.1:8787
```

For a public https hostname without opening ports, use a Cloudflare named tunnel:
`cloudflared tunnel login`, `cloudflared tunnel create grokbot`,
`cloudflared tunnel route dns grokbot grokbot.example.com`, copy the credentials JSON into
`cloudflared/` next to a `config.yml` made from `config.example.yml`, set `PUBLIC_URL`, and
run `docker compose --profile tunnel up -d`. With `PUBLIC_URL` set the server registers a
Luma `guest.updated` webhook for itself (check-ins then show in about a second; polling
every 5 s is the fallback). `deploy.sh` wraps the compose commands.

`WALL_TOKEN` gates every route except the webhook and `/assets`. `data/state.json` holds
allocations and email status and survives restarts. The hosted HTML never embeds codes.

## Staff console

Open the wall with `&desk` in the URL and press `D`: search guests, see a guest's code and
QR, resend their email, release a code back to the pool, do a manual check-in for walk-ins,
export a CSV, change settings (event, pool mode, poll interval).

## How the email queue behaves

Sends are queued at 2/s with a timeout on each request, retries on rate limits and
transient failures, and a sweep every 20 s that re-queues anything stuck; a restart
re-queues every pending send. `POST /email/status`, `/email/sweep`, and `/email/send-now`
exist for emergencies. Guests with no email or no code left are recorded as skipped.

## Keys and URL params

| key | action |
| --- | --- |
| `F` | fullscreen |
| `Space` | demo only: fake a check-in |
| `D` / `M` / `Shift+E` | with `&desk`: console, manual check-in, export CSV |

`?demo` fake guests · `?desk` staff console · `?cell=22` bigger text · `?fine=2` chunkier
backdrop glyphs · `?headline=…` override the headline · `?style=3&color=2&hold` freeze a
bot form and colour · `?raw` 3D scene without the ASCII pass.

## Layout of the repo

```
src/index.html      the wall (three.js UMD + qrcode-generator are inlined by the build)
serve.mjs           server: static, Luma proxy + polling, allocation, Resend queue, webhook
build.mjs           → dist/index.html  (--no-codes for a public copy)
tunnel.mjs          laptop mode: cloudflared quick tunnel + webhook lifecycle
hook-relay.mjs      exposes only the webhook path for that tunnel
assets/hero-blue.jpg  email header, from the Grok Bot brand kit
data/codes.example.json  shape of the referral-code file
```

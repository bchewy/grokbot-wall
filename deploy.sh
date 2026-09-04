#!/usr/bin/env bash
# One-shot deploy/update on the Ubuntu box. Run from the repo directory after `git pull`.
#   ./deploy.sh            # build + (re)start the wall
#   ./deploy.sh tunnel     # also start the cloudflared named tunnel (needs TUNNEL_TOKEN in .env)
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "missing .env — copy .env.example and fill in LUMA_API_KEY, RESEND_API_KEY, EMAIL_FROM, WALL_TOKEN, PUBLIC_URL"; exit 1; }
grep -q '^WALL_TOKEN=.\+' .env || { echo "WALL_TOKEN is empty in .env — refusing to expose an open server"; exit 1; }
mkdir -p data
if [ "${1:-}" = "tunnel" ]; then docker compose --profile tunnel up -d --build; else docker compose up -d --build; fi
sleep 2
docker compose ps
echo; echo "wall:   http://127.0.0.1:8787/?key=$(grep '^WALL_TOKEN=' .env | cut -d= -f2-)"
grep -q '^PUBLIC_URL=.\+' .env && echo "public: $(grep '^PUBLIC_URL=' .env | cut -d= -f2-)/?key=$(grep '^WALL_TOKEN=' .env | cut -d= -f2-)"
echo "logs:   docker compose logs -f wall"

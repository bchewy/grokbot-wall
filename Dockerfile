FROM node:22-alpine
WORKDIR /app
COPY package.json build.mjs serve.mjs hook-relay.mjs tunnel.mjs ./
COPY src ./src
COPY assets ./assets
COPY data/codes.example.json ./data/codes.example.json
# the hosted wall never embeds referral codes; the server holds them
RUN node build.mjs --no-codes
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8787/webhooks/luma >/dev/null 2>&1 || wget -qO- --header="x-wall-key: $WALL_TOKEN" http://localhost:8787/health >/dev/null || exit 1
CMD ["node", "serve.mjs"]

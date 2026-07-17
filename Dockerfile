# Repo-root Dockerfile so Railway/Render/Fly run the resolver worker, NOT the
# Vite frontend. PaaS auto-detection otherwise runs the root package.json
# (npm run build -> serves dist/), which is the wrong service here.
#
# The worker now depends on cheerio (Nkiri HTML parsing), so we install deps.
FROM node:20-slim
WORKDIR /app

# Install dependencies (cheerio)
COPY o2tv-worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Copy source
COPY o2tv-worker/server.js ./server.js
COPY o2tv-worker/o2tvCaptchaResolver.js ./o2tvCaptchaResolver.js
COPY o2tv-worker/nkiriResolver.js ./nkiriResolver.js

# Railway injects PORT; the worker reads process.env.PORT (default 3000).
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]

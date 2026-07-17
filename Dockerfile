# Repo-root Dockerfile so Railway/Render/Fly run the o2tv-worker, NOT the
# Vite frontend. PaaS auto-detection otherwise runs the root package.json
# (npm run build -> serves dist/), which is the wrong service here.
#
# The worker has zero npm dependencies (node:http + global fetch only), so
# there is nothing to install — just copy and run.
FROM node:20-slim
WORKDIR /app
COPY o2tv-worker/package.json ./package.json
COPY o2tv-worker/server.js ./server.js
COPY o2tv-worker/o2tvCaptchaResolver.js ./o2tvCaptchaResolver.js

# Railway injects PORT; the worker reads process.env.PORT (default 3000).
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]

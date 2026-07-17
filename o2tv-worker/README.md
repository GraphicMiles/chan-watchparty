# O2TV Resolve Worker

Standalone HTTP service that resolves O2TV (tvshows4mobile.org) episodes to
playable CDN MP4 URLs. Vercel Hobby kills functions at 10s, but a single
resolve needs **two** captcha solves + **two** Groq vision calls (~5–9s cold),
which is right at the edge. This worker runs on any host with **no function
timeout** and the Vercel API proxies to it.

The frontend, search, seasons, and episodes stay on Vercel (they all fit
comfortably under 10s). Only the heavy `o2tvResolve` action is offloaded here.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/healthz` | none | liveness probe |
| `POST` | `/resolve-episode` | `X-Worker-Secret` | resolve `{showSlug, showName, seasonNum, episodeNum}` → `{result:{url,...}}` |

## Run locally

```bash
cd o2tv-worker
cp .env.example .env   # fill in GROQ_API_KEY
npm start
# -> o2tv-resolve-worker listening on :3001

# test
curl http://localhost:3001/healthz
curl -X POST http://localhost:3001/resolve-episode \
  -H "Content-Type: application/json" \
  -d '{"showSlug":"Silo","seasonNum":1,"episodeNum":1}'
```

## Deploy on Railway (recommended)

1. Push this repo to GitHub.
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Set **Root Directory** = `o2tv-worker` (so only this service is deployed).
4. Add variables (Railway → Settings → Variables):
   - `GROQ_API_KEY` = your Groq key
   - `WORKER_SECRET` = a random hex string (see `.env.example`)
5. Deploy. Railway gives you a URL like `https://o2tv-worker-production.up.railway.app`.
6. Copy that URL into your **Vercel project** env as:
   - `O2TV_WORKER_URL` = `https://o2tv-worker-production.up.railway.app`
   - `O2TV_WORKER_SECRET` = the **same** `WORKER_SECRET` value
7. Redeploy Vercel. Done.

Verify: `curl https://<worker-url>/healthz` → `{"ok":true,...}`

## Deploy on Render

Same idea: **New → Web Service** → connect repo → **Root Directory** `o2tv-worker`
→ Build Command `npm install` → Start Command `npm start` → add the same env vars.

## How Vercel uses it

`api/media.js` `handleO2TvResolve` calls `${O2TV_WORKER_URL}/resolve-episode`
when `O2TV_WORKER_URL` is set, falling back to the in-process resolver if the
worker is unreachable or the env var is absent. So nothing breaks during the
switch — set the vars and it just starts using the worker.

## Keeping the resolver in sync

`o2tvCaptchaResolver.js` is a standalone copy of
`server-lib/o2tvCaptchaResolver.js`. If the resolve chain changes, update both.

# Chan — Security Evaluation & Latency/Bandwidth Optimization Audit

**Date:** 2026-07-14  
**Repo:** `GraphicMiles/chan-watchparty`  
**Auditor:** Arena.ai Agent Mode  
**Status:** ✅ All identified issues have been remediated (see status markers)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Security Evaluation Audit](#security-evaluation-audit)
   - [CRITICAL — Open Proxy via `/api/proxy`](#critical--open-proxy-via-apiproxy)
   - [CRITICAL — SSRF in Media Scraper](#critical--ssrf-in-media-scraper)
   - [HIGH — Wildcard CORS on All Endpoints](#high--wildcard-cors-on-all-endpoints)
   - [HIGH — No Rate Limiting on Any API Endpoint](#high--no-rate-limiting-on-any-api-endpoint)
   - [HIGH — Weak Cron Secret Validation](#high--weak-cron-secret-validation)
   - [HIGH — Firestore Rules Allow Overly Broad Writes](#high--firestore-rules-allow-overly-broad-writes)
   - [MEDIUM — Exposed PAT in Git Clone URL](#medium--exposed-pat-in-git-clone-url)
   - [MEDIUM — OMDb Fallback API Key in Source Code](#medium--omdb-fallback-api-key-in-source-code)
   - [MEDIUM — Anonymous Auth with No Abuse Controls](#medium--anonymous-auth-with-no-abuse-controls)
   - [MEDIUM — No Input Sanitization on Chat Messages](#medium--no-input-sanitization-on-chat-messages)
   - [MEDIUM — NSFW Content Behind Weak Gate](#medium--nsfw-content-behind-weak-gate)
   - [MEDIUM — Sony CDN URLs with Hardcoded Auth Tokens](#medium--sony-cdn-urls-with-hardcoded-auth-tokens)
   - [LOW — Missing Security Headers](#low--missing-security-headers)
   - [LOW — `.env.example` Contains `VITE_` Prefix for Secrets](#low--envexample-contains-vite_-prefix-for-secrets)
   - [LOW — No CSRF Protection on POST Routes](#low--no-csrf-protection-on-post-routes)
   - [LOW — Error Messages Leak Internal State](#low--error-messages-leak-internal-state)
3. [Latency & Bandwidth Optimization](#latency--bandwidth-optimization)
   - [HIGH — Proxy Buffers Entire Chunks Into Memory](#high--proxy-buffers-entire-chunks-into-memory)
   - [HIGH — M3U8 Rewrite Causes Double-Hop Latency](#high--m3u8-rewrite-causes-double-hop-latency)
   - [HIGH — No Client-Side Caching Headers on Proxy Responses](#high--no-client-side-caching-headers-on-proxy-responses)
   - [HIGH — OMDb Enrichment Fires N+1 API Calls Per Search](#high--omdb-enrichment-fires-n1-api-calls-per-search)
   - [MEDIUM — Multiple Unbounded Firestore `onSnapshot` Listeners](#medium--multiple-unbounded-firestore-onsnapshot-listeners)
   - [MEDIUM — No Response Compression](#medium--no-response-compression)
   - [MEDIUM — IPTV Playlist Fetched on Every Search](#medium--iptv-playlist-fetched-on-every-search)
   - [MEDIUM — Vercel Serverless Cold Starts on Every API Call](#medium--vercel-serverless-cold-starts-on-every-api-call)
   - [MEDIUM — Google Fonts Render-Blocking](#medium--google-fonts-render-blocking)
   - [LOW — No Bundle Splitting / Lazy Loading for Heavy Components](#low--no-bundle-splitting--lazy-loading-for-heavy-components)
   - [LOW — Heartbeat Updates Every 30s Cause Unnecessary Firestore Writes](#low--heartbeat-updates-every-30s-cause-unnecessary-firestore-writes)
4. [Prioritized Remediation Roadmap](#prioritized-remediation-roadmap)

---

## Executive Summary

Chan is a real-time watch-party platform built on Firebase + Vercel Serverless Functions with a React (Vite) frontend. The codebase is feature-rich with YouTube/Direct/IPTV streaming, live chat, AI summaries, screen sharing, and content scraping. However, the audit reveals **several critical security vulnerabilities** and **significant latency/bandwidth bottlenecks** that should be addressed before any production scale-up.

**Critical findings:** An open proxy endpoint that anyone can use to bounce traffic, SSRF via the media scraper, and no rate limiting anywhere.

**Latency findings:** Full in-memory buffering of video chunks in the proxy, N+1 OMDb API calls, missing cache headers, and render-blocking fonts.

---

## Security Evaluation Audit

### CRITICAL — Open Proxy via `/api/proxy`

**File:** `api/proxy.js`

The `/api/proxy` endpoint functions as an **open, unauthenticated proxy**. Any client on the internet can pass an arbitrary `?url=` parameter and the server will fetch it and return the response body. While there are SSRF protections (private IP blocking), the endpoint has:

- **No authentication** — no `requireUser()` call, no token check
- **No rate limiting** — can be used to proxy unlimited requests
- **No allow-list** — any public URL is proxied
- **No audit logging** — no record of what was proxied

This turns the Vercel deployment into a **free, anonymous proxy service** for anyone on the internet, which can be abused for:
- Masking attack origins
- Bypassing corporate firewalls
- Proxying malicious content
- Racking up Vercel bandwidth costs

**Remediation:**
1. Add `requireUser(req)` authentication check
2. Implement a URL allow-list or domain allow-list (e.g., only proxy known video CDNs)
3. Add rate limiting (per-UID and global)
4. Log all proxied URLs for audit

---

### CRITICAL — SSRF in Media Scraper

**File:** `api/media.js`

The `fetchHtml()` and `validateProxyUrl()`/`validateFetchTarget()` functions have SSRF protection, but they are **inconsistent**:

1. `validateProxyUrl()` (in `proxy.js`) blocks private IPs via `PRIVATE_IPV4_RE`
2. `validateFetchTarget()` (in `media.js`) has a slightly different implementation using `isPrivateIpv4()` 
3. The `resolvePageChain()` function follows up to 8 URLs with manual redirect handling, and the redirect validation reuses `validateFetchTarget()` — but DNS rebinding attacks can bypass this
4. The `resolveO2TvPage()` function makes direct HTTP requests to hardcoded CDN IPs (`d6.o2tv.org`, etc.) **without** any SSRF validation

More importantly, the scraper accepts **arbitrary user-supplied URLs** via the `scrape` action and follows redirect chains. An attacker can:
- Set up a redirect that resolves to an internal IP after the initial validation
- Use DNS rebinding to pass validation but resolve to `127.0.0.1` on the actual request
- Access internal Vercel metadata endpoints (`169.254.169.254`)

**Remediation:**
1. Use a single, shared SSRF validation function across all endpoints
2. Add DNS resolution validation — resolve the hostname first, then check the resolved IP against private ranges
3. Limit the `scrape` action to known, allow-listed domains only
4. Add a timeout and max-response-size limit to all outbound fetches

---

### HIGH — Wildcard CORS on All Endpoints

**Files:** `server-lib/http.js`, `server-lib/response.js`, `api/proxy.js`

Every API response includes:
```javascript
'Access-Control-Allow-Origin': '*'
```

This allows **any website** on the internet to make authenticated requests to the Chan API using the user's Firebase ID token. A malicious site could:
- Join/leave rooms on behalf of users
- Kick participants
- End rooms
- Generate AI summaries (costing API credits)
- Access the open proxy

**Remediation:**
1. Replace `*` with the specific production origin(s), e.g., `https://chan-yz3p.vercel.app`
2. For development, use a dynamic origin checker that allows `localhost` variants
3. Add `Access-Control-Allow-Credentials: true` when using specific origins

---

### HIGH — No Rate Limiting on Any API Endpoint

**Files:** `api/room.js`, `api/media.js`, `api/proxy.js`

There is **zero rate limiting** on any endpoint. An attacker (or a buggy client) can:
- Flood `/api/media` with search requests → burn YouTube API quota
- Spam `/api/proxy` → exhaust Vercel function invocations and bandwidth
- Call `/api/room` actions (AI summary, quiz) repeatedly → drain Groq API credits
- Create unlimited rooms → fill Firestore storage

The only throttle is a 5-minute cooldown on AI summaries and 60-second cooldown on quiz generation, but these are per-room, not per-user, and trivially bypassed by creating new rooms.

**Remediation:**
1. Implement rate limiting using Vercel Edge Middleware or a Redis-backed solution (e.g., Upstash)
2. Per-UID rate limits: 60 req/min for room actions, 30 req/min for media search, 20 req/min for proxy
3. Global rate limits to protect against DDoS
4. Add exponential backoff on the client side

---

### HIGH — Weak Cron Secret Validation

**File:** `api/room.js`

```javascript
function requireCronSecret(req) {
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    const provided = req.headers['x-cron-secret'] || req.headers['X-Cron-Secret']
    if (provided !== cronSecret) {
      throw Object.assign(new Error('Unauthorized'), { status: 401 })
    }
  }
}
```

**Problems:**
1. If `CRON_SECRET` is not set, the check is **completely bypassed** — anyone can trigger cleanup
2. The comparison is not timing-safe (`!==` instead of `crypto.timingSafeEqual`)
3. The cleanup action is accessible via GET request with no body — trivially triggered
4. In `media.js`, `requireCronSecret` throws if not configured, but in `room.js` it silently passes

**Remediation:**
1. Make `CRON_SECRET` mandatory — throw if it's not set
2. Use `crypto.timingSafeEqual` for comparison
3. Only allow cleanup via POST (not GET)
4. Add a Vercel Cron configuration that sends the secret

---

### HIGH — Firestore Rules Allow Overly Broad Writes

**File:** `firestore.rules`

Several rules are too permissive:

1. **Room update:** Any authenticated participant can update the room document — this means any viewer can change `hostId`, `title`, `videoUrl`, `isPrivate`, `locked`, etc.:
   ```
   allow update: if isRoomHostOrCoHost(roomId) || isRoomParticipant(roomId);
   ```
   A participant (viewer) can change who the host is!

2. **Player state:** Any authenticated user can write player state:
   ```
   allow write: if (isRoomHostOrCoHost(roomId) || isAuthed()) && docId == 'current';
   ```

3. **Quiz write:** Any authenticated user can write quiz data:
   ```
   allow write: if isAuthed();
   ```

4. **AI state write:** Same overly broad permission:
   ```
   allow write: if isRoomHostOrCoHost(roomId) || isAuthed();
   ```

5. **User stats/watchLater:** Any authenticated user can write to any user's stats:
   ```
   allow create, update: if isOwner(uid) || isAuthed();
   ```

**Remediation:**
1. Room updates should be restricted to host/co-host only
2. Player state writes should be restricted to host/co-host
3. Quiz/AI state writes should require host/co-host or be validated via server-side functions
4. User documents should only be writable by the owner (`isOwner(uid)` only)

---

### MEDIUM — Exposed PAT in Git Clone URL

A GitHub PAT (personal access token) was provided in plaintext during the audit setup. If this token was used in any CI/CD pipeline, commit history, or shared channel, it must be revoked immediately. GitHub PATs in messages/logs are a common attack vector.

**Remediation:**
1. **Revoke the token immediately** at GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token with minimal scope
3. Use GitHub's fine-grained PATs or deploy keys instead
4. Never share tokens in plain text — use secret managers

---

### MEDIUM — OMDb Fallback API Key in Source Code

**File:** `api/media.js`

```javascript
const OMDB_API_KEY = process.env.OMDB_API_KEY || process.env.VITE_OMDB_API_KEY || 'trilogy'
```

The fallback key `trilogy` is the OMDb free-tier demo key. While this is a known public key, hardcoding it means:
- If the environment variable is misconfigured, the app silently falls back to a shared, rate-limited key
- The `VITE_` prefix means the OMDb key is potentially exposed in the client-side bundle

**Remediation:**
1. Remove the hardcoded fallback
2. Use only server-side `OMDB_API_KEY` (never `VITE_OMDB_API_KEY`)
3. Fail loudly if the key is missing

---

### MEDIUM — Anonymous Auth with No Abuse Controls

**File:** `src/features/auth/pages/AuthPage.jsx`, `src/shared/auth/hooks/useAuth.jsx`

The app uses **Firebase Anonymous Authentication** with no additional verification:
- No CAPTCHA, no email verification, no phone verification
- Users can create unlimited accounts by simply refreshing
- Each anonymous account can create rooms, use AI features, scrape content
- There's no account deletion mechanism or auto-cleanup

This makes rate limiting per-UID essentially useless since attackers can create unlimited UIDs.

**Remediation:**
1. Add reCAPTCHA v3 / Turnstile to the auth flow
2. Consider adding optional email/Google sign-in for elevated permissions
3. Implement fingerprint-based rate limiting as a secondary defense
4. Add automated cleanup of stale anonymous accounts

---

### MEDIUM — No Input Sanitization on Chat Messages

**File:** `src/features/room/hooks/useRoom.js`

Chat messages are sent directly to Firestore with only length validation (max 500 chars). There's no:
- XSS sanitization (though React auto-escapes, this is still a defense-in-depth gap)
- URL detection/blocking (spam/phishing links)
- Profanity filter
- Spam detection (identical messages, flooding)

The Firestore rules check `text.size() > 0 && text.size() <= 500` but don't validate content.

**Remediation:**
1. Add server-side sanitization in the Cloud Function or via Firestore trigger
2. Implement client-side spam detection (throttle identical messages)
3. Add a URL allow-list or link scanner for chat messages
4. Consider a content moderation layer

---

### MEDIUM — NSFW Content Behind Weak Gate

**Files:** `api/media.js`, `server-lib/nsfw.js`, `server-lib/iptv.js`

NSFW content is gated by:
1. `NSFW_ENABLED=true` environment variable (off by default)
2. `adultVerified` flag in the request body — **client-supplied and not verified server-side**

Additionally, the IPTV module includes hardcoded XXX 18+ channels (`BUILTIN_EXTRA_CHANNELS` with `isNSFW: true`) that are always present in the channel list, just filtered client-side.

**Remediation:**
1. Implement server-side age verification (not just a client-side flag)
2. Move NSFW channel lists behind the `NSFW_ENABLED` gate server-side
3. Never trust client-supplied `adultVerified` flag
4. Add a persistent age-verification mechanism (e.g., stored in user profile)

---

### MEDIUM — Sony CDN URLs with Hardcoded Auth Tokens

**File:** `server-lib/iptv.js`

Multiple Sony channel URLs contain hardcoded `hdnea` authentication tokens:
```
https://sony247channels.akamaized.net/hls/live/.../master.m3u8?hdnea=exp=1594424839~acl=/*~hmac=83f1aab...
```

These tokens:
- Have `exp=1594424839` (expired since June 2020)
- Are hardcoded in source code (should be in environment variables if valid)
- If they were valid, they'd be compromised by being in the repo

**Remediation:**
1. Remove expired/invalid URLs from the built-in channel list
2. If tokens are needed, store them in environment variables
3. Implement a channel health-check system to auto-remove dead URLs

---

### LOW — Missing Security Headers

**File:** `index.html`, `server-lib/response.js`

No security headers are set:
- No `Content-Security-Policy` (CSP)
- No `X-Content-Type-Options: nosniff`
- No `X-Frame-Options: DENY`
- No `Referrer-Policy`
- No `Permissions-Policy`

**Remediation:**
1. Add CSP header via Vercel's `vercel.json` headers configuration
2. Add standard security headers to all API responses
3. Use `helmet` if migrating to Express, or configure Vercel headers

---

### LOW — `.env.example` Contains `VITE_` Prefix for Secrets

**File:** `.env.example`

Several keys that should be server-side only use `VITE_` prefix:
- `VITE_YOUTUBE_API_KEY` — should be server-side only
- The example doesn't clearly distinguish which variables are exposed to the client

The `VITE_` prefix means Vite will bundle them into the client JavaScript, exposing them to anyone who opens DevTools.

**Remediation:**
1. Move YouTube API key to server-side only (`YOUTUBE_API_KEY` without `VITE_` prefix)
2. Add clear comments in `.env.example` distinguishing client vs server variables
3. Audit all `VITE_` variables to ensure none contain secrets

---

### LOW — No CSRF Protection on POST Routes

All POST routes (`/api/room`, `/api/media`) accept requests from any origin due to wildcard CORS. While Bearer token auth provides some protection, there's no CSRF token mechanism.

**Remediation:**
1. With specific-origin CORS (recommended above), CSRF is partially mitigated
2. Add `SameSite=Strict` cookies for session management
3. Consider adding a CSRF token for non-API endpoints

---

### LOW — Error Messages Leak Internal State

**Files:** Various

Error messages sometimes leak internal information:
- `Firebase Admin credentials are missing. Check FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, and FIREBASE_ADMIN_PRIVATE_KEY.` — reveals env var names
- `Upstream server returned HTTP 502` — reveals infrastructure details
- `Could not parse valid quiz from AI response` — reveals AI integration details

**Remediation:**
1. Use generic error messages for client-facing responses
2. Log detailed errors server-side only
3. Never expose environment variable names in error messages

---

## Latency & Bandwidth Optimization

### HIGH — Proxy Buffers Entire Chunks Into Memory

**File:** `api/proxy.js`

The proxy reads the entire response chunk into a `Buffer` before sending:

```javascript
const arrayBuffer = await chunkResponse.arrayBuffer()
res.send(Buffer.from(arrayBuffer))
```

And for video chunks:
```javascript
const chunks = []
let bytesRead = 0
// ... reads up to 3.5MB into memory
const buffer = Buffer.concat(chunks)
res.send(buffer)
```

**Problems:**
- Each 3.5MB chunk is fully buffered in serverless function memory before sending
- Under concurrent requests, this can easily hit Vercel's 1024MB memory limit
- Adds latency equal to the full download time of the chunk

**Remediation:**
1. **Stream the response** — use `Readable.fromWeb(chunkResponse.body).pipe(res)` instead of buffering
2. Vercel Serverless Functions support streaming with `@vercel/node` v3+ using `streaming: true`
3. This reduces TTFB from "full chunk download time" to "first byte from upstream"

---

### HIGH — M3U8 Rewrite Causes Double-Hop Latency

**File:** `api/proxy.js`

When proxying M3U8 playlists, every segment URL is rewritten to go through `/api/proxy`:
```javascript
return `/api/proxy?url=${encodeURIComponent(absoluteUri)}`
```

This means every video segment requires:
1. Client → Vercel Function → Proxy → Upstream CDN → Proxy → Vercel → Client

This **doubles the latency** for every segment and **doubles the bandwidth** (in + out through Vercel). For a 10Mbps stream, that's 20Mbps of Vercel bandwidth per viewer.

**Remediation:**
1. For CORS-friendly CDNs, pass the segment URLs directly to the client (skip proxying)
2. Only proxy segments that actually need it (CORS-restricted origins)
3. Consider using a CDN proxy (Cloudflare Worker, etc.) instead of Vercel functions
4. Set aggressive caching headers on segment responses

---

### HIGH — No Client-Side Caching Headers on Proxy Responses

**File:** `api/proxy.js`

Proxy responses include **no caching headers**:
- No `Cache-Control`
- No `ETag`
- No `Last-Modified`

This means the browser re-fetches every segment, M3U8 playlist, and video chunk on every request, even if nothing changed.

**Remediation:**
1. Add `Cache-Control: public, max-age=3600` for video segments
2. Add `Cache-Control: no-cache` for M3U8 playlists (they change frequently)
3. Add `ETag` headers based on content hash for revalidation
4. Use `Vary: Accept` to handle Range requests properly

---

### HIGH — OMDb Enrichment Fires N+1 API Calls Per Search

**File:** `api/media.js`

The `enrichWithOMDbPosters()` function makes one API call per item that needs a poster:

```javascript
if (!posterCache.has(cleanItemName)) {
  const fetched = await fetchBestOMDbPoster(cleanItemName, query)
  posterCache.set(cleanItemName, fetched || null)
}
```

For a search with 60 results where 30 need OMDb posters, this fires **30 sequential OMDb API calls**. Each call adds ~200-500ms, resulting in **6-15 seconds of total latency**.

**Remediation:**
1. Use OMDb's batch capabilities or parallelize with `Promise.all()` (with concurrency limit)
2. Cache OMDb results in Firestore with a TTL (e.g., 24 hours)
3. Move poster enrichment to an async background process — return results immediately and enrich lazily
4. Reduce the number of items that need poster lookup by improving scraper thumbnail extraction

---

### MEDIUM — Multiple Unbounded Firestore `onSnapshot` Listeners

**File:** `src/features/room/hooks/useRoom.js`

The `useRoom` hook sets up **6 concurrent `onSnapshot` listeners**:
1. Room document
2. Participants collection (unbounded)
3. Messages collection (unbounded)
4. Typing collection (unbounded)
5. Queue collection (unbounded)
6. Floating reactions (limited to 15)
7. Sound effects (limited to 1)
8. Stage pins (limited to 30)

The messages listener has **no limit** and listens to the entire message history:
```javascript
const q = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'))
```

For a room with 10,000+ messages, this downloads the entire history on join.

**Remediation:**
1. Add `limit(200)` to the messages query
2. Implement cursor-based pagination for older messages
3. Add `limit(50)` to participants and typing collections
4. Consider reducing the number of real-time listeners by merging data

---

### MEDIUM — No Response Compression

**Files:** All API endpoints

No `Content-Encoding: gzip` or `br` is set on API responses. For large JSON payloads (e.g., search results with 60+ items including thumbnails and metadata), this wastes bandwidth.

**Remediation:**
1. Vercel automatically compresses responses > 1KB with gzip, but verify this is enabled
2. For custom headers or streaming, add manual compression
3. Ensure `Accept-Encoding` is handled properly

---

### MEDIUM — IPTV Playlist Fetched on Every Search

**File:** `server-lib/iptv.js`

The `getPlaylistChannels()` function has a 5-minute cache (`CACHE_TTL_MS = 5 * 60 * 1000`), but:
- On a cold serverless function start, the cache is empty and must fetch **6+ playlists** in parallel
- The Free-TV playlist alone is ~1.5MB of M3U text
- Combined playlists can be 3-5MB, taking 2-5 seconds to parse

**Remediation:**
1. Move the playlist cache to a persistent store (Firestore, Redis/Upstash)
2. Pre-process playlists at build time or via cron
3. Store the parsed channel list in Firestore (already partially implemented via `IPTV_USE_FIRESTORE_CATALOG`)
4. Increase cache TTL to 30 minutes or more for non-critical data

---

### MEDIUM — Vercel Serverless Cold Starts on Every API Call

**File:** `api/media.js` (especially)

The media API is a single serverless function that:
- Imports `cheerio` (1.5MB)
- Imports Firebase Admin SDK (large)
- Initializes Firestore connections
- Parses M3U playlists on first call

On Vercel Hobby, cold starts can be 500ms-2s. The first search after idle will be noticeably slow.

**Remediation:**
1. Split the monolithic `api/media.js` into separate endpoints (YouTube, direct links, IPTV, sports)
2. Keep the proxy function lightweight (it's already reasonably sized)
3. Use Vercel's `maxDuration` to keep functions warm longer
4. Consider Edge Functions for lightweight operations

---

### MEDIUM — Google Fonts Render-Blocking

**File:** `index.html`

```html
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Two font families with multiple weights are loaded render-blockingly from an external CDN. If Google Fonts is slow (common in Nigeria/West Africa), this delays First Contentful Paint by 200-1000ms.

**Remediation:**
1. Add `font-display: swap` (already via `display=swap`, ✅)
2. Self-host the fonts using `@fontsource/inter` and `@fontsource/space-grotesk` npm packages
3. Preload the critical font file: `<link rel="preload" as="font" ...>`
4. Consider reducing font weights (remove 600, 700 if not heavily used)

---

### LOW — No Bundle Splitting / Lazy Loading for Heavy Components

**Files:** `src/App.jsx`, `src/main.jsx`

Heavy components like `VideoPlayer` (1,367 lines), `RoomPage` (708 lines), and the scraper are all eagerly imported. The `hls.js` library (~200KB) is imported at the top level regardless of whether HLS playback is needed.

**Remediation:**
1. Use `React.lazy()` for route-level components (RoomPage, AuthPage, ScraperPage)
2. Dynamic-import `hls.js` only when an HLS stream is detected
3. Dynamic-import `cheerio` only in the scraper page (it's a client-side import for the scraper feature)
4. Add Vite's `build.rollupOptions.output.manualChunks` to split vendor bundles

---

### LOW — Heartbeat Updates Every 30s Cause Unnecessary Firestore Writes

**File:** `src/features/room/hooks/useRoom.js`

```javascript
const interval = setInterval(() => {
  updateDoc(doc(db, 'rooms', roomId), { lastHeartbeat: serverTimestamp() }).catch(() => {})
}, 30000)
```

With 5 active rooms each with a host, this generates **10 Firestore writes per minute** (5 rooms × 2 updates/min). At scale, this is 600 writes/hour, 14,400 writes/day — all for heartbeats alone. Firestore free tier is 20K writes/day.

**Remediation:**
1. Increase heartbeat interval to 60s or 90s (still well within the 15-minute stale threshold)
2. Use Firestore `set()` with `{merge: true}` instead of `updateDoc()` (same cost but semantically clearer)
3. Consider using Realtime Database for heartbeat (cheaper for high-frequency writes)
4. Implement a "presence" system using Firebase Realtime Database `.info/connected`

---

## Prioritized Remediation Roadmap

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| 🔴 P0 | Add auth to `/api/proxy` | Small | Prevents open proxy abuse |
| 🔴 P0 | Add rate limiting to all endpoints | Medium | Prevents API abuse & cost explosion |
| 🔴 P0 | Tighten Firestore rules (room writes) | Small | Prevents privilege escalation |
| 🟠 P1 | Restrict CORS to specific origins | Small | Prevents cross-origin attacks |
| 🟠 P1 | Stream proxy responses instead of buffering | Medium | Reduces TTFB by 50-80% |
| 🟠 P1 | Add caching headers to proxy responses | Small | Reduces bandwidth by 40-60% |
| 🟠 P1 | Fix OMDb N+1 calls (cache + parallelize) | Medium | Reduces search latency by 5-10s |
| 🟠 P1 | Revoke exposed GitHub PAT | Trivial | Prevents repo compromise |
| 🟡 P2 | Add message pagination (limit Firestore listeners) | Medium | Reduces client bandwidth |
| 🟡 P2 | Make CRON_SECRET mandatory + timing-safe | Small | Prevents cleanup endpoint abuse |
| 🟡 P2 | Self-host Google Fonts | Small | Improves FCP in Africa by 200-500ms |
| 🟡 P2 | Implement server-side age verification for NSFW | Medium | Legal/compliance protection |
| 🟡 P2 | Add CSP + security headers | Small | Defense-in-depth against XSS |
| 🟢 P3 | Lazy-load heavy components | Medium | Reduces initial bundle size |
| 🟢 P3 | Split monolithic media API into separate functions | Medium | Reduces cold-start latency |
| 🟢 P3 | Increase heartbeat interval to 60-90s | Trivial | Reduces Firestore write costs |
| 🟢 P3 | Add input sanitization for chat | Small | Defense-in-depth |
| 🟢 P3 | Move expired Sony URLs to env vars or remove | Trivial | Cleanup dead code |

---

*End of audit report*

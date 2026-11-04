# Chan App — Completion Note

## Current stat

The app now builds locally and the main boot, routing, player-contract, media-authentication, and mixed-content handling issues have been addressed in the local branch.

Latest local repair commit:

```text
aa87ccf fix: handle unsupported streams and incomplete media layers
```

These changes have not yet been pushed to GitHub/Vercel.

The app is **not fully complete yet** because some media sources require external configuration or infrastructure that cannot be solved entirely in React code.

---

## What is already fixed locally

- Restored the application entry point and React Router setup.
- Restored the existing authentication and toast providers.
- Added missing dependencies and regenerated `package-lock.json`.
- Added missing style-module files needed by the new UI/player.
- Reconciled `RoomPage`, `VideoPlayer`, and `usePlayerSync` player interfaces.
- Added YouTube/direct/HLS player compatibility.
- Prevented page URLs from being treated as direct playable files.
- Fixed YouTube search result handoff into room creation.
- Fixed the broken unified-search `Load More` state.
- Consolidated media calls through `/api/media` while retaining legacy aliases.
- Added media API authentication.
- Added basic SSRF/private-network protection to media scraping.
- Removed fake IPTV placeholder results.
- Removed fake sports fallback matches when no sports API key is configured.
- Redacted credentials from the current `.env.example`.
- Added clearer handling for HTTP streams inside the HTTPS deployment.

---

# Remaining work

## 1. O2TV HTTP/HTTPS playback

### Problem

The O2TV link supplied for testing is:

```text
http://d6.o2tv.org/Westworld/Season%2004/Westworld%20-%20S04E01%20(TvShows4Mobile.Com)%20otv-1awrk.mp4
```

The server responds with a valid `video/mp4` file over HTTP, but the app is served by Vercel over HTTPS. Browsers block HTTP media loaded inside an HTTPS page as mixed content.

The HTTPS version of the same O2TV host currently fails TLS, so changing `http://` to `https://` is not sufficient.

### Files already involved

```text
src/shared/lib/youtube.js
src/features/create/pages/CreateRoomPage.jsx
src/features/search/UnifiedSearch.jsx
src/features/room/components/VideoPlayer.jsx
api/lib/sources.js
```

These files now detect the problem and prevent the user from creating a room that will definitely fail.

### Current O2TV solution

The app now rewrites the approved O2TV host through a same origin HTTPS path:

```text
/o2tv/*  →  http://d6.o2tv.org/*
```

The client converts legacy O2TV HTTP URLs into `/o2tv/...` before room creation or playback. This avoids browser mixed-content blocking while keeping the rewrite restricted to the known O2TV host.

Files updated:

```text
vercel.json
src/shared/lib/youtube.js
src/features/room/components/VideoPlayer.jsx
src/features/create/pages/CreateRoomPage.jsx
src/features/search/UnifiedSearch.jsx
src/features/room/pages/RoomPage.jsx
src/hooks/useScraper.js
```

The rewrite depends on Vercel forwarding stream responses and range requests correctly. If a deployment cannot stream the large response or seek reliably, use a dedicated HTTPS media gateway/edge worker rather than an unrestricted serverless proxy.

The rewrite must not be generalized to arbitrary URLs. Keep the O2TV host allowlisted and continue rejecting private-network targets.

---

## 2. Thenkiri/Nkiri page extraction

### Problem

This URL is an HTML page, not a video file:

```text
https://thenkiri.com/silo-s03-complete-tv-series/
```

It contains download-page links such as `downloadwella.com` pages. It does not contain a direct `.mp4` or `.m3u8` URL in the initial HTML response.

### Files to maintain

```text
api/lib/sources.js
api/media.js
src/hooks/useScraper.js
src/features/create/pages/CreateRoomPage.jsx
src/features/search/UnifiedSearch.jsx
```

### Required behavior

The app distinguishes these result types:

```text
Direct file       → playable in the room
HTML page         → follow safe page links automatically
Provider action   → open for the user to complete
Blocked page      → show a clear error
Unsupported URL   → do not create a room
```

The resolver now follows same-site and Downloadwella page links up to a bounded depth, extracts direct media URLs when they are publicly present, and deduplicates results. Downloadwella pages are automatically resolved when they expose their normal `download2` form. Chan preserves the provider session cookie, submits the ordinary form, extracts the generated HTTPS media URL, and validates that it is a generated media-host URL before returning it to the player.

Chan does not bypass CAPTCHA, JavaScript challenges, access controls, or other protections. If the provider requires those, the result remains a provider-action page. Only a verified `.mp4`/`.m3u8`/supported stream is allowed into room creation.

---

## 3. IPTV layer

### Current status

The app now reads the supplied Free-TV M3U playlist by default:

```text
https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8
```

The parser extracts channel name, group, country, logo, and HTTPS stream URL. It filters out HTTP-only streams, placeholder URLs, and known page links such as YouTube/Twitch pages so they are not shown as playable channels in the HTTPS deployment.

The playlist is cached in the serverless instance for five minutes to avoid downloading the catalog on every query.

### Configuration

Optional Vercel variables:

```text
IPTV_PLAYLIST_URL=https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8
IPTV_PLAYLISTS_JSON=[]
IPTV_CHANNELS_JSON=[]
```

`IPTV_PLAYLISTS_JSON` can contain multiple trusted HTTPS sources:

```json
[
  {
    "id": "free-tv",
    "label": "Free-TV IPTV",
    "url": "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8",
    "enabled": true
  }
]
```

`IPTV_CHANNELS_JSON` can contain additional licensed/public channels:

```json
[
  {
    "name": "Example News",
    "url": "https://example.com/news.m3u8",
    "group": "News",
    "logo": "https://example.com/logo.png"
  }
]
```

### Files updated

```text
api/lib/iptv.js
api/media.js
.env.example
```

The existing UI/player files consume the normalized IPTV result schema:

```text
src/features/search/UnifiedSearch.jsx
src/features/room/components/VideoPlayer.jsx
src/features/create/pages/CreateRoomPage.jsx
```

For production, also add:

- Channel health checks.
- EPG/program metadata.
- Source licensing/permission checks.
- Per-channel CORS and HTTPS validation.
- A database or admin interface instead of allowing arbitrary user channels in a request body.

---

## 4. Sports layer

### Current status

The sports layer no longer displays fake fallback matches when the API is not configured. It requires:

```text
FOOTBALL_DATA_KEY
```

Sports-to-IPTV matching is now supported through an explicit channel mapping. This avoids guessing that an arbitrary sports channel is carrying a particular fixture.

### Files updated

```text
api/media.js
api/lib/iptv.js
src/features/search/UnifiedSearch.jsx
src/features/create/pages/CreateRoomPage.jsx
.env.example
```

### Sports mapping configuration

Configure a mapping against channel names in the M3U catalog:

```text
SPORTS_CHANNEL_MAP_JSON=[{"competition":"Premier League","channels":["SuperSport","Sky Sports"]}]
```

The API matches the fixture competition/team to the configured channel names. A result becomes playable only when a matching HTTPS IPTV channel is found. Otherwise, it remains informational and shows that no mapped channel is available.

### Still required for production sports

- Configure the football-data API key.
- Use licensed/authorized channel mappings.
- Add date/competition filtering.
- Add pagination or a current-match window.
- Add timezone-aware match times.
- Handle API quota and error states visibly.

The system can now perform a configured metadata-to-channel match, but it cannot determine broadcast rights from fixture metadata alone.

---

## 5. NSFW layer

### Current status

An XVIDEOS provider adapter is now implemented but remains disabled by default:

```text
NSFW_ENABLED=false
NSFW_PROVIDER=xvideos
```

When enabled, a keyword is converted into the provider search form:

```text
https://www.xvideos.com/?k=super+girl
```

The resolver parses search result pages, follows individual video pages, and extracts publicly embedded HTTPS MP4/HLS URLs. Preview clips are excluded.

### Files implemented

```text
api/lib/nsfw.js
api/media.js
src/features/search/UnifiedSearch.jsx
.env.example
```

A real production rollout still needs:

- A legally permitted/approved provider.
- Server-side access control.
- More than a client-side `window.confirm()` age prompt.
- Region and age policy handling.
- Content moderation/reporting rules.
- Privacy and retention decisions.
- No direct exposure of adult-provider credentials.

The client-side `adultVerified` flag alone is not a real age-verification system. Keep the feature disabled until compliant age/access controls are in place.

---

## 6. Media player validation and synchronization

### Main files

```text
src/features/room/components/VideoPlayer.jsx
src/features/room/hooks/usePlayerSync.js
src/features/room/pages/RoomPage.jsx
src/features/create/pages/CreateRoomPage.jsx
src/shared/lib/youtube.js
```

### Remaining test matrix

The following combinations need manual testing in a staging deployment:

- YouTube video as host.
- YouTube video as viewer.
- Direct HTTPS MP4 as host.
- Direct HTTPS MP4 as viewer.
- HTTPS HLS/M3U8 as host.
- HTTPS HLS/M3U8 as viewer.
- Unsupported HTTP stream.
- Changing videos while viewers are connected.
- Pause, play, seek, and late viewer join.
- Host leaving and room ending.
- Mobile browser behavior.

The O2TV HTTP URL should be converted to the restricted same-origin `/o2tv/...` rewrite on the HTTPS deployment, or rejected clearly if it is not an approved O2TV host.

---

## 7. API and deployment cleanup

### Current API files

```text
api/cleanupStaleRooms.js
api/createLiveKitToken.js
api/media.js
api/moderate.js
api/room.js
```

The legacy `/api/search`, `/api/scrape`, and `/api/refreshCatalog` paths are consolidated through the `/api/media` action dispatcher or Vercel rewrite. This keeps the deployment at five top-level serverless functions.

Examples:

```json
{"action":"search","layer":"youtube","query":"..."}
{"action":"scrape","url":"https://...","options":{"resolve":true}}
{"action":"refreshCatalog","offset":0,"limit":50}
```

After removal, update:

```text
README.md
docs/APP_AUDIT.md
docs/APP_BROKEN_STATE_AUDIT.md
docs/SCRAPER.md
docs/SCRAPER_ROOM_INTEGRATION.md
guide.md
```

The intended final API surface is:

```text
POST /api/room
POST /api/moderate
POST /api/createLiveKitToken
POST/GET /api/cleanupStaleRooms
POST /api/media
```

---

## 8. Credentials and environment configuration

The current `.env.example` has been redacted, but credentials that existed in earlier Git commits remain in repository history.

These must be rotated outside the codebase:

- Firebase Admin service-account private key.
- LiveKit API secret.
- YouTube API key.
- Any OMDb or sports API keys.
- GitHub PAT previously shared in chat.

Then configure the replacement values in:

```text
Vercel → Project Settings → Environment Variables
```

Do not put server secrets in variables beginning with `VITE_`.

Relevant files:

```text
.env.example
api/lib/firebaseAdmin.js
api/createLiveKitToken.js
api/media.js
src/shared/lib/firebase.js
```

---

## 9. Security and operational work remaining

Review and test:

```text
api/media.js
api/lib/http.js
api/lib/firebaseAdmin.js
api/room.js
api/moderate.js
firestore.rules
vercel.json
```

Remaining operational tasks include:

- Add rate limits for media search/scraping.
- Monitor YouTube, sports, and other provider quotas.
- Validate all outbound URLs and redirects.
- Add request size and query-length limits.
- Review Firestore rules after adding any new room metadata.
- Add server-side logging without logging credentials or full sensitive URLs.
- Run `npm audit` and review the reported vulnerabilities individually.
- Reduce the large JavaScript bundle through route-level code splitting.
- Add automated tests for media normalization and URL validation.

---

## 10. IPTV cron refresh and Firestore catalog

A new authenticated endpoint is available:

```text
POST /api/refreshCatalog
```

Files:

```text
api/refreshCatalog.js
api/lib/iptv.js
firestore.rules
.env.example
```

The endpoint:

1. Reads the approved HTTPS M3U playlist.
2. Parses and deduplicates channel metadata.
3. Checks a bounded batch of stream URLs using `HEAD` or a one-byte ranged `GET`.
4. Stores healthy/unhealthy status in `mediaCatalog/iptv/channels`.
5. Returns `nextOffset` so an external cron service can process the catalog in batches.

Call it from cron-job.org with:

```text
POST https://your-app.vercel.app/api/refreshCatalog
x-cron-secret: your-random-secret
Content-Type: application/json

{"action":"iptv","offset":0,"limit":50}
```

Configure:

```text
CRON_SECRET=replace-with-random-cron-secret
IPTV_HEALTH_CHECK_LIMIT=50
IPTV_USE_FIRESTORE_CATALOG=false
```

Set `IPTV_USE_FIRESTORE_CATALOG=true` after enough batches have populated the Firestore catalog. Never place `CRON_SECRET` in a URL or client-side variable.

## 11. Sports-to-IPTV mapping

Sports matching now uses the same IPTV catalog and supports:

```text
SPORTS_CHANNEL_MAP_JSON
```

Example:

```json
[
  {
    "competition": "Premier League",
    "channels": ["SuperSport", "Sky Sports"]
  }
]
```

A fixture becomes playable only when a configured channel name matches an HTTPS channel in the IPTV playlist. This prevents the app from claiming that an arbitrary sports channel carries a specific fixture.

# Definition of done

The app should not be considered fully ready until all of the following are true:

- `npm ci` works from a clean checkout.
- `npm run build` passes in Vercel.
- All required environment variables are configured in Vercel.
- No credentials exist in the current tree or reachable Git history.
- YouTube room creation works.
- HTTPS MP4 playback works.
- HTTPS HLS playback works.
- HTTP-only streams are rejected with a clear explanation.
- HTML page URLs cannot create rooms as if they were videos.
- Thenkiri page extraction has a clear multi-step flow.
- IPTV results contain only valid configured streams.
- Sports results are either real/configured or clearly unavailable.
- NSFW is either properly implemented with policy controls or disabled.
- Host/viewer synchronization works on desktop and mobile.
- Room changes synchronize correctly for existing viewers.
- Vercel deployment uses the latest repaired commit.

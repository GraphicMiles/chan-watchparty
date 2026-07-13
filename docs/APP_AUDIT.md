# Chan — Full Application Audit
hry
**Audit date:** 2026-07-12  
**Git HEAD at audit:** `7c9ed16` (`Refactor export of ScraperPage component`)  
**Scope:** Read-only inventory of every folder, file, export/import graph, runtime interactions, and observed bugs.  
**Actions taken for this doc:** `git pull` only + file inspection. **No application source was modified or deleted for this audit.**

---

## 1. What the app is

**Chan** is a real-time watch-party web app:

- Anonymous Firebase Auth  
- Create/join rooms around **YouTube** video (host/co-host authoritative sync)  
- Optional **LiveKit** screen share  
- Room chat (typing, replies, reactions)  
- Host moderation (kick / promote / mute / lock)  
- Secondary **media search/scrape UI** at `/media` (currently wired to newer `/api/scrape` + `/api/search`, not `/api/media`)

**Stack**

| Layer | Tech |
|-------|------|
| SPA | React 18 + Vite + react-router-dom |
| Hosting | Vercel (SPA rewrites + serverless `/api/*`) |
| Auth / DB | Firebase Anonymous Auth + Firestore |
| Video | YouTube IFrame (`react-youtube`) |
| Screen share SFU | LiveKit Cloud (`livekit-client`) |
| HTML parse | Cheerio (`api/lib/scraper.js`, `api/scrape.js`) |

---

## 2. Repository tree (source of truth)

```
Chan/
├── api/                          # Vercel serverless entrypoints (each *.js at top level = 1 function)
│   ├── cleanupStaleRooms.js
│   ├── createLiveKitToken.js
│   ├── media.js                  # Consolidated search|scrape (older design)
│   ├── moderate.js               # kick|promote|mute
│   ├── room.js                   # join|leave|end
│   ├── scrape.js                 # Newer scrape endpoint (movie-site selectors)
│   ├── search.js                 # Newer YouTube search endpoint
│   └── lib/                      # Shared server modules (NOT separate Vercel functions)
│       ├── firebaseAdmin.js
│       ├── http.js
│       ├── response.js
│       └── scraper.js
│
├── src/
│   ├── main.jsx                  # React mount
│   ├── App.jsx                   # Providers + routes
│   ├── index.css                 # Globals (imports theme)
│   ├── styles/theme.css          # Design tokens
│   ├── components/               # Loose/global components (partially orphan)
│   │   └── Scraper.jsx
│   ├── hooks/                    # Loose global hooks
│   │   └── useScraper.js
│   ├── features/                 # Feature-sliced product areas
│   │   ├── auth/
│   │   ├── home/
│   │   ├── create/
│   │   ├── room/
│   │   └── scraper/
│   └── shared/                   # Cross-feature
│       ├── auth/
│       ├── components/
│       ├── layout/
│       ├── lib/
│       ├── ui/
│       └── utils/
│
├── docs/
│   ├── DEVELOPER_GUIDE.md        # Prior guide (may be partially stale vs HEAD)
│   └── APP_AUDIT.md              # This file
├── firestore.rules
├── vercel.json
├── vite.config.js
├── package.json
├── index.html
└── README.md
```

---

## 3. Runtime architecture

```
Browser
  main.jsx
    → App.jsx
         AuthProvider (Firebase Auth + users/{uid})
         ToastProvider
         BrowserRouter
         ConnectionBanner
         Routes → feature pages

Pages talk to:
  • Firestore directly (client SDK) for listeners + allowed writes
  • Vercel /api/* for capacity, moderation, LiveKit tokens, media tools

Server
  api/*.js  →  api/lib/*  →  Firestore Admin / LiveKit JWT / external HTTP
```

### 3.1 Provider stack (outer → inner)

| Order | Component | File | Provides |
|------:|-----------|------|----------|
| 1 | `AuthProvider` | `src/shared/auth/hooks/useAuth.jsx` | `user`, `loading`, `signInAnonymously`, `updateDisplayName`, `logout` |
| 2 | `ToastProvider` | `src/shared/ui/Toast.jsx` | `useToast()` → `{ toast, dismiss }` |
| 3 | `BrowserRouter` | `react-router-dom` | routing |
| 4 | `ConnectionBanner` | `src/shared/components/ConnectionBanner.jsx` | offline strip |
| 5 | `Routes` | `src/App.jsx` | pages |

### 3.2 Routes

| Path | Component | Imported via |
|------|-----------|--------------|
| `/` | `HomePage` | `features/home/index.js` |
| `/auth` | `AuthPage` | `features/auth/index.js` |
| `/create` | `CreateRoomPage` | `features/create/index.js` |
| `/room/:roomId` | `RoomPage` | `features/room/index.js` |
| `/media` | `ScraperPage` | `features/scraper/index.js` |

Query params of note:

- `/room/:roomId?invite=CODE` — private join  
- `/create?video=ID&title=…` — preset YouTube from media handoff (CreateRoom supports this)

---

## 4. Vercel serverless functions

**Hobby cap:** 12 functions.  
**Current top-level handlers:** **7**

| # | File | Route | Response style | Used by client? |
|---|------|-------|----------------|-----------------|
| 1 | `api/room.js` | `POST /api/room` | `sendResponse` via `http.js` | **Yes** — useRoom, Home, Create |
| 2 | `api/moderate.js` | `POST /api/moderate` | same | **Yes** — useRoom authFetch |
| 3 | `api/createLiveKitToken.js` | `POST /api/createLiveKitToken` | same | **Yes** — ScreenShare |
| 4 | `api/cleanupStaleRooms.js` | `POST/GET /api/cleanupStaleRooms` | same | External cron only |
| 5 | `api/media.js` | `POST /api/media` | same | **No live UI caller found** |
| 6 | `api/scrape.js` | `POST /api/scrape` | **Express-style** `res.status().json()` | **Yes** — `useScraper` |
| 7 | `api/search.js` | `POST /api/search` | **Express-style** | **Yes** — `useScraper` |

`api/lib/*` does **not** count as separate functions.

### 4.1 `api/room.js`

**Export:** `default handler`  
**Imports:** `getDb`, `FieldValue` ← `lib/firebaseAdmin.js`; `preflight`, `ok`, `fail`, `statusForError` ← `lib/http.js`

| `body.action` | Behavior |
|---------------|----------|
| `join` | Resolve room by id or invite; enforce live/locked/private/capacity; create `participants/{uid}`; increment `participantCount` |
| `leave` | Delete participant; decrement count |
| `end` | Host-only; `status: ended`, `activityType: idle` |

### 4.2 `api/moderate.js`

**Export:** `default handler`  
**Auth:** `Authorization: Bearer <idToken>` → `verifyIdToken`  
**Imports:** firebaseAdmin + http  

| `body.action` | Who | Effect |
|---------------|-----|--------|
| `kick` | host | delete participant, decrement count, remove from `coHosts` |
| `promote` | host | set role `co-host`/`viewer`; arrayUnion/Remove `coHosts` |
| `mute` | host or co-host | set `participants/{uid}.muted` |

### 4.3 `api/createLiveKitToken.js`

**Imports:** `jsonwebtoken`, `getDb`, http helpers  
**Body:** `{ roomId, uid, role }`  
**Rule:** `canPublish: true` only if `uid === room.hostId` (role `host` spoof rejected)

### 4.4 `api/cleanupStaleRooms.js`

**Query:** `status == 'live' AND lastHeartbeat < now-15m`  
**Optional:** `x-cron-secret` vs `CRON_SECRET`  
**Needs:** Firestore composite index on `rooms (status, lastHeartbeat)`

### 4.5 `api/media.js` (consolidated, currently unused by UI)

**Imports:** firebaseAdmin, http, `scraper` from `lib/scraper.js`  
**Actions:** `search` (YouTube API), `scrape` (metadata list via Cheerio site configs — imdb in lib)  
**May write** `scrapes/{id}` when `roomId` provided  

### 4.6 `api/scrape.js` (active UI path)

**Export:** `default handler`  
**Does:** fetch HTML, Cheerio parse, site configs for `nkiri`, `netnaija`, `fzmovies`, `imdb`  
**Response:** `res.status(200).json(...)` — **incompatible with Vercel Node response API** (see bugs)  
**Does not** use `api/lib/http.js` or `sendResponse`

### 4.7 `api/search.js` (active UI path)

**Export:** `default handler`  
**Does:** YouTube Data API search using `process.env.VITE_YOUTUBE_API_KEY`  
**Response:** same Express-style pattern as scrape  

### 4.8 `api/lib/*`

| File | Exports | Role |
|------|---------|------|
| `response.js` | `sendResponse(res, status, body, headers)` | `writeHead` + `end` |
| `http.js` | `JSON_HEADERS`, `preflight`, `ok`, `fail`, `statusForError` | shared CORS + status mapping |
| `firebaseAdmin.js` | `getDb`, `getAuthClient`, `verifyIdToken`, `FieldValue`, `Timestamp` | Admin SDK |
| `scraper.js` | `MediaScraper`, `scraper` | Cheerio helpers used by **`media.js` only** |

---

## 5. Frontend feature map

### 5.1 `src/main.jsx`

- Imports `App`, `index.css`  
- Renders `<App />` in `#root` under `StrictMode`

### 5.2 `src/App.jsx`

**Imports**

| Import | From |
|--------|------|
| `AuthProvider` | `shared/auth/hooks/useAuth.jsx` |
| `ToastProvider` | `shared/ui/index.js` |
| `ConnectionBanner` | `shared/components/ConnectionBanner.jsx` |
| `AuthPage` | `features/auth` |
| `HomePage` | `features/home` |
| `CreateRoomPage` | `features/create` |
| `RoomPage` | `features/room` |
| `ScraperPage` | `features/scraper` |

**Export:** `default App`

---

### 5.3 Feature: `auth`

| File | Export | Imports |
|------|--------|---------|
| `features/auth/index.js` | `{ AuthPage }` | `./pages/AuthPage.jsx` |
| `pages/AuthPage.jsx` | `default AuthPage` | `useAuth`, UI `Button/Input/Card` |
| `pages/AuthPage.module.css` | CSS module | — |

**Flow:** display name → `signInAnonymously` → navigate `/`  
**Redirect:** `useEffect` when `user` set (not during render)

---

### 5.4 Feature: `home`

| File | Export | Imports |
|------|--------|---------|
| `index.js` | `{ HomePage }` | pages |
| `pages/HomePage.jsx` | `default` | `useAuth`, Firestore `rooms`, `parseJsonResponse`, UI kit, `Header/Layout`, `RoomCard`, `getLastRoom` from room hook |
| `components/RoomCard.jsx` | `default` | `Link`, `getThumbnail`, `Card/Badge/Avatar`, `SyncPulse` |

**APIs:** `POST /api/room` `{ action: 'join', inviteCode, uid, displayName }`  
**Firestore:** `onSnapshot(collection(db,'rooms'))` filter live + public  
**UI:** search, sort, skeletons, continue watching, link to `/media`

---

### 5.5 Feature: `create`

| File | Export | Imports |
|------|--------|---------|
| `index.js` | `{ CreateRoomPage }` | pages |
| `pages/CreateRoomPage.jsx` | `default` | Firestore setDoc, `useAuth`, `youtube.js`, `parseJsonResponse`, UI, `useSearchParams` |

**Writes**

1. `rooms/{roomId}` (host, title, video, private, coHosts, locked, capacity, …)  
2. `playerState/current`  
3. `POST /api/room` `{ action: 'join', ... }` as host  

**Preset:** `?video=` / `?title=` from media handoff

---

### 5.6 Feature: `room` (core)

```
features/room/
├── index.js                    → export RoomPage
├── pages/RoomPage.jsx          → orchestrator
├── hooks/useRoom.js            → lifecycle + listeners + API
├── hooks/usePlayerSync.js      → playback sync
├── services/livekit.js         → LiveKit client helpers
└── components/
    ├── VideoPlayer.jsx
    ├── ScreenShare.jsx
    ├── Chat.jsx / ChatMessage.jsx
    ├── ParticipantList.jsx
    └── ShareRoom.jsx
```

#### `useRoom.js`

**Exports:** `useRoom`, `getLastRoom`  
**Imports:** Firestore, `useAuth`, `parseJsonResponse`

| Method | Endpoint / path |
|--------|-----------------|
| `join` | `POST /api/room` action join |
| `leave` | `POST /api/room` action leave |
| `endRoom` | `POST /api/room` action end |
| `kickParticipant` | `POST /api/moderate` action kick + Bearer |
| `promoteParticipant` | moderate promote |
| `muteParticipant` | moderate mute |
| `sendMessage` | client `addDoc` messages |
| `updateRoom` | client `updateDoc` room |
| `setTyping` | client typing/{uid} |

**Listeners:** room doc, participants, messages (orderBy createdAt), typing  
**Side effects:** host heartbeat 30s; join on mount; leave on unmount (`keepalive`)

#### `usePlayerSync.js`

**Export:** `usePlayerSync`  
**Returns:** `{ writePlayerState, isHost, isCoHost, canControl }`  
**Writes:** `playerState/current` if host or co-host  
**Heartbeat:** 5s  
**Viewers:** onSnapshot + 1.5s drift seek + visibility resync  

#### Components (room)

| Component | Export | Key imports | Role |
|-----------|--------|-------------|------|
| `RoomPage` | default | useRoom, usePlayerSync, all room components, Layout, Modal, toast | Shell |
| `VideoPlayer` | default | `react-youtube` | YT embed; controls if host-like |
| `ScreenShare` | default | livekit.js, `createLiveKitToken` API | SFU publish/subscribe |
| `Chat` | default | ChatMessage, UI | chat UX |
| `ChatMessage` | default | Firestore reactions subcollection | message + react |
| `ParticipantList` | default | Avatar, SyncPulse | roster + host actions |
| `ShareRoom` | default | qrcode, Modal, toast | invite link/QR |

#### `services/livekit.js`

**Exports:** `LIVEKIT_URL`, `isDisplayMediaSupported`, `createRoom`, `connectToLivekit`, `publishScreenShare`, `publishCameraShare`, `getHostVideoTrack`

---

### 5.7 Feature: `scraper` + loose media UI

| File | Export | Imports | Notes |
|------|--------|---------|-------|
| `features/scraper/index.js` | `{ ScraperPage }` | `./ScraperPage` | barrel for App |
| `features/scraper/ScraperPage.jsx` | **named** `ScraperPage` | `../../hooks/useScraper` | Route page; **inline styles**; no CSS module |
| `hooks/useScraper.js` | `useScraper` | react only | Calls **`/api/scrape`** + **`/api/search`** |
| `components/Scraper.jsx` | named `Scraper` | `../hooks/useScraper` | **Orphan** — not imported by App or ScraperPage |

**`useScraper` API surface**

```
{ scrape, search, results, loading, error, clear }
```

**Not used:** older `POST /api/media` consolidated endpoint.

---

## 6. Shared layer

### 6.1 `shared/lib`

| File | Exports | Consumers |
|------|---------|-----------|
| `firebase.js` | `auth`, `db` | auth, home, create, room hooks/components |
| `youtube.js` | `extractVideoId`, `getVideoMetadata`, `searchVideos`, `getThumbnail` | create, home RoomCard, RoomPage |
| `api.js` | `parseJsonResponse` | home, create, useRoom, ScreenShare |

### 6.2 `shared/auth`

| Export | File |
|--------|------|
| `AuthProvider`, `useAuth` | `hooks/useAuth.jsx` |

Uses `friendlyAuthError` from utils.

### 6.3 `shared/ui` (barrel `index.js`)

| Export | File |
|--------|------|
| `Button` | Button.jsx (+ Spinner when loading) |
| `Input` | Input.jsx |
| `Card` | Card.jsx |
| `Avatar` | Avatar.jsx (+ avatarColor) |
| `Badge` | Badge.jsx |
| `Spinner` | Spinner.jsx |
| `EmptyState` | EmptyState.jsx |
| `IconButton` | IconButton.jsx |
| `Modal` | Modal.jsx (Card, IconButton) |
| `ToastProvider`, `useToast` | Toast.jsx |
| `Skeleton` | Skeleton.jsx |

### 6.4 `shared/layout`

| Export | File |
|--------|------|
| `Header` | Header.jsx (Link, Avatar, cn) |
| `Layout` | Layout.jsx |

### 6.5 `shared/components`

| Export | File | Used by |
|--------|------|---------|
| `SyncPulse` | SyncPulse.jsx | RoomCard, RoomPage, ParticipantList |
| `ConnectionBanner` | ConnectionBanner.jsx | App |

### 6.6 `shared/utils`

| Export | File |
|--------|------|
| `cn` | cn.js |
| `avatarColor` | avatarColor.js |
| `friendlyAuthError` | authErrors.js |

### 6.7 Styles

| File | Role |
|------|------|
| `styles/theme.css` | CSS variables (surfaces, accents, fonts, legacy Depth/Ash aliases) |
| `index.css` | `@import theme`; resets; `.sync-pulse`; reduced-motion; focus-visible |
| `index.html` | Google fonts: Bricolage Grotesque, IBM Plex Sans/Mono |

---

## 7. Import / export interaction diagrams

### 7.1 Auth path

```
AuthPage
  → useAuth().signInAnonymously
       → firebaseSignInAnonymously(auth)
       → updateProfile
       → setDoc users/{uid}
       → friendlyAuthError on failure
  → navigate('/')
```

### 7.2 Create → Join → Room

```
CreateRoomPage
  → setDoc rooms/{id}
  → setDoc playerState/current
  → POST /api/room { action:'join' }
  → navigate /room/:id

RoomPage
  → useRoom(roomId, invite)
       → listeners + POST /api/room join if needed
  → usePlayerSync → playerState
  → VideoPlayer | ScreenShare
  → Chat / ParticipantList / ShareRoom
```

### 7.3 Screen share

```
RoomPage switchActivity('screenshare')
  → updateRoom({ activityType })
  → ScreenShare mounts
       → POST /api/createLiveKitToken
       → livekit.createRoom + connect
       → host: publishScreenShare (or camera fallback)
       → viewers: getHostVideoTrack → <video>
```

### 7.4 Moderation

```
ParticipantList button
  → RoomPage handlers
  → useRoom.kick/promote/mute
  → authFetch POST /api/moderate { action, ... }
       → verifyIdToken
       → Firestore transaction
  → participants onSnapshot updates UI
  → kicked user: missing participant doc → error state
```

### 7.5 Media tools (current HEAD)

```
App route /media
  → features/scraper/ScraperPage
       → hooks/useScraper
            → POST /api/search  (YouTube)
            → POST /api/scrape  (site HTML)
  → results UI (inline styles)

ORPHAN parallel path:
  components/Scraper.jsx → same useScraper (never mounted)

DEAD consolidated path:
  api/media.js + api/lib/scraper.js  (no current client import)
```

### 7.6 Chat / reactions

```
Chat → sendMessage → useRoom.addDoc messages
ChatMessage → onSnapshot reactions subcollection
           → setDoc/deleteDoc reactions/{uid}
Typing → useRoom setTyping → typing/{uid}
```

---

## 8. Firestore model (as used in code)

```
users/{uid}
  displayName, anonymous, tier, createdAt

rooms/{roomId}
  hostId, hostName, title, activityType, videoId,
  isPrivate, inviteCode, coHosts[], locked, capacity,
  status, participantCount, createdAt, lastHeartbeat, endedAt?

rooms/{roomId}/playerState/current
  videoId, isPlaying, currentTime, updatedAt, updatedBy

rooms/{roomId}/participants/{uid}
  displayName, role, muted, joinedAt

rooms/{roomId}/messages/{messageId}
  uid, displayName, text, createdAt, replyTo?

rooms/{roomId}/messages/{messageId}/reactions/{uid}
  emoji

rooms/{roomId}/typing/{uid}
  displayName, lastTypedAt

scrapes/{scrapeId}   # written by api/media.js when roomId set; rules: client create false
  roomId, url, site, results, resultCount, createdAt
```

**Rules file:** `firestore.rules` (must be published in Firebase Console; file alone does nothing).

---

## 9. Environment variables

### Client (`VITE_*`)

| Variable | Used in |
|----------|---------|
| `VITE_FIREBASE_*` | `shared/lib/firebase.js` |
| `VITE_YOUTUBE_API_KEY` | `shared/lib/youtube.js`; also `api/search.js` and fallback in `api/media.js` |
| `VITE_LIVEKIT_URL` | `features/room/services/livekit.js` |

### Server

| Variable | Used in |
|----------|---------|
| `FIREBASE_ADMIN_*` | `api/lib/firebaseAdmin.js` |
| `LIVEKIT_API_KEY` / `SECRET` | `createLiveKitToken.js` |
| `CRON_SECRET` | `cleanupStaleRooms.js` |
| `YOUTUBE_API_KEY` | preferred by `api/media.js` (if set) |

---

## 10. Client → API call matrix

| Caller | Method | Path | Body highlights |
|--------|--------|------|-----------------|
| `useRoom.join` | POST | `/api/room` | `action:join` |
| `useRoom.leave` | POST | `/api/room` | `action:leave` |
| `useRoom.endRoom` | POST | `/api/room` | `action:end` |
| unmount leave | POST | `/api/room` | `action:leave` keepalive |
| Home invite join | POST | `/api/room` | `action:join` + inviteCode |
| CreateRoom | POST | `/api/room` | `action:join` after create |
| useRoom kick/promote/mute | POST | `/api/moderate` | Bearer + action |
| ScreenShare | POST | `/api/createLiveKitToken` | roomId, uid, role |
| useScraper.scrape | POST | `/api/scrape` | url, site |
| useScraper.search | POST | `/api/search` | query, source |
| *(none)* | POST | `/api/media` | — unused by UI |
| cron | POST/GET | `/api/cleanupStaleRooms` | optional secret header |

---

## 11. Bug & risk register (observed in code; not fixed in this audit)

Severity: **P0** blocks core path · **P1** feature broken · **P2** quality/ops · **P3** hygiene

| ID | Sev | Area | Finding |
|----|-----|------|---------|
| B1 | **P0/P1** | `api/scrape.js`, `api/search.js` | Use **Express** APIs: `res.status().json()`, `res.setHeader`, `res.end`. Vercel Node serverless expects `res.writeHead` / `res.end` (as documented in `api/lib/response.js`). Same class of bug previously fixed as `res.status(...).set is not a function`. **`/media` search & scrape likely fail at runtime on Vercel.** |
| B2 | **P1** | Media architecture | **Three parallel media implementations:** (1) `api/media.js` + `lib/scraper.js`, (2) `api/scrape.js` + `api/search.js`, (3) client-side `youtube.js` search on Create page. UI only calls (2). Dead code + double maintenance. |
| B3 | **P2** | `src/components/Scraper.jsx` | **Orphan component** — never imported by `App` or `ScraperPage`. Duplicate UI of ScraperPage. |
| B4 | **P2** | Function count | **7** serverless files. Under 12, but rising. Duplicate media endpoints waste 2 slots vs single `media` router. |
| B5 | **P1/P2** | Ops | Anonymous Auth must be **enabled** in Firebase Console or sign-in returns `auth/admin-restricted-operation` (handled in copy only). |
| B6 | **P2** | Ops | Firestore rules in repo may not match Console until manually published. |
| B7 | **P2** | Ops | `cleanupStaleRooms` needs composite index `status + lastHeartbeat` or fails with FAILED_PRECONDITION. |
| B8 | **P2** | `api/search.js` | Depends on `VITE_YOUTUBE_API_KEY` in **server** env. If only set as Vite client var locally, production server may miss it unless duplicated in Vercel env. |
| B9 | **P3** | `ScraperPage` | No CSS module / design system; raw inline styles; inconsistent with rest of app. |
| B10 | **P3** | `useScraper` | No `parseJsonResponse`; assumes JSON always. Non-JSON error pages will throw poorly. |
| B11 | **P2** | Leave on unmount | Room unmount always POSTs leave (including StrictMode double-mount / soft navigations). Can cause flicker rejoin or count churn. |
| B12 | **P3** | `VideoPlayer` | No seek event write to playerState (only play/pause). Host seek may not sync until next 5s heartbeat. |
| B13 | **P3** | `ScreenShare` | Only true host publishes; co-host cannot screen-share even if co-host can control YouTube. |
| B14 | **P2** | Home rooms query | Client loads **all** `rooms` docs then filters. Does not scale; also depends on rules allowing reads of non-live/private (denied) — OK but noisy. |
| B15 | **P3** | Docs drift | `docs/DEVELOPER_GUIDE.md` / README may still describe older 4–5 function layout without `scrape.js`/`search.js` duplicates. |
| B16 | **P2** | Security/product | `api/scrape.js` targets third-party movie listing sites (nkiri, netnaija, fzmovies, imdb). Legal/ToS risk; not integrated into watch sync pipeline (results are links/metadata, not room player binding except YouTube search → external URL). |
| B17 | **P3** | `api/scrape.js` early returns | Commits mention early return for undefined url/query — good — but response path still Express-style. |
| B18 | **P3** | Package | `@livekit/components-react` / styles listed in package.json but **not imported** in audited src (only `livekit-client`). |

---

## 12. What works together (healthy paths)

These paths use the consolidated, `sendResponse`-based APIs:

1. Anonymous auth → home  
2. Create room → join → room page  
3. YouTube play/pause sync (host/co-host)  
4. Chat + typing + reactions (with rules)  
5. Kick/promote/mute via `/api/moderate`  
6. LiveKit token + screen share (desktop)  
7. Share modal / QR  
8. Invite code join via `/api/room`  

---

## 13. Dead / duplicate inventory

| Asset | Status |
|-------|--------|
| `api/media.js` | Implemented; **no client caller** |
| `api/lib/scraper.js` | Used only by `media.js` |
| `src/components/Scraper.jsx` | **Unmounted orphan** |
| `api/scrape.js` + `api/search.js` | Active via `useScraper`, but **broken response API on Vercel** |
| Create page YouTube search | Separate client path via `youtube.js` (works if client key set) |

---

## 14. Dependency map (npm, high level)

| Package | Role in app |
|---------|-------------|
| `react`, `react-dom`, `react-router-dom` | UI + routing |
| `firebase` | Client auth + Firestore |
| `react-youtube` | Player |
| `livekit-client` | Screen share |
| `qrcode` | ShareRoom QR |
| `firebase-admin`, `@google-cloud/firestore` | Server Admin |
| `jsonwebtoken` | LiveKit JWT |
| `cheerio` | HTML parse (media/scrape) |
| Vite + eslint plugins | Tooling |

---

## 15. File checklist (every source file)

### Root / config

| File | Purpose |
|------|---------|
| `package.json` | scripts, deps |
| `package-lock.json` | lockfile |
| `vite.config.js` | Vite + React; port 3000 |
| `vercel.json` | SPA fallback + `/api` pass-through |
| `index.html` | HTML shell + fonts |
| `.env.example` | env key template |
| `.gitignore` | ignores node_modules, dist, .env |
| `firestore.rules` | security rules source |
| `README.md` | deploy / env / rules paste |
| `docs/DEVELOPER_GUIDE.md` | older contributor guide |
| `docs/APP_AUDIT.md` | this audit |

### API (7 + 4 lib)

Listed in §4.

### `src/` features, shared, loose hooks/components

Listed in §5–6.

---

## 16. Suggested mental model for new contributors

1. **Product core** lives under `src/features/room` + `api/room.js` + `api/moderate.js`.  
2. **Auth** is global via `shared/auth`.  
3. **UI primitives** only from `shared/ui`.  
4. **Server must use** `sendResponse` / `http.js` — never Express `res.status().json()`.  
5. **Media tools are currently inconsistent** — UI → scrape/search; older media router unused; scrape/search likely broken on Vercel until rewritten to `sendResponse`.  
6. **Do not add more top-level `api/*.js` files** without consolidating; budget is 12.

---

## 17. Audit limitations

- No live multi-client runtime QA performed in this pass.  
- No Vercel deployment log pull.  
- No confirmation of Firebase Console (Anonymous Auth, published rules, indexes).  
- Analysis is static from repository contents at `7c9ed16`.

---

*End of audit. No application files were modified or deleted to produce this document beyond adding this audit file itself as requested.*

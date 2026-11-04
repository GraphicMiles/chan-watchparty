# Chan — Full site documentation

**Product:** Chan — real-time watch party (YouTube + optional direct video + LiveKit screen share + chat)  
**Stack:** React 18 + Vite · Firebase Anonymous Auth + Firestore · Vercel serverless `/api` · LiveKit · Cheerio (scrape)  
**Deploy:** Vercel Hobby · Firebase Spark  
**This guide describes the repo as of main (includes robust YouTube/scrape UX).**

For a **security watchlist** of high-risk files, see [note.md](./note.md).

---

## Table of contents

1. [Architecture](#1-architecture)  
2. [Repository tree](#2-repository-tree)  
3. [Routes & providers](#3-routes--providers)  
4. [API (serverless)](#4-api-serverless)  
5. [Frontend entry](#5-frontend-entry)  
6. [Features](#6-features)  
7. [Shared layer](#7-shared-layer)  
8. [Import / export graphs](#8-import--export-graphs)  
9. [Firestore model & rules](#9-firestore-model--rules)  
10. [Environment variables](#10-environment-variables)  
11. [Config files](#11-config-files)  
12. [Data flows](#12-data-flows)  
13. [Docs index](#13-docs-index)  

---

## 1. Architecture

```
Browser (SPA on Vercel)
├── Firebase Auth (Anonymous)
├── Firestore listeners (rooms, playerState, chat, participants, typing, reactions)
├── YouTube IFrame (react-youtube)  OR  HTML5 <video> for direct URLs
└── LiveKit client (screen share only)
        │
        ▼
Vercel /api/* (Node)
├── room / moderate / createLiveKitToken / cleanupStaleRooms
├── scrape / search
└── lib: firebaseAdmin, http, response, sources
```

**Design rules**

- Capacity, kick/promote/mute, LiveKit publish rights: **server-side**.  
- Participants: **no client writes** (rules `write: if false`).  
- Vercel responses: `sendResponse` / `ok` / `fail` — not Express `res.status().json()`.  
- Hobby: max **12** functions; this app uses **6** top-level `api/*.js` files.

---

## 2. Repository tree

```
Chan/
├── api/                          # Vercel functions (each top-level *.js = 1 function)
│   ├── cleanupStaleRooms.js
│   ├── createLiveKitToken.js
│   ├── moderate.js
│   ├── room.js
│   ├── scrape.js
│   ├── search.js
│   └── lib/                      # Shared server modules (NOT separate functions)
│       ├── firebaseAdmin.js
│       ├── http.js
│       ├── response.js
│       └── sources.js
│
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── index.css
│   ├── styles/theme.css
│   ├── hooks/
│   │   └── useScraper.js
│   ├── features/
│   │   ├── auth/
│   │   ├── home/
│   │   ├── create/
│   │   ├── room/
│   │   └── scraper/
│   └── shared/
│       ├── auth/
│       ├── components/
│       ├── layout/
│       ├── lib/
│       ├── ui/
│       └── utils/
│
├── docs/                         # Audits & feature notes
├── firestore.rules
├── vercel.json
├── vite.config.js
├── package.json
├── index.html
├── README.md
├── note.md                       # Security watchlist
└── guide.md                      # This file
```

---

## 3. Routes & providers

### 3.1 Mount — `src/main.jsx`

| | |
|--|--|
| **Imports** | `react`, `react-dom/client`, `./App.jsx`, `./index.css` |
| **Does** | Renders `<App />` into `#root` inside `React.StrictMode` |
| **Exports** | none (entry) |

### 3.2 App shell — `src/App.jsx`

| | |
|--|--|
| **Imports** | `BrowserRouter`, `Routes`, `Route` · `AuthProvider` · `ToastProvider` · `ConnectionBanner` · feature barrels |
| **Exports** | `default App` |

**Provider order (outer → inner)**

1. `AuthProvider` — Firebase user  
2. `ToastProvider` — `useToast()`  
3. `BrowserRouter`  
4. `ConnectionBanner`  
5. `Routes`  

| Path | Component | Barrel |
|------|-----------|--------|
| `/` | `HomePage` | `features/home` |
| `/auth` | `AuthPage` | `features/auth` |
| `/create` | `CreateRoomPage` | `features/create` |
| `/room/:roomId` | `RoomPage` | `features/room` |
| `/media` | `ScraperPage` | `features/scraper` |

**Query params**

- `/room/:id?invite=CODE` — private join  
- `/create?video=&title=&type=youtube` — YouTube preset  
- `/create?videoUrl=&title=&type=direct` — direct file preset  

---

## 4. API (serverless)

Each file under `api/*.js` (not `lib/`) is one Vercel function.

### 4.1 Shared libs

#### `api/lib/response.js`

| Export | Role |
|--------|------|
| `sendResponse(res, status, body, headers?)` | `writeHead` + JSON `end`; defaults Content-Type + CORS |

#### `api/lib/http.js`

| Export | Role |
|--------|------|
| `JSON_HEADERS` | Standard CORS/JSON headers |
| `preflight(req, res, { methods })` | OPTIONS + method guard; returns true if handled |
| `ok(res, body, status?)` | 200 + `{ success: true, ...body }` |
| `fail(res, status, error)` | `{ success: false, error }` |
| `statusForError(err)` | Map message → 4xx/5xx |

**Imports:** `sendResponse` from `./response.js`

#### `api/lib/firebaseAdmin.js`

| Export | Role |
|--------|------|
| `getDb()` | Lazy `@google-cloud/firestore` with service account |
| `getAuthClient()` | Firebase Admin Auth |
| `verifyIdToken(token)` | Validate Bearer ID token |
| `FieldValue`, `Timestamp` | Admin field helpers |

**Env:** `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`

#### `api/lib/sources.js`

| Export | Role |
|--------|------|
| `SITE_CONFIGS` | Cheerio selectors: nkiri, netnaija, fzmovies, custom |
| `getSiteConfig(site)` | Lookup config |
| `resolveUrl(src, baseUrl)` | Absolute URL helper |

**Used by:** `api/scrape.js` only.

---

### 4.2 Handlers

#### `api/room.js` — `POST /api/room`

| | |
|--|--|
| **Imports** | `getDb`, `FieldValue`, `verifyIdToken` (if used), `preflight`, `ok`, `fail`, `statusForError` |
| **Export** | `default handler` |
| **Body** | `{ action: 'join' \| 'leave' \| 'end', roomId?, uid, displayName?, inviteCode? }` |

| action | Behavior |
|--------|----------|
| `join` | Capacity / lock / private invite; create `participants/{uid}`; increment count |
| `leave` | Delete participant; decrement count |
| `end` | Host-only; `status: ended` |

**Called by:** `useRoom`, Home invite join, CreateRoomPage.

#### `api/moderate.js` — `POST /api/moderate`

| | |
|--|--|
| **Auth** | `Authorization: Bearer <idToken>` |
| **Body** | `{ action: 'kick' \| 'promote' \| 'mute', roomId, uid, role?, muted? }` |
| **Export** | `default handler` |

**Called by:** `useRoom` via `authFetch`.

#### `api/createLiveKitToken.js` — `POST /api/createLiveKitToken`

| | |
|--|--|
| **Imports** | `jsonwebtoken`, `getDb`, http helpers |
| **Body** | `{ roomId, uid, role }` |
| **Security** | `canPublish` only if `uid === room.hostId` |
| **Env** | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |

**Called by:** `ScreenShare.jsx`.

#### `api/cleanupStaleRooms.js` — `POST|GET /api/cleanupStaleRooms`

| | |
|--|--|
| **Query** | `status == live` AND `lastHeartbeat < now - 15m` |
| **Optional** | `x-cron-secret` vs `CRON_SECRET` |
| **Needs** | Firestore composite index on `rooms(status, lastHeartbeat)` |

#### `api/scrape.js` — `POST /api/scrape`

| | |
|--|--|
| **Imports** | cheerio, http, sources |
| **Body** | `{ url?, query?, site? }` |
| **Does** | Fetch HTML; extract on-page media URLs + listing cards; rank direct files first |
| **Does not** | Multi-hop stream unlock / bot bypass |

**Called by:** `useScraper.scrape`.

#### `api/search.js` — `POST /api/search`

| | |
|--|--|
| **Body** | `{ query, source: 'youtube' \| 'omdb' }` |
| **YouTube** | Data API; enriches `embeddable` when possible |
| **OMDb** | Needs `OMDB_API_KEY` |
| **Env** | `YOUTUBE_API_KEY` or `VITE_YOUTUBE_API_KEY` |

**Called by:** `useScraper.search` (fallback if no client YT key).

---

## 5. Frontend entry

### Styles

| File | Role |
|------|------|
| `src/index.css` | Resets, utilities, `@import './styles/theme.css'`, sync-pulse, reduced-motion, focus |
| `src/styles/theme.css` | Design tokens (surfaces, accent, fonts, legacy Depth/Ash aliases) |
| `index.html` | Shell, Google fonts (Bricolage, IBM Plex Sans/Mono), `#root` |

---

## 6. Features

### 6.1 `src/features/auth/`

| File | Exports | Imports | Role |
|------|---------|---------|------|
| `index.js` | `{ AuthPage }` | `./pages/AuthPage.jsx` | Barrel |
| `pages/AuthPage.jsx` | `default AuthPage` | `useAuth`, UI Button/Input/Card | Display name → anonymous sign-in |
| `pages/AuthPage.module.css` | — | — | Styles |

**Flow:** `signInAnonymously` → navigate `/`. Redirect if already signed in (`useEffect`).

---

### 6.2 `src/features/home/`

| File | Exports | Imports | Role |
|------|---------|---------|------|
| `index.js` | `{ HomePage }` | pages | Barrel |
| `pages/HomePage.jsx` | `default` | `useAuth`, Firestore, UI, Layout, `RoomCard`, `getLastRoom`, `parseJsonResponse` | Live public rooms, search/sort, invite join, link to `/media` |
| `pages/HomePage.module.css` | — | — | Styles |
| `components/RoomCard.jsx` | `default` | Link, youtube thumb, Card/Badge/Avatar, SyncPulse | Room card |
| `components/RoomCard.module.css` | — | — | Styles |

**API:** `POST /api/room` `{ action: 'join', inviteCode, ... }`  
**Firestore:** `onSnapshot` on `rooms` (filter client-side live + public).

---

### 6.3 `src/features/create/`

| File | Exports | Imports | Role |
|------|---------|---------|------|
| `index.js` | `{ CreateRoomPage }` | pages | Barrel |
| `pages/CreateRoomPage.jsx` | `default` | Firestore, `useAuth`, youtube helpers, `useScraper`, `parseJsonResponse`, UI | Create room YouTube or direct; search/scrape select |
| `pages/CreateRoomPage.module.css` | — | — | Styles |

**Writes**

1. `rooms/{id}` (`videoId`/`videoUrl`, `videoType`, capacity, private, …)  
2. `playerState/current`  
3. `POST /api/room` join as host  

**Selection rules (current product)**

- YouTube id + optional embeddable check  
- Direct only if URL looks like media file (`.mp4`, `.m3u8`, …)  
- Scrape **page** links do not set video (toast warning)

---

### 6.4 `src/features/room/` (core product)

```
features/room/
├── index.js                 → RoomPage
├── pages/RoomPage.jsx
├── hooks/useRoom.js
├── hooks/usePlayerSync.js
├── services/livekit.js
└── components/
    ├── VideoPlayer.jsx
    ├── ScreenShare.jsx
    ├── Chat.jsx / ChatMessage.jsx
    ├── ParticipantList.jsx
    └── ShareRoom.jsx
```

#### `hooks/useRoom.js`

| Export | Role |
|--------|------|
| `useRoom(roomId, inviteCode?)` | Join/leave/end, listeners, chat send, typing, moderate wrappers |
| `getLastRoom()` | `localStorage` last room |

| Method | Backend / path |
|--------|----------------|
| `join` / `leave` / `endRoom` | `POST /api/room` |
| `kick` / `promote` / `mute` | `POST /api/moderate` + Bearer |
| `sendMessage` | client `addDoc` messages |
| `updateRoom` | client `updateDoc` room |
| `setTyping` | client typing/{uid} |

**Listeners:** room, participants, messages (`orderBy createdAt`), typing  
**Side effects:** host heartbeat ~30s; leave on unmount (`keepalive`)

#### `hooks/usePlayerSync.js`

| Export | Role |
|--------|------|
| `usePlayerSync(roomId, room, playerRef)` | Returns `{ writePlayerState, isHost, isCoHost, canControl }` |

- Host **or co-host** writes `playerState/current`  
- 5s heartbeat; viewers reconcile with ~1.5s seek threshold  
- Visibilitychange resync for viewers  

#### `services/livekit.js`

| Export | Role |
|--------|------|
| `LIVEKIT_URL` | `VITE_LIVEKIT_URL` |
| `isDisplayMediaSupported` | Desktop screen capture detect |
| `createRoom` | LiveKit Room |
| `connectToLivekit` | Connect with token |
| `publishScreenShare` / `publishCameraShare` | Publish tracks |
| `getHostVideoTrack` | Find video track to attach |

#### Components

| File | Export | Imports | Role |
|------|--------|---------|------|
| `VideoPlayer.jsx` | default | react-youtube | YouTube embed **or** HTML5 direct; embed error UI (Vevo etc.) |
| `ScreenShare.jsx` | default | livekit.js, parseJsonResponse | LiveKit token + publish/subscribe |
| `Chat.jsx` | default | ChatMessage, UI | Chat, typing UX, optimistic, 500 limit |
| `ChatMessage.jsx` | default | Firestore reactions | Message, reply, emoji reactions |
| `ParticipantList.jsx` | default | Avatar, SyncPulse | Roster + host actions |
| `ShareRoom.jsx` | default | qrcode, Modal, toast | Invite link / QR / share |
| `RoomPage.jsx` | default | all above + Layout | Orchestrates room UI |

---

### 6.5 `src/features/scraper/` (Discover /media)

| File | Export | Imports | Role |
|------|--------|---------|------|
| `index.js` | `{ ScraperPage }` | `./ScraperPage.jsx` | Barrel |
| `ScraperPage.jsx` | named `ScraperPage` | useAuth, useScraper, youtube `isDirectVideoUrl`, UI, Layout | Movies/OMDb/manual scrape + YouTube search UI |
| `ScraperPage.module.css` | — | — | Styles |

**Actions**

- YouTube → navigate `/create?video=&type=youtube`  
- Direct media → `/create?videoUrl=&type=direct`  
- Page-only scrape → Open / Copy only  

---

### 6.6 `src/hooks/useScraper.js`

| Export | Role |
|--------|------|
| `useScraper()` | `{ scrape, search, results, lastQuery, loading, error, clear }` |

| Method | Calls |
|--------|--------|
| `search(query, source)` | Client `youtube.searchVideos` if `VITE_YOUTUBE_API_KEY`, else `POST /api/search` |
| `scrape({ url, query, site })` | `POST /api/scrape` |

Normalizes `link`/`url`/`isDirect`/`playableInRoom`.

---

## 7. Shared layer

### 7.1 `src/shared/lib/`

| File | Exports | Consumers |
|------|---------|-----------|
| `firebase.js` | `auth`, `db` | auth, home, create, room |
| `youtube.js` | `extractVideoId`, `isDirectVideoUrl`, `getThumbnail`, `getVideoMetadata`, `checkEmbeddable`, `searchVideos` | create, room, scraper, useScraper |
| `api.js` | `parseJsonResponse` | home, create, useRoom, ScreenShare |

### 7.2 `src/shared/auth/hooks/useAuth.jsx`

| Export | Role |
|--------|------|
| `AuthProvider` | Context + onAuthStateChanged; upserts `users/{uid}` |
| `useAuth()` | `{ user, loading, signInAnonymously, updateDisplayName, logout }` |

**Imports:** firebase auth/firestore, `friendlyAuthError`

### 7.3 `src/shared/utils/`

| File | Export |
|------|--------|
| `cn.js` | `cn(...classes)` |
| `avatarColor.js` | `avatarColor(seed)` |
| `authErrors.js` | `friendlyAuthError(err)` |

### 7.4 `src/shared/ui/` (barrel `index.js`)

| Export | File | Notes |
|--------|------|-------|
| `Button` | Button.jsx | `loading`, `as` polymorphism |
| `Input` | Input.jsx | |
| `Card` | Card.jsx | `as`, interactive |
| `Avatar` | Avatar.jsx | uses avatarColor |
| `Badge` | Badge.jsx | |
| `Spinner` | Spinner.jsx | |
| `EmptyState` | EmptyState.jsx | |
| `IconButton` | IconButton.jsx | |
| `Modal` | Modal.jsx | Esc, focus |
| `ToastProvider`, `useToast` | Toast.jsx | |
| `Skeleton` | Skeleton.jsx | |

Each has a co-located `*.module.css`.

### 7.5 `src/shared/layout/`

| Export | File |
|--------|------|
| `Header` | Header.jsx (Link, Avatar) |
| `Layout` | Layout.jsx |
| barrel | `index.js` |

### 7.6 `src/shared/components/`

| Export | File | Used by |
|--------|------|---------|
| `SyncPulse` | SyncPulse.jsx | RoomCard, RoomPage, ParticipantList |
| `ConnectionBanner` | ConnectionBanner.jsx | App |

---

## 8. Import / export graphs

### 8.1 Auth

```
AuthPage
  → useAuth().signInAnonymously
       → firebaseSignInAnonymously + updateProfile
       → setDoc users/{uid}
       → friendlyAuthError
  → navigate('/')
```

### 8.2 Create → room

```
CreateRoomPage
  → useScraper (optional search/scrape)
  → setDoc rooms + playerState
  → POST /api/room join
  → navigate /room/:id

RoomPage
  → useRoom → APIs + Firestore listeners
  → usePlayerSync → playerState
  → VideoPlayer | ScreenShare
  → Chat, ParticipantList, ShareRoom
```

### 8.3 Screen share

```
RoomPage activityType screenshare
  → ScreenShare
       → POST /api/createLiveKitToken
       → livekit createRoom + connect
       → host publishScreenShare
       → viewers attach track
```

### 8.4 Discover / media

```
ScraperPage
  → useScraper
       → /api/search or client youtube.js
       → /api/scrape
  → navigate /create?video=… or videoUrl=…
```

### 8.5 Chat

```
Chat → useRoom.sendMessage → messages collection
ChatMessage → reactions subcollection
typing → typing/{uid}
```

### 8.6 UI dependency direction

```
features/*  →  shared/ui, shared/layout, shared/lib, shared/auth
hooks/useScraper → shared/lib/youtube + /api
api/* → api/lib/*
App → features barrels + shared providers
```

**Rule:** features should not import other features except intentional bridges (e.g. Home → `getLastRoom` from room hook).

---

## 9. Firestore model & rules

### Collections

```
users/{uid}
  displayName, anonymous, tier, createdAt

rooms/{roomId}
  hostId, hostName, title
  activityType: youtube | screenshare | direct | idle
  videoType: youtube | direct
  videoId?, videoUrl?
  isPrivate, inviteCode, coHosts[], locked
  capacity, status, participantCount
  createdAt, lastHeartbeat, endedAt?

rooms/{roomId}/playerState/current
  videoId?, videoUrl?, isPlaying, currentTime, updatedAt, updatedBy

rooms/{roomId}/participants/{uid}
  displayName, role, muted, joinedAt

rooms/{roomId}/messages/{messageId}
  uid, displayName, text, createdAt, replyTo?

rooms/{roomId}/messages/{messageId}/reactions/{uid}
  emoji

rooms/{roomId}/typing/{uid}
  displayName, lastTypedAt

scrapes/{id}   # rules exist; current scrape.js may not write
```

### `firestore.rules` (summary)

| Path | Read | Write |
|------|------|-------|
| users | authed | owner create/update |
| rooms | live (+ private rules) | create as host; update host/co-host |
| playerState | authed | host/co-host |
| participants | authed | **false** (server only) |
| messages | authed | create if participant, own uid, size, not muted |
| reactions | authed | owner |
| typing | authed | owner |
| scrapes | authed | create false (admin) |

**Publish rules in Firebase Console** — file in repo is not live until published.

---

## 10. Environment variables

### Client (`VITE_*`)

| Variable | Used in |
|----------|---------|
| `VITE_FIREBASE_API_KEY` etc. | `shared/lib/firebase.js` |
| `VITE_YOUTUBE_API_KEY` | `youtube.js`, client search; server search fallback |
| `VITE_LIVEKIT_URL` | `livekit.js` |
| `VITE_API_URL` | optional API base in `useScraper` |

### Server (Vercel)

| Variable | Used in |
|----------|---------|
| `FIREBASE_ADMIN_*` | firebaseAdmin.js |
| `LIVEKIT_API_KEY` / `SECRET` | createLiveKitToken |
| `CRON_SECRET` | cleanupStaleRooms |
| `YOUTUBE_API_KEY` | search.js preferred |
| `OMDB_API_KEY` | search.js omdb source |

---

## 11. Config files

| File | Role |
|------|------|
| `package.json` | scripts, dependencies |
| `vite.config.js` | React plugin, port 3000 (no API proxy — use `vercel dev` for full stack) |
| `vercel.json` | SPA rewrite + `/api` pass-through |
| `firestore.rules` | Security rules source |
| `.env` / `.env.example` | Env templates — **never commit real private keys** |
| `README.md` | Deploy / keys overview |

**Vercel function count:** 6 (`room`, `moderate`, `createLiveKitToken`, `cleanupStaleRooms`, `scrape`, `search`).

---

## 12. Data flows (summary)

| User action | Path |
|-------------|------|
| Sign in | AuthPage → useAuth → Firebase Anonymous → users doc |
| Browse rooms | HomePage → Firestore rooms → RoomCard |
| Create YT room | CreateRoomPage → rooms + playerState → /api/room join → RoomPage |
| Create direct room | Same with `videoUrl` + `videoType: direct` → HTML5 player |
| Sync playback | usePlayerSync ↔ playerState |
| Chat | messages + typing + reactions |
| Moderate | ParticipantList → useRoom → /api/moderate |
| Screen share | /api/createLiveKitToken → LiveKit |
| Discover | ScraperPage → useScraper → search/scrape APIs → create query params |
| Stale rooms | External cron → cleanupStaleRooms |

---

## 13. Docs index

| Doc | Content |
|-----|---------|
| [note.md](./note.md) | Security watchlist — files to audit if malicious stream code appears |
| [guide.md](./guide.md) | This full structure / imports / exports guide |
| `docs/DEVELOPER_GUIDE.md` | Earlier contributor guide (may lag slightly) |
| `docs/APP_AUDIT.md` | Prior inventory audit |
| `docs/DEEP_AUDIT_efea3c0.md` | Deep crash/config audit at older HEAD |
| `docs/SCRAPER.md` / `SCRAPER_ROOM_INTEGRATION.md` / `DIRECT_VIDEO_SYNC_AUDIT.md` | Feature-specific notes |

---

## Quick “where is X?”

| Symbol / concern | File |
|------------------|------|
| Routes | `src/App.jsx` |
| Auth | `src/shared/auth/hooks/useAuth.jsx` |
| Join/leave/end | `api/room.js` + `useRoom.js` |
| Kick/promote/mute | `api/moderate.js` + `useRoom.js` |
| Playback sync | `usePlayerSync.js` + `VideoPlayer.jsx` |
| Screen share | `ScreenShare.jsx` + `livekit.js` + `createLiveKitToken.js` |
| YouTube helpers | `src/shared/lib/youtube.js` |
| Scrape/search client | `src/hooks/useScraper.js` |
| Scrape/search server | `api/scrape.js`, `api/search.js` |
| Site selectors | `api/lib/sources.js` |
| UI kit | `src/shared/ui/*` |
| Theme | `src/styles/theme.css` |

---

*End of guide. Update this file when you add routes, API functions, or move feature folders.*

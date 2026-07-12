# Chan — Developer Guide

How the codebase is organized, what each folder/file does, and where to change features without hunting.

| | |
|---|---|
| **App** | Real-time watch party (YouTube sync + LiveKit screen share + chat) |
| **Frontend** | React 18 + Vite + react-router-dom |
| **Realtime / auth** | Firebase Anonymous Auth + Firestore listeners |
| **Server** | Vercel serverless functions under `/api` |
| **Media SFU** | LiveKit Cloud (screen share only) |
| **Deploy** | Vercel Hobby · Firebase Spark |
| **Repo root** | `/` (this project) |

Related docs:

- [`README.md`](../README.md) — env vars, deploy, Firestore rules paste block
- [`firestore.rules`](../firestore.rules) — canonical security rules file

---

## Table of contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Repository map](#2-repository-map)
3. [Feature → file index (fix targeting)](#3-feature--file-index-fix-targeting)
4. [Frontend routes](#4-frontend-routes)
5. [Folder & file reference](#5-folder--file-reference)
6. [API / serverless functions](#6-api--serverless-functions)
7. [Firestore data model](#7-firestore-data-model)
8. [Auth model](#8-auth-model)
9. [Sync engine](#9-sync-engine)
10. [Screen share (LiveKit)](#10-screen-share-livekit)
11. [Shared UI kit](#11-shared-ui-kit)
12. [Environment variables](#12-environment-variables)
13. [Common upgrade recipes](#13-common-upgrade-recipes)
14. [Conventions & gotchas](#14-conventions--gotchas)

---


> **API consolidation (Hobby limit):** the app exposes **4** Vercel functions only:
> `POST /api/room` (`join|leave|end`), `POST /api/moderate` (`kick|promote|mute`), `POST /api/createLiveKitToken`, `POST/GET /api/cleanupStaleRooms`.
> Older per-action files (`joinRoom.js`, `kickParticipant.js`, …) were removed.

## 1. Architecture at a glance

```
Browser (React SPA on Vercel)
│
├── Firebase Auth (Anonymous only)
├── Firestore (rooms, playerState, chat, participants, typing, reactions)
│     └── onSnapshot listeners for realtime
│
├── YouTube IFrame API (react-youtube) — playback + host control events
│
└── LiveKit client — screen-share media only
      │
      └── POST /api/createLiveKitToken  (JWT mint; secrets stay server-side)

Vercel /api/* (Node serverless)
├── joinRoom / leaveRoom / endRoom
├── kickParticipant / promoteParticipant / muteParticipant  (Bearer idToken)
├── createLiveKitToken
└── cleanupStaleRooms  (external cron → POST)
```

**Design rule:** capacity, kick, promote, mute, and LiveKit publish rights are enforced **server-side**. Clients may read Firestore widely (per rules) but must not write `participants` directly.

---

## 2. Repository map

```
Chan/
├── api/                      # Vercel serverless functions (backend)
│   ├── lib/                  # Shared server helpers
│   ├── joinRoom.js
│   ├── leaveRoom.js
│   ├── endRoom.js
│   ├── createLiveKitToken.js
│   ├── cleanupStaleRooms.js
│   ├── kickParticipant.js
│   ├── promoteParticipant.js
│   └── muteParticipant.js
│
├── src/
│   ├── main.jsx              # React entry
│   ├── App.jsx               # Providers + routes
│   ├── index.css             # Global styles (imports theme)
│   ├── styles/theme.css      # Design tokens
│   │
│   ├── features/             # Feature-sliced UI + domain hooks
│   │   ├── auth/             # Anonymous sign-in page
│   │   ├── home/             # Discover feed
│   │   ├── create/           # Create room
│   │   └── room/             # In-room experience (largest surface)
│   │
│   └── shared/               # Cross-feature code
│       ├── auth/             # AuthProvider / useAuth
│       ├── components/       # App-level widgets (banner, pulse)
│       ├── layout/           # Header, Layout shells
│       ├── lib/              # firebase, youtube, api helpers
│       ├── ui/               # Design-system components
│       └── utils/            # Pure helpers (cn, avatar color, auth errors)
│
├── firestore.rules           # Security rules (publish in Firebase Console)
├── vercel.json               # SPA rewrites; no Hobby crons
├── vite.config.js
├── package.json
├── index.html
├── README.md                 # Deploy / keys / rules paste
└── docs/
    └── DEVELOPER_GUIDE.md    # This file
```

**Rule of thumb**

| Put it in… | When… |
|------------|--------|
| `src/features/<name>/` | Only that product area uses it |
| `src/shared/` | 2+ features need it |
| `api/` | Needs secrets, transactions, or Admin SDK |
| `api/lib/` | Shared by multiple API handlers |

---

## 3. Feature → file index (fix targeting)

Use this when you know *what* is broken and need *where* to open.

| Symptom / feature | Primary files |
|-------------------|---------------|
| Can't sign in / anonymous errors | `src/shared/auth/hooks/useAuth.jsx`, `src/shared/utils/authErrors.js`, `src/features/auth/pages/AuthPage.jsx` + **Firebase Console → Anonymous enabled** |
| Home feed empty / search / sort | `src/features/home/pages/HomePage.jsx`, `RoomCard.jsx` |
| Create room fails | `src/features/create/pages/CreateRoomPage.jsx`, `api/joinRoom.js`, Firestore rules |
| Join capacity / private / locked | `api/joinRoom.js`, `useRoom.js` |
| Leave room | `api/leaveRoom.js`, `useRoom.js` → `leave` |
| End room | `api/endRoom.js`, `RoomPage.jsx` (confirm modal) |
| Video out of sync | `src/features/room/hooks/usePlayerSync.js`, `VideoPlayer.jsx` |
| Host can't control playback | `usePlayerSync.js` (`canControl` = host \|\| co-host), Firestore rules `playerState` |
| Change YouTube video | `RoomPage.jsx` → `changeVideo`, `youtube.js` `extractVideoId` |
| Screen share broken | `ScreenShare.jsx`, `services/livekit.js`, `api/createLiveKitToken.js` |
| Mobile screen share | `livekit.js` `isDisplayMediaSupported`, `RoomPage.jsx` (desktop-only button + note) |
| Chat send / cooldown / 500 limit | `Chat.jsx`, `useRoom.js` `sendMessage` |
| Typing indicator | `Chat.jsx` + `useRoom.js` `setTyping` / typing listener |
| Message reactions | `ChatMessage.jsx` → `messages/{id}/reactions/{uid}` |
| Reply-to | `Chat.jsx` + `ChatMessage.jsx` + message `replyTo` field |
| Kick / promote / mute | `ParticipantList.jsx`, `useRoom.js` `authFetch`, matching `api/*Participant.js` |
| Room lock | `RoomPage.jsx` `toggleLock`, `api/joinRoom.js` (`locked`) |
| Edit room title | `RoomPage.jsx` `saveTitle` → `updateRoom({ title })` |
| Share / QR / copy link | `ShareRoom.jsx` |
| Toasts | `src/shared/ui/Toast.jsx`, `useToast()` |
| Offline banner | `src/shared/components/ConnectionBanner.jsx` |
| Avatar colors | `src/shared/utils/avatarColor.js`, `Avatar.jsx` |
| Theme / colors / fonts | `src/styles/theme.css`, `src/index.css`, `index.html` (Google fonts) |
| Stale rooms not ending | `api/cleanupStaleRooms.js` + composite index + external cron |
| Security denied writes | `firestore.rules` + client path must match rules |
| API `res.status is not a function` | Always use `api/lib/response.js` `sendResponse` — never Express-style chaining |
| LiveKit secrets leaked | Only `LIVEKIT_API_*` in Vercel env; client only has `VITE_LIVEKIT_URL` |

---

## 4. Frontend routes

Defined in [`src/App.jsx`](../src/App.jsx).

| Path | Page | Barrel import |
|------|------|----------------|
| `/` | Discover / home | `features/home` → `HomePage` |
| `/auth` | Anonymous display-name gate | `features/auth` → `AuthPage` |
| `/create` | Start a room | `features/create` → `CreateRoomPage` |
| `/room/:roomId` | In-room shell | `features/room` → `RoomPage` |
| `/room/:roomId?invite=CODE` | Private join | `useSearchParams` → `useRoom(roomId, inviteCode)` |

**Global providers (outer → inner):**

1. `AuthProvider` — Firebase user session  
2. `ToastProvider` — `useToast()`  
3. `BrowserRouter`  
4. `ConnectionBanner` — offline strip above routes  

---

## 5. Folder & file reference

### 5.1 Root config

| File | Purpose |
|------|---------|
| `package.json` | Scripts: `dev`, `build`, `preview`, `lint`. Deps: firebase, livekit-client, react-youtube, qrcode, firebase-admin, @google-cloud/firestore, jsonwebtoken |
| `vite.config.js` | Vite + React plugin; dev server port **3000** |
| `vercel.json` | SPA fallback `/(.*) → /`; `/api/*` left as functions. **No crons** (Hobby daily-only) |
| `index.html` | Shell + Google Fonts (Bricolage Grotesque, IBM Plex Sans/Mono) |
| `.env` / `.env.example` | Local + documented env keys (`VITE_*` = client; others = server only) |
| `firestore.rules` | Source of truth for rules; also mirrored in README |
| `README.md` | Deploy guide, env map, rules paste, Anonymous Auth enable steps |

---

### 5.2 `src/main.jsx` · `src/App.jsx` · styles

| File | Role |
|------|------|
| `src/main.jsx` | Mounts `<App />` into `#root`, imports `index.css` |
| `src/App.jsx` | Providers + route table |
| `src/index.css` | Global resets, legacy utility classes (`.btn`, `.card`, `.mono`), Sync Pulse keyframes, `prefers-reduced-motion`, focus-visible |
| `src/styles/theme.css` | CSS variables: surfaces, accent/danger/success, text, radii, spacing, fonts; legacy aliases `--depth/--ash/--ember/--drift/--fog/--paper` |

---

### 5.3 `src/features/auth/`

Anonymous identity onboarding.

| File | Role |
|------|------|
| `index.js` | Barrel: `export { AuthPage }` |
| `pages/AuthPage.jsx` | Form: display name → `signInAnonymously` → navigate `/` |
| `pages/AuthPage.module.css` | Centered card layout; multi-line error styles |

**Key behavior:** errors from Firebase are mapped via `friendlyAuthError` (e.g. `auth/admin-restricted-operation` → enable Anonymous in Console). No `alert()`.

---

### 5.4 `src/features/home/`

Public live-room discovery.

| File | Role |
|------|------|
| `index.js` | Barrel → `HomePage` |
| `pages/HomePage.jsx` | Listens to `rooms` collection; filters `status==live && !isPrivate`; search title/host; sort newest/popular; invite-code join; continue-watching from `localStorage`; skeletons |
| `pages/HomePage.module.css` | Toolbar, grid, continue banner, skeletons |
| `components/RoomCard.jsx` | Card: thumb, live badge + SyncPulse, host, `participantCount/capacity` |
| `components/RoomCard.module.css` | Card layout |

**Continue watching:** `getLastRoom()` from `useRoom.js` (`localStorage` key `chan:lastRoom`).

---

### 5.5 `src/features/create/`

| File | Role |
|------|------|
| `index.js` | Barrel → `CreateRoomPage` |
| `pages/CreateRoomPage.jsx` | Title, YouTube URL/search, capacity, private flag → writes room + `playerState/current` → `POST /api/room` as host → navigate to room |
| `pages/CreateRoomPage.module.css` | Form layout |

**Helpers inside page**

| Function | Purpose |
|----------|---------|
| `makeInviteCode()` | 6-char uppercase code for private rooms |
| `onUrlChange` | Parses URL via `extractVideoId` |
| `onSearch` | YouTube Data API search |
| `create` | Transactional create flow (client write room docs + server join) |

**Room doc fields set at create:**  
`hostId`, `hostName`, `title`, `activityType`, `videoId`, `isPrivate`, `inviteCode`, `coHosts: []`, `locked: false`, `capacity`, `status: 'live'`, `participantCount: 1`, `createdAt`, `lastHeartbeat`.

---

### 5.6 `src/features/room/` (core product)

Largest feature. In-room chrome, sync, chat, share, screen share.

```
features/room/
├── index.js                 # Barrel → RoomPage
├── pages/
│   ├── RoomPage.jsx         # Orchestrator UI
│   └── RoomPage.module.css
├── components/
│   ├── VideoPlayer.jsx      # YouTube embed
│   ├── ScreenShare.jsx      # LiveKit viewer/publisher UI
│   ├── Chat.jsx             # Chat shell
│   ├── ChatMessage.jsx      # Single message + reactions
│   ├── ParticipantList.jsx  # Roster + host actions
│   ├── ShareRoom.jsx        # Modal: link, QR, share
│   └── *.module.css
├── hooks/
│   ├── useRoom.js           # Room lifecycle + listeners + management APIs
│   └── usePlayerSync.js     # Host/co-host writes + viewer reconcile
└── services/
    └── livekit.js           # LiveKit client helpers
```

#### `pages/RoomPage.jsx`

**Job:** Compose the room. Holds local UI state; delegates data to hooks.

| Concern | Implementation |
|---------|----------------|
| Load room / join | `useRoom(roomId, inviteCode)` |
| Playback sync | `usePlayerSync(roomId, room, playerRef)` |
| Mode switch | `activityType` youtube ↔ screenshare via `updateRoom` |
| Host controls | Change video, share screen, lock, edit title, end room |
| Chat chrome | Desktop right sidebar; mobile bottom sheet + overlay + Esc |
| Details drawer | Collapsed participants + room info |
| Confirms | End room modal; leave-while-sharing modal |
| Toasts | Errors/success via `useToast()` |

#### `hooks/useRoom.js`

**Job:** Single source of room realtime state and mutations.

| Export | Purpose |
|--------|---------|
| `useRoom(roomId, inviteCode?)` | Main hook |
| `getLastRoom()` | Read `localStorage` last room |

**Internal functions / effects**

| Name | What it does |
|------|----------------|
| `join` | `POST /api/room` |
| `leave` | `POST /api/room` |
| `endRoom` | `POST /api/room` → navigate home |
| `sendMessage(text, replyTo?)` | `addDoc` messages; clears typing doc |
| `updateRoom(payload)` | `updateDoc` room root (title, activityType, videoId, locked, …) |
| `authFetch(path, body)` | Adds `Authorization: Bearer <idToken>` for management APIs |
| `kickParticipant` / `promoteParticipant` / `muteParticipant` | Auth'd API wrappers |
| Room `onSnapshot` | Sets `room`, `activityType`; detects `ended` |
| Participants `onSnapshot` | Roster; **kick detection** if you vanish while joined |
| Messages `onSnapshot` | Ordered chat |
| Typing `onSnapshot` | Presence list (filters stale >5s client-side) |
| `setTypingStatus` | Writes/deletes `typing/{uid}` |
| Host heartbeat interval | Every **30s** updates `lastHeartbeat` (cleanup) |
| Mount effect | Rejoin if already participant else `join`; unmount `leave` |

**Returned API**

```
room, participants, messages, joined, error, kicked,
activityType, setActivityType,
join, leave, endRoom, sendMessage, updateRoom,
typing, setTyping,
kickParticipant, promoteParticipant, muteParticipant
```

#### `hooks/usePlayerSync.js`

**Job:** Host-authoritative (actually host **or co-host**) playback sync.

| Constant | Value | Meaning |
|----------|-------|---------|
| `SYNC_THRESHOLD` | `1.5` seconds | Seek only if drift exceeds this |

| Export / piece | Purpose |
|----------------|---------|
| `writePlayerState(patch)` | Merge-write `playerState/current` |
| Host heartbeat | Every **5s** while controller + videoId |
| Viewer `onSnapshot` | Compute expected time; play/pause; seek if drift; load new videoId |
| `visibilitychange` | Idle-tab resync for viewers |
| Return | `{ writePlayerState, isHost, isCoHost, canControl }` |

#### `components/VideoPlayer.jsx`

| Prop | Role |
|------|------|
| `videoId` | YouTube id |
| `isHost` | If true, native controls shown (used for any `canControl` user from RoomPage) |
| `onReady(player)` | Exposes YT player instance to parent ref |
| `onPlayerEvent(patch)` | Play/pause → parent writes playerState |

#### `components/ScreenShare.jsx`

Connects LiveKit, host publishes display (or historical camera fallback path in service), viewers attach remote video track.

#### `components/Chat.jsx`

| Feature | Where |
|---------|--------|
| Message list + empty state | `messages` map |
| Grouping (same uid within 60s) | `isGrouped` + `grouped` prop |
| Optimistic local messages | `optimistic` state until server appears |
| Auto-scroll + “N new messages” pill | `atBottom` / `unseen` |
| Typing UX | throttled writes 2s; debounce clear 1.2s |
| Emoji picker insert | local input only |
| 500 hard max + counter ≥400 | `maxLength` + `nearLimit` |
| 1s send cooldown | `cooldown` |

#### `components/ChatMessage.jsx`

| Feature | Path / notes |
|---------|----------------|
| Reply snippet | `message.replyTo` |
| Reactions | subcollection `reactions/{uid}` `{ emoji }` |
| Grouped header hide | `grouped` prop |
| Pending opacity | optimistic `pending` |

#### `components/ParticipantList.jsx`

| Feature | Notes |
|---------|--------|
| Role display | host / co-host / viewer |
| Host actions | Promote, Demote, Mute, Kick |
| Avatar | `uid={p.id}` for stable color |

#### `components/ShareRoom.jsx`

Modal: QR (`qrcode` package), copy invite link, native `navigator.share`, copy invite code. Uses toasts (not `alert`).

#### `services/livekit.js`

| Export | Purpose |
|--------|---------|
| `LIVEKIT_URL` | `VITE_LIVEKIT_URL` |
| `isDisplayMediaSupported()` | Guard for desktop screen capture |
| `createRoom()` | `livekit-client` Room |
| `connectToLivekit(room, token, url?)` | Connect |
| `publishScreenShare(room)` | `getDisplayMedia` + publish |
| `publishCameraShare(room)` | Camera fallback helper |
| `getHostVideoTrack(room)` | Find first video track to attach |

---

### 5.7 `src/shared/auth/`

| File | Role |
|------|------|
| `hooks/useAuth.jsx` | `AuthProvider`, `useAuth()` |

**API surface**

| Method | Behavior |
|--------|----------|
| `signInAnonymously(displayName)` | Firebase anonymous + `updateProfile` + upsert `users/{uid}` |
| `updateDisplayName(name)` | Profile + user doc merge |
| `logout` | `signOut` |
| Context | `{ user, loading, signInAnonymously, updateDisplayName, logout }` |

**Important:** import Firebase's function as `firebaseSignInAnonymously` so the local wrapper does not recurse (historical `c.trim` bug).

---

### 5.8 `src/shared/lib/`

| File | Exports | Purpose |
|------|---------|---------|
| `firebase.js` | `auth`, `db` | Client Firebase init from `VITE_FIREBASE_*` |
| `youtube.js` | `extractVideoId`, `getVideoMetadata`, `searchVideos`, `getThumbnail` | YouTube Data API + URL parse + thumb URL |
| `api.js` | `parseJsonResponse(res)` | Safe JSON parse for fetch responses (handles empty/non-JSON) |

---

### 5.9 `src/shared/components/`

| File | Purpose |
|------|---------|
| `SyncPulse.jsx` | 5s ring animation (signature UI); respects `prefers-reduced-motion` |
| `ConnectionBanner.jsx` | Sticky bar when `navigator.onLine` is false |

---

### 5.10 `src/shared/layout/`

| File | Purpose |
|------|---------|
| `Layout.jsx` | Page shell: optional header, `wide` / `centered` variants |
| `Header.jsx` | Brand + user + action slot |
| `index.js` | Barrel |

---

### 5.11 `src/shared/utils/`

| File | Export | Purpose |
|------|--------|---------|
| `cn.js` | `cn(...classes)` | Conditional `className` join |
| `avatarColor.js` | `avatarColor(seed)` | Deterministic palette from uid/name hash |
| `authErrors.js` | `friendlyAuthError(err)` | Human copy for Firebase Auth codes |

---

### 5.12 `src/shared/ui/`

Design-system primitives. Prefer these over ad-hoc buttons/inputs.

See [§11 Shared UI kit](#11-shared-ui-kit).

Barrel: `src/shared/ui/index.js`.

---

## 6. API / serverless functions

**Runtime:** Vercel Node functions.  
**Response helper:** always `sendResponse(res, status, body, headers)` from `api/lib/response.js` (Vercel has no Express `res.status().json()`).

**Hobby limit:** 12 functions max. Current count: **8**.

| File | Method | Auth | Body | Does |
|------|--------|------|------|------|
| `joinRoom.js` | POST | none (uid in body) | `roomId?`, `uid`, `displayName`, `inviteCode?` | Transactional join; capacity; private invite; **locked** blocks non-host; host bypass private check |
| `leaveRoom.js` | POST | none | `roomId`, `uid` | Delete participant; decrement count |
| `endRoom.js` | POST | none (checks hostId) | `roomId`, `uid` | Host-only: `status: ended`, `activityType: idle` |
| `createLiveKitToken.js` | POST | none (checks hostId for publish) | `roomId`, `uid`, `role` | JWT; `canPublish` only if `uid === hostId` |
| `cleanupStaleRooms.js` | POST/GET | optional `x-cron-secret` | — | Ends rooms with `status==live` and `lastHeartbeat` older than 15m |
| `kickParticipant.js` | POST | **Bearer idToken** | `roomId`, `uid` | Host-only remove; strip coHost |
| `promoteParticipant.js` | POST | **Bearer** | `roomId`, `uid`, `role` (`co-host`\|`viewer`) | Host-only; maintains `room.coHosts` |
| `muteParticipant.js` | POST | **Bearer** | `roomId`, `uid`, `muted:boolean` | Host or co-host; cannot mute host |

### `api/lib/`

| File | Exports | Purpose |
|------|---------|---------|
| `response.js` | `sendResponse` | `writeHead` + `end` JSON |
| `firebaseAdmin.js` | `getDb`, `getAuthClient`, `verifyIdToken`, `FieldValue`, `Timestamp` | Admin Firestore + Auth; parses `FIREBASE_ADMIN_PRIVATE_KEY` (supports escaped `\n` and raw JSON) |

### Calling management endpoints from the client

`useRoom` → `authFetch`:

```http
POST /api/moderate
Authorization: Bearer <Firebase ID token>
Content-Type: application/json

{ "roomId": "...", "uid": "..." }
```

---

## 7. Firestore data model

```
users/{uid}
  displayName, anonymous, tier, createdAt

rooms/{roomId}
  hostId, hostName, title
  activityType: "youtube" | "screenshare" | "idle"
  videoId, isPrivate, inviteCode
  coHosts: string[]          # extra beyond original brief
  locked: boolean
  capacity, status: "live" | "ended"
  participantCount
  createdAt, lastHeartbeat, endedAt?

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
```

**Who writes what**

| Path | Client write? | Server write? |
|------|---------------|---------------|
| `rooms` create | Yes (creator) | — |
| `rooms` update | Host/co-host (rules) | join/leave/end/cleanup/kick/promote |
| `participants` | **No** (rules `write: if false`) | join/leave/kick/mute/promote |
| `playerState` | Host/co-host | — |
| `messages` | Participants (not muted) | — |
| `reactions` | Owner uid | — |
| `typing` | Owner uid | — |
| `users` | Owner | — |

**Indexes:** cleanup query needs composite **`status` ASC + `lastHeartbeat` ASC** on `rooms`.

---

## 8. Auth model

- **Only** Firebase **Anonymous Auth** (product decision).
- Display name is cosmetic (`updateProfile` + `users` doc).
- Hosting a room does **not** require email verification (brief originally did; code does not).
- Management APIs verify ID tokens via Admin SDK.

**Console prerequisite:** Authentication → Sign-in method → **Anonymous → Enable**.  
Otherwise clients get `auth/admin-restricted-operation`.

---

## 9. Sync engine

```
Controller (host or co-host)
  play/pause/seek/video change → writePlayerState immediately
  every 5s while active → heartbeat currentTime + isPlaying

Viewer
  onSnapshot playerState
  expected = isPlaying
      ? currentTime + (now - updatedAt)
      : currentTime
  if |local - expected| > 1.5s → seek
  always mirror isPlaying
  on tab visible again → one-shot resync
```

**Related files:** `usePlayerSync.js`, `VideoPlayer.jsx`, rules on `playerState/{docId}`.

---

## 10. Screen share (LiveKit)

```
Host clicks Share screen
  → activityType = screenshare
  → ScreenShare mounts
  → POST /api/createLiveKitToken { role: "host" }
  → connect + publishScreenShare (getDisplayMedia)
Viewers
  → token role viewer (subscribe only)
  → attach remote video track
Stop
  → activityType = youtube
  → component unmount disconnects
```

**Security:** server sets `canPublish: isHost` only. Viewers cannot get a publish-capable token by spoofing `role` if `uid !== hostId`.

**Mobile:** `getDisplayMedia` missing → UI shows note; do not treat as desktop share.

---

## 11. Shared UI kit

Import from `src/shared/ui/index.js`.

| Component | File | Notes |
|-----------|------|-------|
| `Button` | `Button.jsx` | `variant` primary/secondary/danger/ghost; `size` sm/md/lg; `loading`; `as` polymorphism |
| `Input` | `Input.jsx` | Optional label/error |
| `Card` | `Card.jsx` | `interactive`, `clickable`, `as` |
| `Avatar` | `Avatar.jsx` | Initial + `avatarColor(uid\|\|name)` |
| `Badge` | `Badge.jsx` | e.g. live |
| `Spinner` | `Spinner.jsx` | Used inside loading buttons |
| `EmptyState` | `EmptyState.jsx` | Title, description, action |
| `IconButton` | `IconButton.jsx` | Compact icon actions |
| `Modal` | `Modal.jsx` | Esc close, basic focus, overlay click |
| `ToastProvider` / `useToast` | `Toast.jsx` | `toast(msg, { variant, duration })` |
| `Skeleton` | `Skeleton.jsx` | Loading placeholders |

Each component has a co-located `*.module.css`.

---

## 12. Environment variables

### Client (`VITE_*` — bundled)

| Variable | Used by |
|----------|---------|
| `VITE_FIREBASE_API_KEY` | `shared/lib/firebase.js` |
| `VITE_FIREBASE_AUTH_DOMAIN` | same |
| `VITE_FIREBASE_PROJECT_ID` | same |
| `VITE_FIREBASE_STORAGE_BUCKET` | same |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | same |
| `VITE_FIREBASE_APP_ID` | same |
| `VITE_FIREBASE_MEASUREMENT_ID` | optional |
| `VITE_YOUTUBE_API_KEY` | `shared/lib/youtube.js` |
| `VITE_LIVEKIT_URL` | `features/room/services/livekit.js` |

### Server only (Vercel env — never `VITE_`)

| Variable | Used by |
|----------|---------|
| `FIREBASE_ADMIN_PROJECT_ID` | `api/lib/firebaseAdmin.js` |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | same |
| `FIREBASE_ADMIN_PRIVATE_KEY` | same |
| `LIVEKIT_API_KEY` | `createLiveKitToken.js` |
| `LIVEKIT_API_SECRET` | same |
| `CRON_SECRET` | optional gate on `cleanupStaleRooms` |

---

## 13. Common upgrade recipes

### Add a new page

1. Create `src/features/<feature>/pages/X.jsx` (+ css module).  
2. Export from `src/features/<feature>/index.js`.  
3. Register route in `src/App.jsx`.  
4. Link from Header/Home as needed.

### Add a new Vercel function

1. Create `api/myThing.js` with default `handler`.  
2. Use `sendResponse` + `getDb` / `verifyIdToken` as needed.  
3. Call from client via `fetch('/api/myThing')` or `authFetch`.  
4. Stay under **12** Hobby functions.  
5. Update this guide + README function count.

### Add a Firestore field on rooms

1. Write it in `CreateRoomPage` and/or `updateRoom`.  
2. Read it in `RoomPage` / Home filters.  
3. Update `firestore.rules` if new subcollections/permissions.  
4. Document in §7 of this guide.

### Change sync aggressiveness

Edit `SYNC_THRESHOLD` and heartbeat `5000` in `usePlayerSync.js`.

### Change stale cleanup window

`STALE_MINUTES` in `api/cleanupStaleRooms.js` (must match product expectations + host heartbeat 30s).

### New chat feature

- UI: `Chat.jsx` / `ChatMessage.jsx`  
- Persist: `useRoom.sendMessage` or new subcollection  
- Rules: `firestore.rules` under `messages`  

### New host moderation action

1. API under `api/` with `verifyIdToken` + host check.  
2. Wire `useRoom.authFetch`.  
3. Button in `ParticipantList.jsx`.  
4. Rules if client-visible fields change.

---

## 14. Conventions & gotchas

1. **No Express on Vercel functions** — use `sendResponse`, not `res.status().json()`.  
2. **No `??` in Firestore rules** — use `map.get(key, default)`.  
3. **Participants are server-written only** — never `setDoc` participants from the client.  
4. **Anonymous Auth must be enabled** in Firebase Console or all sign-in fails.  
5. **Publish rules** after editing `firestore.rules` (editing the file alone does nothing).  
6. **Cleanup needs index + external cron** (Hobby cannot do 15‑min Vercel crons).  
7. **Co-hosts can control playback** — intentional extension; tighten in `usePlayerSync` + rules if product wants host-only.  
8. **CSS modules** — co-locate `Component.module.css`; theme tokens from `theme.css`.  
9. **Feature barrels** — import pages via `features/*/index.js` from `App.jsx`.  
10. **Secrets** — anything without `VITE_` must never be imported from `src/`.  
11. **Function budget** — count files in `api/*.js` (excluding `lib/`) before adding endpoints.  
12. **Double-check before push** — `npm run build` must pass; rules syntax has no `??` / bare `?` in code.

---

## Quick “where is X function?”

| Function / symbol | File |
|------------------|------|
| `AuthProvider` / `useAuth` | `src/shared/auth/hooks/useAuth.jsx` |
| `signInAnonymously` | same |
| `friendlyAuthError` | `src/shared/utils/authErrors.js` |
| `useToast` / `ToastProvider` | `src/shared/ui/Toast.jsx` |
| `useRoom` / `getLastRoom` | `src/features/room/hooks/useRoom.js` |
| `usePlayerSync` | `src/features/room/hooks/usePlayerSync.js` |
| `extractVideoId` / `searchVideos` | `src/shared/lib/youtube.js` |
| `parseJsonResponse` | `src/shared/lib/api.js` |
| `avatarColor` | `src/shared/utils/avatarColor.js` |
| `cn` | `src/shared/utils/cn.js` |
| `isDisplayMediaSupported` | `src/features/room/services/livekit.js` |
| `sendResponse` | `api/lib/response.js` |
| `getDb` / `verifyIdToken` | `api/lib/firebaseAdmin.js` |
| `handler` join/leave/end/… | matching `api/<name>.js` |

---

## Maintenance

When you add a feature or move files:

1. Update the **Feature → file index** (§3).  
2. Update the **folder reference** (§5) or **API table** (§6).  
3. Update **data model** (§7) if schema changes.  
4. Keep `README.md` deploy steps in sync for ops-only changes (rules, indexes, env).

*Last aligned with the modular Chan tree (features/* + shared/* + 8 API functions). Re-scan `find src api -type f` after large refactors.*

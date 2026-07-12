# Direct-Video Support Audit — What's Fixed, What's Broken, What's Missing

Snapshot as of the latest pulled commit (`8fda200`, "Update VideoPlayer.jsx").
This is a read-only audit — no files were changed to produce this document.

## TL;DR

- The previously-reported `statusForError` crash is **confirmed fixed** and
  still in place (`api/lib/http.js` exports it; all four callers resolve).
- The new "watch a directly-scraped video link in a room" feature is
  **partially wired**: creating a room with a direct link works, and the
  video itself displays for everyone (because it's a normal React prop off
  the room document). But **play/pause/seek sync across participants does
  not work for direct videos** — only for YouTube videos — because
  `usePlayerSync.js` was never updated, exactly as the commit note you
  quoted admits.
- There is also a **broken route**: the new "Watch in Room" button links to
  a page that doesn't exist yet.

## 1. What's confirmed fixed

`api/lib/http.js` now exports `statusForError`, and all four consumers
(`api/room.js`, `api/moderate.js`, `api/createLiveKitToken.js`,
`api/cleanupStaleRooms.js`) import only names that exist. That crash from the
previous audit is resolved and nothing in the new commits touched this file
again.

## 2. New feature added since the last audit: direct video links

Three files gained a second video type (`videoType: 'direct'` /
`videoUrl`) alongside the existing YouTube support:

- `src/features/create/pages/CreateRoomPage.jsx` — can now create a room
  from a direct file link (`.mp4`/`.mkv`/`.avi`/`.mov`/`.webm`), either
  pasted directly, extracted via the scraper (`onScrape` → `/api/scrape`),
  or handed a `videoUrl` query param.
- `src/features/room/components/VideoPlayer.jsx` — now renders a plain
  HTML5 `<video>` element when `videoType === 'direct'`, instead of the
  `react-youtube` embed, and exposes a YouTube-shaped fake player object
  (`playVideo`/`pauseVideo`/`seekTo`/`getCurrentTime`/`getDuration`) via
  `onReady` so the rest of the app can drive it generically.
- `src/features/room/pages/RoomPage.jsx` — `changeVideo()` now detects a
  direct-link paste (regex match on file extension) alongside YouTube URL
  parsing, and passes `videoUrl`/`videoType` through to both `updateRoom()`
  and `writePlayerState()`.
- `src/features/scraper/ScraperPage.jsx` — scraped results that look like a
  direct video link (`isVideoLink()`) now get a "Watch in Room" button
  (`createRoomWithVideo`) that navigates to a create-room URL with
  `videoUrl`/`type=direct` params.

## 3. Bug: "Watch in Room" links to a route that doesn't exist

`ScraperPage.jsx`'s `createRoomWithVideo()` navigates to:
```js
navigate(`/create-room?videoUrl=${encodedUrl}&title=${encodedTitle}&type=direct`)
```
But `src/App.jsx` only registers the create page at `/create`:
```jsx
<Route path="/create" element={<CreateRoomPage />} />
```
There is no `/create-room` route and no catch-all/`*` route either, so
clicking "Watch in Room" from the Discover page currently lands on a blank
page (react-router renders nothing for an unmatched path here).

**Fix is a one-line choice, pick one:**
- Change `ScraperPage.jsx`'s `navigate()` call to `/create` instead of
  `/create-room`, or
- Change `App.jsx`'s route path to `/create-room` (then also update any
  other link to the create page, e.g. `HomePage.jsx`'s "Start a Room"
  button, which points at `/create`).

## 4. The real gap: `usePlayerSync.js` was never updated for `videoUrl`

This is the part your commit note flagged. Walking through
`src/features/room/hooks/usePlayerSync.js` as it stands today, function by
function:

### `writePlayerState()` (lines 16-27) — works, but only by accident
```js
const writePlayerState = useCallback(async (patch) => {
  if (!roomId || !canControl || !room || !user) return
  const ref = doc(db, 'rooms', roomId, 'playerState', 'current')
  await setDoc(ref, {
    videoId: room.videoId || '',
    isPlaying: false,
    currentTime: 0,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid,
    ...patch,
  }, { merge: true })
}, [roomId, canControl, room, user])
```
This still works for direct videos **only** because `RoomPage.jsx` always
passes `videoUrl` explicitly inside `patch` (e.g.
`writePlayerState({ videoId: null, videoUrl: newVideoUrl, ... })`), and
`{ ...patch }` overwrites the defaults. But the hardcoded default object has
no `videoUrl` key, so if anything ever calls `writePlayerState()` without
explicitly including `videoUrl`, the field is silently left out of the
default and any stale value only survives because of `merge: true`. This is
fragile, not actually broken today — see the fix below to make it explicit
instead of accidental.

### Controller heartbeat effect (lines 30-47) — broken for direct video
```js
useEffect(() => {
  if (!canControl || !room?.videoId) return
  ...
}, [canControl, room?.videoId, playerRef, writePlayerState])
```
This guard only checks `room?.videoId`. For a direct-video room,
`room.videoId` is `null`, so **this entire effect never runs** — the host's
periodic "push my current play/pause/time" heartbeat simply doesn't exist
for direct videos. Needs to also accept `room?.videoUrl`.

### Viewer reconciliation effect (lines 50-87) — broken for direct video
```js
useEffect(() => {
  if (canControl || !roomId) return
  const unsub = onSnapshot(doc(db, 'rooms', roomId, 'playerState', 'current'), (snap) => {
    const state = snap.data()
    if (!state) return
    const player = playerRef.current
    if (!player || player.getPlayerState === undefined) return   // <-- kills direct video here
    ...
    if (state.videoId && lastVideoIdRef.current !== state.videoId) {
      player.loadVideoById(state.videoId)                        // <-- YouTube-only API
      ...
    }
    if (state.isPlaying && playerState !== 1) player.playVideo?.()
    else if (!state.isPlaying && playerState !== 2) player.pauseVideo?.()
    ...
  })
  return unsub
}, [canControl, roomId, playerRef])
```
Two separate problems here:
1. `player.getPlayerState === undefined` is used as a "is the player ready"
   check, but it's really "is this a `react-youtube` player" check — the
   direct-video fake player object from `VideoPlayer.jsx` never defines
   `getPlayerState`, so **this whole callback returns immediately for every
   viewer of a direct-video room.** No play, no pause, no seek, ever
   reaches a non-controlling viewer. This is exactly the symptom your
   commit note is warning about.
2. `player.loadVideoById(state.videoId)` is a `react-youtube`-only method.
   Even once the `getPlayerState` gate above is fixed, this line would throw
   for the direct-video fake player (no such method exists on it).

### Idle-tab resync effect (lines 90-115) — same `getPlayerState` bug
```js
if (!player || player.getPlayerState === undefined) return
```
Identical gate, identical problem: a viewer who backgrounds the tab and
comes back never resyncs a direct video, because this check exits before
doing anything.

## 5. What to change in `usePlayerSync.js` — no new imports needed

Good news: fixing this doesn't require any new dependency. The file's
current imports are already sufficient:
```js
import { useEffect, useRef, useCallback } from 'react'
import { doc, onSnapshot, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { useAuth } from '../../../shared/auth/hooks/useAuth.jsx'
```
Nothing here changes. The fix is entirely about **which properties on
`room`/`player` the existing logic checks**, not about pulling in a new
package. Concretely:

1. **Every `room?.videoId` guard** (the heartbeat effect's condition) needs
   to become `room?.videoId || room?.videoUrl`, so the heartbeat also runs
   for direct-video rooms.

2. **Every `player.getPlayerState === undefined` "is this player ready"
   check** (viewer reconciliation + idle-resync effects) needs to stop using
   a YouTube-specific method as a readiness probe. The cleanest fix without
   touching `VideoPlayer.jsx`: check for a method both player shapes share,
   e.g. `player.getCurrentTime === undefined` (both the YouTube player and
   the direct-video fake player expose `getCurrentTime`). Alternatively,
   have `VideoPlayer.jsx` add a `getPlayerState()` shim to the direct-video
   fake player object (returning `1` when playing / `2` when paused, mimicking
   YouTube's enum) — that would let the existing checks work unchanged, at
   the cost of touching `VideoPlayer.jsx` too.

3. **The `player.loadVideoById(state.videoId)` branch** needs a parallel
   branch for direct video, since there's no equivalent single-call API on
   the fake player object today. Two options:
   - Add a `loadVideoById`-equivalent to the fake player in
     `VideoPlayer.jsx` (e.g. expose a `loadVideo(url)` that does
     `video.src = url; video.load()`), and call that from
     `usePlayerSync.js` when `state.videoUrl && lastVideoUrlRef.current !== state.videoUrl`.
   - Or skip this branch for direct video entirely and rely on the fact that
     `RoomPage.jsx` already re-renders `VideoPlayer` with a new `videoUrl`
     prop whenever the room document itself changes (a separate listener in
     `useRoom.js`) — in which case `usePlayerSync.js` only needs to handle
     play/pause/seek, not the source swap. This is the smaller change.

4. **A new `lastVideoUrlRef`** (mirroring the existing `lastVideoIdRef`)
   would be needed only if you pick the first option in point 3.

5. **The `writePlayerState()` default object** should add
   `videoUrl: room.videoUrl || null` next to the existing
   `videoId: room.videoId || ''` default, so the merge behavior is explicit
   rather than relying on every caller remembering to pass it.

None of this requires new imports — `usePlayerSync.js` already has
everything it needs (`doc`, `onSnapshot`, `setDoc`, `getDoc`,
`serverTimestamp`, `db`, `useAuth`, React hooks). The fix is logic-only:
broaden the guards from "YouTube-shaped" to "either video type," and give
the direct-video fake player either a `getPlayerState` shim or switch the
readiness check to a shared method.

## 6. Files touched by a complete fix, in order

| # | File | Change needed |
|---|---|---|
| 1 | `src/features/room/hooks/usePlayerSync.js` | Broaden `room?.videoId` guards to include `videoUrl`; replace the `getPlayerState`-based readiness check with a shared-method check (or rely on a shim from #2); add a `videoUrl` branch alongside `loadVideoById` (or drop that branch per point 3 above); add `videoUrl` to the `writePlayerState` default object. |
| 2 | `src/features/room/components/VideoPlayer.jsx` (only if you pick the shim approach) | Add `getPlayerState()` (returning a YouTube-style 1/2 enum) and optionally `loadVideo(url)` to the fake player object passed to `onReady`. |
| 3 | `src/features/scraper/ScraperPage.jsx` **or** `src/App.jsx` | Fix the `/create-room` vs `/create` route mismatch (§3) — pick one file, not both. |
| 4 | `src/features/create/pages/CreateRoomPage.module.css` | Cosmetic only: add `.tabs`, `.tab`, `.tabActive`, `.select` class definitions — the new tab/select markup in `CreateRoomPage.jsx` currently renders unstyled (no layout, no active-state styling) but is not functionally broken. |
| 5 | `src/features/room/pages/RoomPage.module.css` | Cosmetic only: add a `.badge` class — the new "Direct" badge next to the room title currently renders unstyled. |

## 7. Everything else checked and unaffected

- `src/features/room/hooks/useRoom.js` — unchanged, and doesn't need to
  change: it just spreads whatever fields exist on the room document
  (`setRoom({ id: roomId, ...data })`), so `videoUrl`/`videoType` pass
  through to `RoomPage.jsx` automatically.
- `src/features/room/services/livekit.js` — untouched, no video-type
  awareness needed there (it only concerns screen-share).
- `api/lib/sources.js` — selectors for `nkiri`/`netnaija`/`fzmovies` were
  broadened (more candidate CSS selectors per field) but still unverified
  against the live markup of those sites; unrelated to the sync bug.
- `api/lib/http.js`, `api/room.js`, `api/moderate.js`,
  `api/createLiveKitToken.js`, `api/cleanupStaleRooms.js` — all still
  consistent; the earlier `statusForError` fix holds.
- Firestore-side: no rule changes were made or are needed for `videoUrl` —
  `firestore.rules`'s `playerState/current` write rule
  (`isRoomHostOrCoHost(roomId) && docId == 'current'`) is field-agnostic, so
  it already permits writing a `videoUrl` key without any rule change.

## 8. Still-open items from the previous audit (unchanged, for continuity)

- `OMDB_API_KEY` still not set — OMDb search branch of `/api/search` will
  still 500.
- No runtime currently configured to execute `api/*.js` in this environment.
- No auth on `/api/search` or `/api/scrape`.
- `.env.example` still contains real-looking credentials worth rotating.

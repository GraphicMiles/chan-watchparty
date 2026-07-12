# Reusing the Scraper Inside the Watch Room (YouTube-together flow)

Goal: instead of picking a video only via the standalone `/media` (Discover)
page, let users pick a video from scraped/searched results **directly inside
the room-creation and in-room "change video" flows** that already drive the
synced YouTube player.

This file only lists **where to make the change** and **why each file is in
the chain** — no code has been written or modified.

## The one hard constraint

The synced player (`VideoPlayer.jsx`, via `react-youtube`) only knows how to
play a **YouTube video ID**. Whatever picker UI you build, it must end up
producing a YouTube video ID, the same way `extractVideoId()` does today.

That means of the scraper's three sources, only the **YouTube search**
results are directly usable as-is:

| Scraper source | Result shape | Usable in room player? |
|---|---|---|
| YouTube search (`useScraper().search(query)`, default `source='youtube'`) | `{ id, title, thumbnail, channel, url }` where `url` is a `youtube.com/watch?v=...` link | **Yes** — `id` is already the video ID |
| OMDb / "IMDb via OMDb" (`search(query, 'omdb')`) | `{ title, image, link, meta }` where `link` is an `imdb.com/title/...` page | **No** — not a YouTube ID, would need a separate YouTube lookup (e.g. search for "`<title>` trailer") to become playable |
| Manual paste-URL scrape (`scrape({ url, site })`) | `{ title, image, link, meta }` from arbitrary site markup | **No** — same problem, `link` points at a download/streaming page, not YouTube |

So the realistic integration is: **wire the scraper's YouTube-search branch
into the room's video picker**, and leave OMDb/manual-scrape results as
"discovery only" (or a future enhancement where you'd chain an OMDb result's
title into a YouTube search before it can be picked as a room video).

## Files to target

### 1. `src/features/create/pages/CreateRoomPage.jsx` — primary integration point
This is where a **new** room's video is currently chosen. Today it calls
`searchVideos()` from `shared/lib/youtube.js` directly and renders its own
small result grid (`onSearch`, `results`, `.result` buttons around line
045-176). To reuse the scraper instead of this duplicate search codepath:
- Swap the `searchVideos()` call for `useScraper().search(query)` (same
  hook the Discover page uses).
- Swap the local `.result` button grid for the same card layout the scraper
  page already renders (see `ScraperPage.jsx` for the pattern), or keep this
  page's simpler grid but feed it from `useScraper`'s `results`.
- `selectVideo(id)` already does exactly what's needed once you have a video
  ID — no change needed to that function itself.

### 2. `src/features/room/pages/RoomPage.jsx` — mid-room "change video" integration point
The host/co-host "Change video" panel (`showVideoInput`, `changeVideo()`,
around lines 265-308) is the **second** place a video is picked, this time
while already inside a live room. Today it's a single paste-URL `Input` fed
through `extractVideoId()`. To let the host search/reuse scraped YouTube
results here instead of pasting a URL:
- Add the same `useScraper()` hook and a small results grid/dropdown next to
  (or instead of) the existing paste-URL `Input`.
- On picking a result, call the existing `changeVideo`-style logic — i.e.
  still end up calling `updateRoom({ videoId, activityType: 'youtube' })`
  followed by `writePlayerState({ videoId, isPlaying: false, currentTime: 0 })`.
  Those two calls are the actual "set the room's video" mechanism; everything
  else is just how you got the `videoId`.

### 3. `src/hooks/useScraper.js` — the reusable search hook
This is the mechanism you'd import into both pages above instead of
`shared/lib/youtube.js`'s `searchVideos()`. Its `search(query, source)`
function (default `source='youtube'`) already does client-side YouTube API
calls when `VITE_YOUTUBE_API_KEY` is set, or falls back to `POST
/api/search`. No change needed to this file — just import and call it from
the two pages above.

### 4. `src/shared/lib/youtube.js` — the codepath being replaced/duplicated
`extractVideoId()` is still needed everywhere (parsing a pasted URL into an
ID). `searchVideos()` and `getThumbnail()` are the **duplicate** search
implementation `CreateRoomPage.jsx` currently uses instead of the scraper
hook — once you migrate `CreateRoomPage.jsx` to `useScraper()`, decide
whether to delete `searchVideos()`/`getThumbnail()` here or keep them as a
fallback.

### 5. `src/features/room/hooks/usePlayerSync.js` — where the picked video actually reaches the player
`writePlayerState()` (exported from this hook) is what pushes a new
`videoId` into Firestore's `rooms/{roomId}/playerState/current` doc, which is
what every viewer's player listens to (see the "Viewer reconciliation"
`onSnapshot` effect in the same file). Any new picker UI must call this the
same way `RoomPage.jsx`'s `changeVideo()` does — no changes needed inside
this file itself.

### 6. `src/features/room/hooks/useRoom.js` — where the picked video is persisted to the room doc
`updateRoom()` (exported from this hook) is what writes `videoId` +
`activityType` onto the room document itself (separate from the
`playerState` doc above — the player syncs off `playerState`, but the room
doc's `videoId` is the source of truth new joiners see). No changes needed
inside this file itself, just call it the same way `changeVideo()` does.

### 7. `api/search.js` — the server-side fallback search
Only relevant if you want the room's video search to work **without** a
`VITE_YOUTUBE_API_KEY` in the browser bundle — `useScraper().search()` falls
back to `POST /api/search` (`source: 'youtube'` branch, lines 22-47) in that
case. No changes needed unless you want the room picker to behave
differently from the Discover page's fallback behavior.

### 8. `src/features/scraper/ScraperPage.jsx` — UI reference only
Not something you'd import — it's the layout/markup to copy if you want the
room's picker to visually match the Discover page's result cards
(thumbnail + title + meta + source badge, `.grid`/`.card` classes in
`ScraperPage.module.css`). Optional; the create-room page already has its
own simpler result grid you could keep instead.

## Suggested order of changes (when you get to it)

1. `CreateRoomPage.jsx`: swap `searchVideos()` → `useScraper().search()`.
   Confirm the returned `results[].id` (YouTube search shape) lines up with
   what `selectVideo(id)` expects — it already does, since both are YouTube
   Data API v3 `search.list` shapes.
2. `RoomPage.jsx`: add the same search UI to the "Change video" panel,
   ending in the existing `updateRoom(...)` + `writePlayerState(...)` pair.
3. Decide whether to delete the now-unused `searchVideos()`/`getThumbnail()`
   in `shared/lib/youtube.js`, or keep as a fallback.
4. Leave OMDb/manual-scrape sources out of the room picker unless you also
   build a "search YouTube for this title" chaining step — they don't
   resolve to a playable video ID on their own.

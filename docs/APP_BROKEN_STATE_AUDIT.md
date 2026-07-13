# Audit — Latest Pull (`f0b0266`, "Update dependencies in package.json")

Read-only audit. Nothing was modified to produce this document.

## TL;DR — your worry is correct, and it's worse than "not configured yet"

**The app cannot start at all right now.** `src/App.jsx` was replaced with a
version that imports six files that don't exist anywhere in the repo. This
isn't a missing-config problem — it's a broken entry point. On top of that,
three new npm dependencies the new code requires (`react-player`, `hls.js`,
`react-toastify`) are declared in `package.json` but were never installed
(`package-lock.json` was deleted in this same pull and nothing reinstalled),
and the room video player was swapped for an incompatible one that the rest
of the app never got updated to match. None of the testing-checklist items
you listed (YouTube/Direct/IPTV/Sports/NSFW search) can be reached until
these are fixed, because the app won't render past its root component.

## 1. Fatal: `App.jsx` imports files that don't exist

```jsx
import { AuthProvider } from './features/auth/AuthContext'          // MISSING
import ProtectedRoute from './features/auth/ProtectedRoute'         // MISSING
import LoginPage from './features/auth/pages/LoginPage'             // MISSING
import RegisterPage from './features/auth/pages/RegisterPage'       // MISSING
import ProfilePage from './features/profile/pages/ProfilePage'      // MISSING
import styles from './App.module.scss'                              // MISSING
```

None of these exist. The actual auth code in this repo lives at
`src/shared/auth/hooks/useAuth.jsx` (a `useAuth()` hook + `AuthProvider`,
different shape entirely) and `src/features/auth/pages/AuthPage.jsx` (a
single combined page, not separate Login/Register pages). There is no
`features/profile` directory, and no `.scss` files exist anywhere in `src/`
— only `.module.css`.

This is a Vite build/import failure at the very top of the app. `main.jsx`
imports `App.jsx` directly, so nothing renders — not the home page, not the
search page, nothing — until this is fixed. This single file is the reason
the whole app is currently unreachable, independent of every other issue
below.

**Likely cause:** this looks like boilerplate from a different project
template (login/register pages, a profile page, SCSS modules) that got
pulled in wholesale instead of being adapted to this codebase's actual
structure (single combined auth page, CSS Modules, no profile page).

## 2. Missing npm packages — three new imports, zero installs

`package.json` now lists `react-player`, `hls.js`, and `react-toastify` as
dependencies, `sass` as a dev dependency, and the same pull **deleted
`package-lock.json`** without an install ever running:

| Package | Declared in package.json | Installed in node_modules |
|---|---|---|
| `react-player` | yes | **no** |
| `hls.js` | yes | **no** |
| `react-toastify` | yes | **no** |
| `sass` | yes (dev) | **no** |

`src/features/room/components/VideoPlayer.jsx` now does
`import ReactPlayer from 'react-player'` and `import Hls from 'hls.js'` at
the top level — both unresolvable imports today. `App.jsx` does
`import { ToastContainer } from 'react-toastify'` — also unresolved. Even
once `App.jsx`'s missing-file problem (§1) is fixed, the dev server won't
start cleanly until `npm install` is run (there's currently no lockfile and
no workflow configured in this environment to run it automatically).

## 3. `VideoPlayer.jsx` was rewritten with an incompatible prop interface, and nothing else was updated to match

The old `VideoPlayer` took `videoId` / `videoUrl` / `videoType` /
`isHost` / `onReady` / `onPlayerEvent`. The new one (using `react-player` +
`hls.js`) takes a completely different shape:
```jsx
export default function VideoPlayer({
  url, playing, played, volume, muted, playbackRate,
  onProgress, onDuration, onPlay, onPause, onEnded, onError, onReady, isLive,
})
```
But `src/features/room/pages/RoomPage.jsx` was **not updated** — it still
calls the component the old way:
```jsx
<VideoPlayer
  videoId={room.videoId}
  videoUrl={room.videoUrl}
  videoType={room.videoType || 'youtube'}
  isHost={canControl}
  onReady={onPlayerReady}
  onPlayerEvent={onPlayerEvent}
/>
```
None of these props exist on the new component. The new `VideoPlayer` reads
`url`, which will always be `undefined` from this call site, so its
"detect video type" effect bails out immediately (`if (!url) return`) and it
falls through to rendering an empty `ReactPlayer` with no URL — a blank
player, no error shown. Also gone are `getPlayerState`, `playVideo`,
`pauseVideo`, `loadVideoById` — the whole play/pause/seek sync API that
`usePlayerSync.js` depends on (see §4) no longer exists on this component at
all, since it's not exposed via `onReady` anymore (`onReady` here takes no
arguments).

This also references `./VideoPlayer.module.scss`, which doesn't exist (see
§2 — no `.scss` files exist in the project, and `sass` isn't installed to
compile them if they did).

## 4. `usePlayerSync.js` now assumes a player API that no longer exists

Separately from the direct-video sync gaps already documented in
`docs/DIRECT_VIDEO_SYNC_AUDIT.md` (still present, unchanged in this pull —
the `videoUrl` field was added to the default write object, but the
`getPlayerState`-based readiness checks were not touched), this hook now
calls methods (`getPlayerState()`, `playVideo()`, `pauseVideo()`,
`loadVideoById()`, `seekTo()`) that assume the *old* `VideoPlayer`'s fake
player object. The new `VideoPlayer.jsx` never calls `onReady` with any
such object — its `onReady` prop is invoked with no arguments at all. So
even once §3 is fixed to pass the right props, `usePlayerSync.js` and the
new `VideoPlayer.jsx` speak two unrelated "player object" languages and
would need to be reconciled together, not patched independently.

## 5. `UnifiedSearch.jsx` (the new all-in-one search page) has its own problems

This is the component meant to cover your testing checklist (YouTube /
Direct / IPTV / Sports / NSFW). Assuming §1–§3 get fixed and the app boots:

- **Missing stylesheet:** `import styles from './UnifiedSearch.module.scss'`
  — the file doesn't exist (same root cause as §2/§3: no `.scss` files were
  ever added, only referenced).
- **`useUnifiedSearch.js`'s `loadMore()` is broken by construction:**
  ```js
  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      return search({ layer: 'current', query: 'current', append: true })
    }
  }, [loading, hasMore, search])
  ```
  It doesn't remember the actual last-searched layer/query — it hardcodes
  the literal strings `'current'`/`'current'`. Clicking "Load More" would
  search for a layer literally named `"current"`, which
  `api/media.js`'s `switch (layer)` doesn't recognize, hitting its
  `default: return fail(res, 400, 'Unknown layer: current')` branch. Load
  More will always fail with a 400.
- **`refresh()` is a stub:** it clears the cache but never re-runs the
  current search, despite the comment `// Re-run current search if exists`.
  Not wired to any UI button today, but worth knowing before you rely on it.
- **NSFW layer is functionally empty:** `api/media.js`'s `searchNSFW()`
  always returns `[]` (a placeholder — "implement actual scrapers as
  needed"). The client-side flow (age-verification `window.confirm()`,
  18+ badge, adult tab styling) all works, but a search will always come
  back with zero results, which look identical to "nothing matched your
  query." Worth telling users this tab is a stub, or they'll think their
  search is broken.
- **IPTV layer is hardcoded to 5 placeholder channels**, three of which
  point at the same Pluto TV master playlist URL (`Pluto TV Movies`,
  `Pluto TV Action`, and `Pluto TV Sports` all share one identical `.m3u8`
  URL) and two Stirr entries with a literal `'...'` placeholder URL
  (`https://dai.google.com/linear/hls/pa/event/...`) that isn't a real,
  playable link. Searching "pluto" will return three cards that all open
  the same stream regardless of which one you click; searching for a Stirr
  channel returns a link that will fail to load.
- **Sports layer needs `FOOTBALL_DATA_KEY`** to hit the real
  football-data.org API; without it (not currently set — checked
  `.env.example`, only `VITE_YOUTUBE_API_KEY` is present there), it
  silently falls back to `getDemoSportsData()`, four hardcoded fake
  matches. Searching "arsenal" will show a fake "Arsenal vs Liverpool"
  card, not real fixture data — fine as a demo, but you should know it's
  not live data yet.
- **Direct layer (Nkiri/NetNaija/FZMovies) unauthenticated scraping,
  selectors unverified** — same caveat as previous audits: `getSiteConfig`
  selectors for these sites were written by guesswork and have not been
  checked against the sites' current live markup. `o2tv` was added to the
  scraper list in `api/media.js`'s `searchDirectLinks()` but its config in
  `api/lib/sources.js` has no `buildSearchUrl`, so `searchDirectLinks()`'s
  `if (!config?.buildSearchUrl) return` guard silently skips it — searching
  "avengers" will only ever query nkiri/netnaija/fzmovies, never o2tv,
  with no indication that a fourth source was meant to run.

## 6. Two parallel, inconsistent API endpoints exist for the same job

- `api/search.js` + `api/scrape.js` (older, still present, used by the
  original `src/hooks/useScraper.js` and `src/features/scraper/ScraperPage.jsx`)
- `api/media.js` (new, 451 lines, used by the new `useUnifiedSearch.js` /
  `UnifiedSearch.jsx`)

Both implement YouTube search and site scraping independently, with
diverging logic (e.g. `api/scrape.js` has bot-detection heuristics and
richer media-extraction from raw HTML that `api/media.js`'s
`searchDirectLinks()` doesn't have — it only uses the simpler
`parseListing()` path). Both are wired up and reachable
(`App.jsx` still routes `/scraper` to the old `ScraperPage`, and `/search`
to the new `UnifiedSearch`), so you now have two different search
experiences with two different bug surfaces, rather than one deprecating
the other. Worth deciding which one is the real one before extending either
further.

## 7. Route/page inventory after this pull

`App.jsx`'s routes (once its own import errors are fixed):
| Path | Component | Status |
|---|---|---|
| `/login`, `/register` | `LoginPage`, `RegisterPage` | **files don't exist** |
| `/` | `HomePage` (via `ProtectedRoute`, which also doesn't exist) | blocked by §1 |
| `/create` | `CreateRoomPage` | reachable once §1 fixed |
| `/room/:roomId` | `RoomPage` | reachable, but video playback broken (§3/§4) |
| `/search` | `UnifiedSearch` | reachable once §1/§2 fixed; see §5 for its own bugs |
| `/scraper` | `ScraperPage` (the older one) | reachable, functions independently of `/search` |
| `/profile` | `ProfilePage` | **file doesn't exist** |
| `*` | redirect to `/` | fine |

Note the old `AuthPage.jsx` (this repo's actual, working sign-in page) isn't
routed to at all anymore — `/login`/`/register` point at files that don't
exist, and nothing routes to `/auth` where the real page lives.

## 8. Miscellaneous, non-blocking

- Three untracked-looking scratch files were added at the repo root:
  `guide.md` (701 lines), `unified.md` (312 lines), `note.md` (72 lines) —
  worth checking whether these were meant to be committed or are leftover
  planning notes; they don't affect runtime either way.
- A screenshot (`attached_assets/Screenshot_20260712_201718_Chrome_...jpg`)
  was added to the repo; likely a debugging attachment, harmless but adds
  repo weight.
- `api/lib/sources.js` gained an `spankbang` entry marked `isNSFW: true`,
  but nothing in `api/media.js`'s `searchNSFW()` (which always returns
  `[]`) or `searchDirectLinks()` (which only iterates
  `['nkiri', 'netnaija', 'fzmovies', 'o2tv']`) ever reads it — it's
  currently dead configuration.
- The previously-reported `/create-room` vs `/create` route mismatch (from
  the prior audit) is now moot: the old `ScraperPage.jsx`'s
  `createRoomWithVideo()` still navigates to `/create-room`
  (unchanged, still wrong), but the new `UnifiedSearch.jsx`'s
  `handleResultSelect()` correctly uses `/create`. So the bug still exists
  in the old scraper page, just not in the new one.
- `statusForError` (the fix from two audits ago) is still intact and
  unaffected by this pull.

## 9. Suggested order of fixes (not performed — for your review)

1. Decide what `App.jsx` should actually be — either revert it to route to
   this repo's real pages (`AuthPage`, `HomePage`, `CreateRoomPage`,
   `RoomPage`, and pick one of `UnifiedSearch`/`ScraperPage`), or build the
   missing `AuthContext`/`ProtectedRoute`/`LoginPage`/`RegisterPage`/
   `ProfilePage`/`App.module.scss` files for real. The first is far less
   work and matches everything else in the repo.
2. Run an install so `react-player`, `hls.js`, `react-toastify`, and `sass`
   are actually present in `node_modules` (or drop whichever of these ends
   up unused once §1 is decided).
3. Reconcile `VideoPlayer.jsx` and `usePlayerSync.js` so they agree on one
   player-object shape — right now they're two independent rewrites talking
   past each other.
4. Fix `useUnifiedSearch.js`'s `loadMore()` to remember the last search's
   `layer`/`query` instead of hardcoding `'current'`.
5. Decide whether `api/scrape.js`/`api/search.js` or `api/media.js` is the
   long-term API, and retire the other to stop double-maintaining scraper
   logic.

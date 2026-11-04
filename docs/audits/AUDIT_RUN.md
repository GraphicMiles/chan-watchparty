# Chan — Consecutive App Audit (5 passes)

Baseline lint: **32 errors, 36 warnings** (build passes; runtime broken in `VideoPlayer.jsx`).

Each pass targets one audit category, fixes the issues, re-lints + re-builds, then commits locally (no push).

---

## PASS 1 — Hooks rules + ReferenceErrors (`react-hooks/rules-of-hooks`, `no-undef`)
- `VideoPlayer.jsx`: 21× undefined `isHLS` → `isHls` (ReferenceError, crashes every video render).
- `VideoPlayer.jsx`: `isLivePlayback` useCallback read `durationSec`/`videoRef` before declaration → TDZ ReferenceError at render (relocated below the state/refs it closes over).
- `RoomPage.jsx`: `searchVideos` + `fetchEpisodesForChange` useCallbacks were called *after* the `if (!user)` early return → conditional hook violation. Moved above the guard.

## PASS 2 — Use-before-define / function-calling order
- `QueuePanel.jsx`: reorder `fetchEpisodes → addToQueue → handleSearch` (they forward-referenced siblings) + make deps exhaustive.
- `VideoPlayer.jsx`: relocate `handleAiSubtitlesToggle` below `currentTime()`; add `currentTime` to deps.
- `VideoPlayer.jsx`: drop invalid `onLoad` on `<track>` (unknown DOM prop; subtitle effect already sets `track.mode`).
- `useRoom.js`: scope-disable `no-control-regex` on intentional control-char sanitization.

## PASS 3 — Stale / unused code & imports (17 → 0)
- Dropped unused imports: `Radio` (RoomCard), `ShieldAlert` (ParticipantList), `React`/`Loader2` (QueuePanel), `withRemuxSeekTime`/`getRemuxSeekTime` (usePlayerSync), `normalizeDirectUrl` (useScraper), `React` (ScraperPage, UnifiedSearch).
- Dropped unused props: `room`/`isHost` (QueuePanel), `canControl` (ParticipantList).
- Dropped dead/unused code: `episodes` local (RoomPage), `SITES` table + `site`/`setSite` state (ScraperPage), `searchMeta` destructure (UnifiedSearch).

## PASS 4 — Race conditions / stale-closure deps + media-type (2 → 0)
- `VideoPlayer.jsx`: hoist `MEDIA_ERROR_MESSAGES` + `isDemuxerError` to module scope (stable identity).
- `VideoPlayer.jsx`: add missing `isLive` to `handleError` deps (stale → wrong YouTube-live error message).
- `VideoPlayer.jsx`: add missing `toast` + `videoType` to the HLS setup effect (stale `videoType` → wrong live/VOD HLS config on type change → sync race).

## PASS 5 — Naming consistency + final verification (10 → 0)
- `VideoPlayer.jsx`: switch to named exports `import { Hls, Events, ErrorTypes, isSupported } from 'hls.js'` — resolves all `import/no-named-as-default(-member)` warnings.

## RESULT
- **Baseline:** 32 errors / 36 warnings (build passed but runtime broken in `VideoPlayer.jsx`).
- **Final:** **0 errors / 0 warnings**, vite build OK.
- 5 local commits (`audit(1/5)` … `audit(5/5)`). **Not pushed** — committed locally only, as instructed.

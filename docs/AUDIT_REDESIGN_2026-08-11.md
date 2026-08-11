# Chan — Full Audit: User Journeys, Direct Links & the Native MKV Player

**Date:** 2026-08-11 · **Scope:** app entry → watch room, with deep dives on the Direct Links journey and the Android native player · **Status:** AUDIT ONLY — no changes made.

---

## 1. Executive Summary

Chan is a watch-party app with **two very different playback worlds**:

1. **The Web world** (desktop browser, and the web layer inside the Android app): YouTube via ReactPlayer, MP4/HLS via a native `<video>` element + hls.js, and MKV via a **server-side remux proxy** (`/api/proxy?remux=1`) that converts Matroska → fMP4 on the fly.
2. **The Native world** (Android only): any URL that looks like MKV/HEVC/DownloadWella **auto-launches a separate full-screen Android Activity** (`NativeVideoPlayerActivity`) that plays the raw file with **LibVLC** (no UI controls at all) or **ExoPlayer** (default controls only).

The two worlds are **not connected**. The native player has no room awareness: no sync, no position return, no end-of-video signal, no PiP, no back/minimize affordance, and it forcibly takes over the whole device in landscape. Everything else in the room — chat, queue, participants, reactions — is unreachable while it is open. This is the single biggest UX break in the product.

Secondary themes: the **Direct Links journey is a maze** (search → show → seasons → episode → resolve → a second page that re-does the same work → room), the create flow is a **1,216-line monolith** doing 6 jobs, there are **two scraper implementations** (server API + native Android plugin) that disagree, and the room itself is a **923-line monolith** that duplicates search and episodes logic.

---

## 2. App Map (as it exists today)

```
/                     HomePage        — hero, live rooms, search, invite code, continue-watching
/auth                 AuthPage        — anonymous Firebase sign-in
/create               CreateRoomPage  — 6 jobs: YouTube pick, scraper search, O2TV browser,
                                        Nkiri episodes, direct URL paste, room creation
/room/:roomId         RoomPage        — stage (player), controls card, meta/participants,
                                        sidebar (Chat | Queue), modals
/search               UnifiedSearch   — "all" layer
/media                UnifiedSearch   — "direct links" layer (same component, isMediaRoute flag)
/scraper              → redirects to /search
api/                  room.js, media.js, proxy.js (serverless)
android/              Capacitor shell + O2TvPlugin + VideoPlayerPlugin + NativeVideoPlayerActivity
```

Entry points into a room: **Home → Start a Room (/create)**, **Home → Browse Media (/media) → pick → /create?…params → room**, **invite code on Home**, **deep link** (`chan-yz3p.vercel.app`), **Continue Watching card**.

---

## 3. User Journeys (walked end-to-end)

### Journey A — YouTube watch party (web, works OK)
1. Home → "Start a Room" → `/create`
2. Paste YouTube URL *or* search YouTube (server search via `/api/media` action=search)
3. Click result → thumbnail + "YouTube: <id>" chip appears; `checkEmbeddable()` runs
4. Capacity + private toggle → **Create Room** → creates Firestore room + playerState doc, calls `/api/room` join (3 retries), navigates to `/room/:id`
5. Room: ReactPlayer (YouTube iframe), sync via Firestore `playerState/current`, chat/queue sidebar, screen share via LiveKit (desktop only)

**Friction:** none major. YouTube is the smooth path.

### Journey B — Direct Links (web, the maze) ⭐
1. Home → "Browse Media" → `/media` (UnifiedSearch, `activeLayer='direct'`)
2. Search a show → `/api/media` `action=search, layer=direct` → results are **show listings** from Nkiri/O2TV
3. Click show → **EpisodesModal** opens (inline styled, hardcoded lime `#C6FF33` accents)
4. Pick a season → episodes → click an episode → `resolveDirectEpisode()`:
   - web path: `/api/media` resolve → gets a **DownloadWella / fsmc / direct URL**
   - Android path: `O2TvPlugin.resolveEpisode()` native scraper
5. On success → `navigate('/create?...&videoUrl=…&type=direct&showSlug=…')` — **hands off to the create page**, which:
   - re-detects the URL type
   - if it's an O2TV page (not a direct file), **re-runs the whole show→season→episode browse** (`loadO2Seasons` / scrape fallback) that was already done on /media
6. User presses **Create Room** → room created with `videoUrl` → `/room/:id`
7. In room, the VideoPlayer:
   - `.mp4/.m3u8` → web `<video>`/hls.js (remux proxy if MKV)
   - **Android + .mkv/downloadwella/HEVC → native activity auto-opens** (see §4)

**Friction:**
- **F1.** Same hierarchical browsing implemented **twice** (UnifiedSearch/EpisodesModal AND CreateRoomPage O2TV browser) — two UIs, two state machines, subtly different behavior.
- **F2.** `/media` → `/create` hand-off loses context: the create page re-resolves; sometimes the episode resolves *again* server-side (double scraping, links expire fast on these hosts).
- **F3.** Direct file URLs from Nkiri are DownloadWella `fsmc`/`index.m3u8`-style links that **require Referer/User-Agent headers** — the web player must go through `/api/proxy`, and the app must detect this per-URL. On web the MKV remux is a server-side CPU job with a **Vercel Hobby 10s deadline** (`remuxDeadline` in `api/proxy.js`) — playback can end early mid-file.
- **F4.** Mixed content: http:// direct links are blocked on the https deployment (`isMixedContent`) → dead-end error card, no automatic proxy retry.
- **F5.** On Android, `nativePlaybackUrl()` strips the `/api/proxy` wrapper and hands the **raw MKV URL** to VLC — the native player re-does the header/Referer dance itself. If the web remux was already solving a CORS issue, the native player is insulated (native HTTP stack, no CORS) — this is actually the one clean part.
- **F6.** Episode links expire → error copy tells users to "try another source", no retry/refresh affordance.

### Journey C — In-room "Change Video" (host)
1. Host clicks **Change Video** → search box appears inside the room controls card
2. Search → results list; Nkiri items expand seasons → episodes inline
3. Click Play → `changeVideo(null, item)` → writes new `videoUrl`/`videoId` to room doc → all viewers' players swap

**Friction:** this is the **third** implementation of show→episode browsing (UnifiedSearch, CreateRoomPage, RoomPage `searchVideos`/`fetchEpisodesForChange`). Three copies, drifting apart.

### Journey D — Join flows
- Invite code (home) → POST `/api/room` action=join → `/room/:id?invite=CODE`
- Deep link `https://chan-yz3p.vercel.app/room/:id` → Android intent filter → room
- "Continue Watching" (last room in localStorage, only if still "truly live")

**Friction:** joining requires a signed-in user (anonymous auth must be enabled; server verifies token). No "preview room before joining" step. Deep link host is hardcoded to `chan-yz3p.vercel.app` in the manifest — if the domain changes, deep links break silently.

---

## 4. The Native MKV Player — Deep Dive ⭐⭐

### 4.1 What the user experiences
1. Host creates a room from a direct MKV/DownloadWella link (Android app)
2. In the room, the stage shows a **static fallback panel** ("This Nkiri file is MKV/HEVC… Open Native Player")
3. The moment playback starts, **a separate full-screen Activity launches automatically** (`VideoPlayer.jsx` effect, line ~247: auto-opens when `isNativeMkvLike` && playing)
4. The screen goes **fullscreen + immersive** (system bars hidden) and is **forced to landscape**
5. **MKV/HEVC files (VLC path) have NO controls whatsoever** — VLC's `VLCVideoLayout` is attached with `attachViews(vlcLayout, null, false, false)` and **no `MediaController` is ever created**. No play/pause, no seek bar, no volume, no back button, nothing.
6. Even on the ExoPlayer path, the default controller exists but there is **no Done/Back/Close button** and no PiP button; the only way out is a system back gesture (hidden nav bar makes this non-obvious).
7. On return to the room: the web player **resumes where it was when the native player opened** — the position watched natively is lost; chat/queue/reactions were invisible the whole time; the queue's auto-next never fires (the web `onEnded` never happened).

### 4.2 Code-level findings

| # | Finding | Evidence |
|---|---------|----------|
| N1 | **Auto-launch on play** — no user consent path; the fallback panel's "Open Native Player" button is decorative because the effect opens it automatically anyway | `VideoPlayer.jsx:247-251` (`useEffect` → `openNativePlayer()`), `:1195-1230` (fallback panel) |
| N2 | **VLC mode has zero controls** — `VLCVideoLayout` has no attached controller | `NativeVideoPlayerActivity.java:70-76, 152-160` (`vlcPlayer.attachViews(vlcLayout, null, false, false)`) |
| N3 | **Fullscreen + immersive + forced landscape** | `NativeVideoPlayerActivity.java:34-37` (`FLAG_FULLSCREEN`, `hideSystemUi()`, `SCREEN_ORIENTATION_SENSOR_LANDSCAPE`) |
| N4 | **No close/minimize affordance in the UI** | `NativeVideoPlayerActivity.java` — no button views, no `onBackPressed` override, no `setResult` |
| N5 | **PiP is declared but never implemented** — `supportsPictureInPicture="true"` on both activities, but zero calls to `enterPictureInPictureMode()` anywhere | `AndroidManifest.xml:23, 29`; grep confirms no usage |
| N6 | **No position/state return** — `startActivityForResult` never used; the activity finishes silently. The room keeps the stale web position; `remuxStartSec`/sync data never updated from native playback | `VideoPlayerPlugin.java:37-51` (`openNative` just `startActivity`) |
| N7 | **Native playback is invisible to the sync engine** — no play/pause/seek events written to `playerState/current`; `usePlayerSync` heartbeat interval pauses while the WebView activity is backgrounded; other viewers' sync extrapolates from a frozen timestamp → drift on return | `RoomPage.jsx:106-118` (1s position reporter), `usePlayerSync.js` |
| N8 | **Queue auto-next is broken for native playback** — `handleVideoEnded` relies on web `onEnded` (`VideoPlayer.jsx` `onEnded={onEnded}`), which never fires in the native activity | `RoomPage.jsx:218`, `VideoPlayer.jsx` |
| N9 | **`VideoPlayerPlugin` is ~70% dead scaffolding** — an ExoPlayer + `PlayerView` are created in `load()`/`initialize()` but the view is **never attached to any window**; `play/pause/seek/getCurrentPosition/getDuration/release` operate on an invisible, unattached player. The web layer only ever calls `openNative` | `VideoPlayerPlugin.java` whole file; `VideoPlayer.jsx:228` |
| N10 | **Dual engine with silent fallback** — ExoPlayer → on any error → auto-swaps to VLC mid-stream, changing controls (from default controller to none) and buffering behavior | `NativeVideoPlayerActivity.java:107-120` (`onPlayerError` → `startVlcPlayer`) |
| N11 | **`shouldPreferVlc` is a URL guess** — `.mkv`, `downloadwella`, `fsmc`, `hevc`, `x265`, `h265` in the URL decides the engine. A `.mkv` that ExoPlayer's ffmpeg build could play goes to VLC (no controls) regardless | `NativeVideoPlayerActivity.java:96-103` |
| N12 | **Native state not seeded on open** — `startSeconds` is passed, but on return the web player isn't told where playback ended; no "resume from X" in the room | `VideoPlayer.jsx:224-239`, no counterpart on return |
| N13 | **Web fallback path is divergent** — on web (non-Android), MKV goes through the server remux proxy with seek-by-`?t=` (re-remux per seek, Hobby timeout). On Android it bypasses the proxy entirely. Same content, two completely different playback stacks | `api/proxy.js:653-896`, `VideoPlayer.jsx:160-171, 48-58` |
| N14 | **The stage is not portable** — even the web player's fullscreen is document-level; there is no "minimize player" / float / PiP concept anywhere in the room UI (the web `requestPictureInPicture` only exists for direct-stream `<video>` and is unsupported in Android WebView) | `VideoPlayer.jsx:1104-1115` |

### 4.3 Consequences (ranked)
1. **MKV rooms are single-task islands** — no chat, queue, reactions, or participant management while watching the most common direct-link format.
2. **Sync degrades** — host's native position never reaches the room; viewers re-sync to a stale time on return.
3. **Queue is broken** for MKV rooms (no auto-next, no end detection).
4. **Controls disappear** on the exact files the app exists to play (MKV/HEVC from Nkiri/DownloadWella).
5. **No way out** that a normal user discovers: hidden system bars + forced landscape + no button.
6. **Dead code** in the plugin suggests an abandoned "in-app native player" plan — the obvious fix direction (embed the player *inside* the room activity) was started and never finished.

---

## 5. Findings Catalog (all areas)

### Architecture & code organization
| ID | Severity | Finding |
|----|----------|---------|
| A1 | 🔴 High | `CreateRoomPage.jsx` = **1,216 lines / 6 responsibilities** (YouTube picker, scraper search, O2TV browser, Nkiri episodes, direct-URL handling, room creation). Hard to redesign piecemeal. |
| A2 | 🔴 High | **Three copies of show→season→episode browsing**: UnifiedSearch+EpisodesModal, CreateRoomPage O2TV browser, RoomPage `searchVideos`/`fetchEpisodesForChange`. Drift is inevitable. |
| A3 | 🔴 High | **Two scraper implementations**: server API (`api/media.js` cheerio-based) and native Android (`O2TvPlugin.java`). Different results on the same device vs web. |
| A4 | 🟠 Med | `/search`, `/media`, `/scraper` routes — 3 routes, 1 component with a flag (`isMediaRoute`). Confusing IA and dead redirect. |
| A5 | 🟠 Med | `RoomPage.jsx` = 923 lines with room state, queue, reactions, sound FX, video-change search, modals — another monolith. |
| A6 | 🟡 Low | Dead/vestigial files: `VideoPlayerPlugin` partial impl, `fix_hevc.py` ("no longer needed"), version-marker banner hack. |
| A7 | 🟡 Low | `EpisodesModal.jsx` uses **hardcoded lime `#C6FF33`** inline styles — survives outside the theme system (contrast/redesign leak). |

### Sync & playback
| ID | Severity | Finding |
|----|----------|---------|
| S1 | 🔴 High | Native player out-of-band with `playerState` (N7). |
| S2 | 🟠 Med | Remux seek (`?t=`) re-remuxes server-side per seek; Hobby 10s deadline → mid-file cutoffs on large MKVs (`api/proxy.js:863-867`). |
| S3 | 🟠 Med | Mixed-content (http://) direct links dead-end with no auto-proxy retry (`VideoPlayer.jsx:173, 1190-1210`). |
| S4 | 🟡 Low | `usePlayerSync` extrapolates from `clientTimeMs` — any long pause (e.g., native activity) snowballs drift. |

### UX / design (remaining after the dark-theme pass)
| ID | Severity | Finding |
|----|----------|---------|
| U1 | 🔴 High | Native player takeover (N1–N5) — the #1 UX break. |
| U2 | 🟠 Med | Create flow is a wall of controls: title → tabs → URL/search → results grid → O2TV browser → settings → create. No step-by-step guidance, no "what do I need" clarity. |
| U3 | 🟠 Med | `/media` → `/create` hand-off feels like a page jump mid-flow; users don't realize the room is "one click away". |
| U4 | 🟡 Low | Error copy is developer-speak ("remux", "fMP4", "codec", "CORS") in the player error card. |
| U5 | 🟡 Low | Room header duplicates controls (End/Leave in header + controls card); on mobile the header + stage + controls stack pushes chat entirely off-screen until opened. |

### Android-specific
| ID | Severity | Finding |
|----|----------|---------|
| D1 | 🟠 Med | Deep-link host hardcoded (`chan-yz3p.vercel.app`) in manifest; no intent-filter for the app scheme. |
| D2 | 🟡 Low | `android:allowMixedContent=true` + `usesCleartextTraffic=true` — permissive; fine for the content model but worth revisiting. |
| D3 | 🟡 Low | Splash/spinner still references orange `#FF6A2B` (`capacitor.config.json`) — inconsistent with the new monochrome theme. |
| D4 | 🟡 Low | No Android back-button handling *inside the room* for the native-player case (web `backButton` listener exists in `main.jsx` but is bypassed while the activity is on top). |

---

## 6. Redesign & Restructure — Recommended Direction (for the next phase)

### 6.1 The native player problem — three viable architectures

**Option 1 (smallest change, highest ROI): Civilize the Activity**
- Add a real control bar to the native activity: back/done button, play/pause, seek, volume, PiP button (implement `enterPictureInPictureMode` properly — manifest already allows it)
- Un-force orientation (allow sensor/portrait; keep landscape as a rotation)
- Return state to the web layer: `startActivityForResult` + `setResult(positionMs, isEnded, durationMs)` → Capacitor plugin resolves with the payload → VideoPlayer writes it into `playerState` and triggers `onEnded` for queue auto-next
- Keep VLC for HEVC but attach a controller UI to the VLC layout too (VLC has `MediaController` support), or fall back to VLC only when ExoPlayer actually fails
- Fix: don't auto-open; show the fallback panel as the *choice* (native vs web) and remember the choice per room

**Option 2 (best long-term): True embedded player in the room (fits "portable inside the watch room")**
- Replace the Activity with a **fragment/view embedded in the room layout** (AndroidX Media3 `PlayerView` added to the Capacitor activity's layout as an overlay view that the JS layer can show/minimize via the plugin)
- This gives: chat/queue visible beside the player, true minimize-to-corner, sync callbacks directly into the web layer, and one consistent controls UI
- This is the "VideoPlayerPlugin" the repo *started* to build (the unattached `PlayerView` in `load()`) — finish that design
- Costs: significant Android work; the WebView + overlay need z-order/gesture coordination; testing matrix grows

**Option 3 (radical simplification): one player everywhere**
- Push everything through the server remux/proxy (web) and give Android the same experience via the embedded Media3 player; delete the native Activity + VLC dependency
- Biggest simplification of the codebase, but depends on the remux proxy being reliable for HEVC MKV (it's the riskiest technical piece — codec support, CPU, 10s Hobby limit → would need a real host or worker)

**Recommendation:** Option 1 now (fixes the pain without a rewrite), Option 2 as the redesign target ("portable player"), and treat Option 3 as the north star that informs which video URLs are *allowed* into the product (e.g., prefer MP4/HLS sources, proxy MKV).

### 6.2 Journey restructure (aligns with "redesign everything")
1. **Kill the `/media → /create` hand-off.** Merge picking + room creation into one flow (create page becomes "Pick a movie → you're in" with a progress rail: *Pick source → Pick content → Room settings*). `/media` becomes an optional browse layer that drops you at step 2.
2. **One episode browser.** Extract `ShowBrowser` (search → show → seasons → episodes) into a shared component used by /media, /create, and the room's Change Video. Delete the other two copies.
3. **One scraper.** Move native O2TV scraping behind the same hook/API shape as the server one (adapter pattern); the UI stops caring where results come from.
4. **Room layout:** stage + collapsible "Now Playing" panel (title, controls, queue button) + drawer for chat/participants; native player embedded per Option 2, or PiP per Option 1.
5. **Unified routes:** `/media` = search all; `/create` = guided create; remove `/search` + `/scraper` or make them redirects.
6. **State:** pull room-creation out of the page into a `createRoom()` service; pull the player into a `useRoomPlayer` hook so web/native/PiP states share one model.

### 6.3 Priority matrix
| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | Native player: controls + back + PiP + position return (Option 1) | Med | 🔥🔥🔥 |
| P0 | Don't auto-open; explicit native/web choice, remembered per room | Small | 🔥🔥🔥 |
| P1 | Merge create + media pick flow; progress rail | Med | 🔥🔥 |
| P1 | Single shared ShowBrowser (delete 2 copies) | Med | 🔥🔥 |
| P2 | Embedded native player (Option 2) | Large | 🔥🔥 |
| P2 | Queue auto-next for native playback (needs position return) | Small | 🔥🔥 |
| P2 | Auto-proxy retry for mixed-content URLs | Small | 🔥 |
| P3 | Single scraper adapter; route cleanup; dead-code removal | Med | 🔥 |

---

## 7. Appendix — key file references

| File | Role |
|------|------|
| `src/features/create/pages/CreateRoomPage.jsx` (1216 ln) | create monolith |
| `src/features/search/UnifiedSearch.jsx`, `EpisodesModal.jsx` | /media journey, 2nd episode browser, hardcoded lime |
| `src/features/room/pages/RoomPage.jsx` (923 ln) | room monolith, 3rd episode browser |
| `src/features/room/components/VideoPlayer.jsx` (1884 ln) | 5 playback strategies + native auto-open |
| `src/features/room/hooks/usePlayerSync.js` | Firestore sync engine (web-only) |
| `android/app/src/main/java/com/chan/watchparty/NativeVideoPlayerActivity.java` | full-screen VLC/Exo activity — the problem |
| `android/app/src/main/java/com/chan/watchparty/VideoPlayerPlugin.java` | dead in-app player scaffolding |
| `android/app/src/main/java/com/chan/watchparty/O2TvPlugin.java` | native scraper (2nd scraper) |
| `api/media.js`, `api/proxy.js`, `server-lib/mkvRemux.js` | server scraper + MKV remux proxy |
| `android/app/src/main/AndroidManifest.xml` | PiP flags declared, never used; hardcoded deep-link host |

---

## 8. P0 Implementation Log (2026-08-11, after this audit)

P0 items from the priority matrix are now implemented (uncommitted):

| Audit ID | Status | Change |
|----------|--------|--------|
| N1 (auto-open) | ✅ | No more silent auto-launch. The fallback panel is now a real choice — "Open Native Player" vs "Try Web Player Anyway" — and the choice is **remembered per room** (`localStorage['chan:native-choice:<roomId>']`). It only auto-opens again if the user previously chose native for that room. `VideoPlayer.jsx` |
| N2 (VLC zero controls) | ✅ | Custom control overlay (back, title, PiP, play/pause, seek bar, elapsed/total time) drives **both** engines; ExoPlayer's default controller disabled so there is exactly one UI. VLC events marshalled to the main thread. `NativeVideoPlayerActivity.java` |
| N3 (fullscreen/forced landscape) | ✅ | Orientation now follows the sensor; immersive mode retained but the overlay is always reachable via tap. |
| N4 (no way out) | ✅ | On-screen **← Back** button + system back → `finishWithResult()`; error states keep the back button visible. |
| N5 (PiP declared but dead) | ✅ | Real PiP on API 26+: PiP button in the top bar, auto-PiP on Home while playing (`onUserLeaveHint`), play/pause RemoteAction on the PiP window, `onPictureInPictureModeChanged` returns state on close. |
| N6 (no position return) | ✅ | Plugin now uses `startActivityForResult`; activity returns `{ positionMs, durationMs, ended, wasPlaying }`; plugin resolves `openNative` with the payload. `VideoPlayerPlugin.java`, `VideoPlayerPlugin.ts` |
| N7/N8 (invisible to sync/queue) | ✅ | Web layer applies the result: room state written with the native position (viewers resync), `onEnded` fired for ended videos → queue auto-next works for native playback. `VideoPlayer.jsx` |
| N9 (dead plugin scaffolding) | ✅ | `VideoPlayerPlugin` reduced to a single `openNative` + result handling; unused ExoPlayer/PlayerView scaffolding deleted. |
| D3 (orange spinner) | ✅ | Splash spinner `#FF6A2B` → `#26262C`. `capacitor.config.json` |

**Verification:** web build passes (`npm run build` ✓, eslint clean). Android Java was reviewed by hand (no Android SDK in the sandbox) — **must compile/install via `npm run android:build` / Android Studio on a machine with the SDK** before shipping.

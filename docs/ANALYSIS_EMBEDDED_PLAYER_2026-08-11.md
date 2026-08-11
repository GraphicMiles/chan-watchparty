# Analysis: Fallback-screen Tap Bug + Collapse to a Single Embedded Native Player

**Date:** 2026-08-11 · **Status:** ANALYSIS ONLY — no code changed.

---

## PART 1 — Bug: unresponsive buttons on the "MKV/HEVC fallback" screen

### 1.1 Root cause (confirmed in code)

The buttons are fine — they're **never receiving the tap**. A transparent full-area overlay sits on top of them:

```
VideoPlayer.jsx (render):
  <div className={styles.playerWrapper}>          ← click/pointer handlers
    {isNativeMkvLike ? <div className={styles.nativeFallback}>   ← the 2 buttons
      …buttons…
    </div> : …video…}

    <div className={styles.touchCatcher} … />    ← rendered UNCONDITIONALLY, AFTER the fallback
  </div>
```

```scss
.touchCatcher {
  position: absolute;
  inset: 0;          ← covers the ENTIRE player area
  z-index: 15;       ← above the fallback panel
}
.nativeFallback { … }  ← no z-index (auto), no pointer-events rules → sits BELOW the catcher
```

**Why the taps do nothing visible:** every tap lands on `.touchCatcher` (the topmost element at that point), which calls `handleToggleControls` — it toggles the *controls overlay*, which isn't rendered on the fallback screen, so nothing visibly happens. The buttons underneath **never receive the event**.

**Why `e.stopPropagation()` on the buttons doesn't help:** the catcher is a **sibling rendered on top of the buttons**, not a parent. `stopPropagation` only stops bubbling to ancestors — it can't rescue an event that was delivered to a different (higher) element in the first place. The event never reaches the button at all.

**Same latent pattern:** the catcher also sits above error states and (by design) above the web video/HLS element to make tap-to-toggle-controls work. On the fallback screen it's purely harmful.

### 1.2 Fix options (ranked)

| # | Fix | Effort | Notes |
|---|-----|--------|-------|
| **1 (recommended)** | **Render `.touchCatcher` only when there's an actual video surface** — i.e. `!isNativeMkvLike && !error && !isMixedContent`. The fallback panel manages its own taps; the catcher's only job is tap-to-toggle on live video. | ~10 min | Cleanest; also fixes the same issue for error cards. |
| 2 | Give the fallback panel `position: relative; z-index: 20;` (above the catcher) so its buttons intercept taps. | ~5 min | Works, but leaves a dead "toggle controls" zone around the buttons and two competing tap zones — patch, not fix. |
| 3 | `pointer-events: none` on the catcher while the fallback is shown. | ~5 min | Same as #2; patchy. |
| 4 | Reorder DOM: render the catcher *before* the fallback branch. | ~5 min | Fragile — any future unconditional sibling reintroduces it. |

**Recommendation: Option 1**, and it dovetails with Part 2 (below) — once the fallback screen is deleted entirely (Part 2), the bug class disappears with it.

---

## PART 2 — Architecture: collapse to a single embedded native player (Android)

### 2.1 Target state

- **Android app:** every non-YouTube stream (direct MP4/MKV/HEVC, HLS/IP TV/sports, NSFW) plays through **one embedded native engine** (Media3 ExoPlayer, with the existing LibVLC fallback for HEVC MKV). No format-detection screen, no web-vs-native choice, no separate fullscreen activity.
- **The video renders inline in the room's existing stage area** — chat, queue, participant list, watching count, and the controls card (Change Video / Share Screen / Queue / Vibe Glow / Lock / Edit Title) stay visible and interactive around it.
- **Web (desktop/mobile browsers): unchanged** — the web player + server remux proxy remains the only path there (the native engine is Android-only).
- **YouTube: stays on the WebView player on Android.** A native ExoPlayer/VLC engine cannot play YouTube URLs (no unencrypted stream); forcing it would break the app's most-used flow. So "single path" is per-content-type: native for direct/HLS/IPTV, web for YouTube. (If truly *everything* must go native, YouTube would need youtube-dl-style extraction server-side — significant scope; flagging as a decision point.)

### 2.2 Architecture: "Native video surface + web chrome" (recommended)

The room UI stays a web app inside the Capacitor WebView. A **native player view is overlaid on the WebView at the exact rectangle of the stage**, and the web layer keeps ownership of everything around it and the sync engine.

```
┌──────────────────────────────────────────────────┐
│ Header (title · share · chat/queue · leave)   [web]  │
├──────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────┐   │
│ │ NATIVE OVERLAY VIEW (ExoPlayer/VLC)        │ ← native FrameLayout positioned over
│ │  video + letterbox + status text           │    the stage rect; everything else is
│ │  (controls bar optional — see 2.4)         │    the WebView behind it
│ └────────────────────────────────────────────┘   │
│ Controls card: Change Video · Share · Queue … [web]  │
│ Meta bar / participants / Vibe Glow          [web]   │
├──────────────────────────────────────────────────┤
│ Sidebar: Chat | Queue                          [web] │
└──────────────────────────────────────────────────┘
```

**Why this satisfies the embedding requirement:** the video *surface* is the only native piece; it sits exactly where the web player sits today (`.playerWrap`, 16:9, max-height 58vh — `RoomPage.module.css:105`). The room chrome is the WebView, untouched, fully interactive. No activity transition, no fullscreen takeover.

### 2.3 Android side — new pieces

| Piece | What it is |
|---|---|
| `ChanPlayerEngine` (extract from `NativeVideoPlayerActivity`) | Reusable engine: ExoPlayer-first, VLC fallback for `.mkv`/HEVC/DownloadWella, Referer/User-Agent headers, start-position, event callbacks (playing/buffering/ended/error). The fullscreen Activity becomes a thin shell over this engine — or is deleted once the overlay ships. |
| `RoomPlayerOverlayView` (FrameLayout) | Holds the engine's surface + letterboxing + optional mini control bar + status text. Added once to `MainActivity`'s root (decor) view, `GONE` until first play, positioned/resized via layout params from JS. |
| Plugin API (extend `VideoPlayerPlugin`, same `@CapacitorPlugin`) | `showEmbedded(url,title,startSeconds,referer)` · `setRect(x,y,w,h)` · `play/pause/seekTo(ms)/setVolume(v)` · `getPosition()` · `setFullscreen(bool)` · `closeEmbedded()` (returns `{positionMs, ended}` like P0) · `notifyListeners('playbackState', …)` for ended/error/buffering/ready. |

**Where the overlay lives:** `MainActivity extends BridgeActivity` — its content view is the Capacitor WebView. Adding a sibling `FrameLayout` overlay on top of it (decor root) gives us a native surface above the web UI, positioned per-frame by JS-measured coordinates. This is the exact design the repo **started** in the original `VideoPlayerPlugin` (the orphaned `ExoPlayer`+`PlayerView` never attached to a window) — we finish it properly.

### 2.4 JS side — VideoPlayer.jsx becomes a thin driver on Android

- Keep the room's existing **control chrome in the web layer** (scrubber, play/pause, volume, fullscreen, PiP buttons — the `.customControlsOverlay`, z-index 20, already sits above the video area and would sit above the native surface region in the WebView… *see caveat 2.6*). Drive the native engine through the plugin: play/pause/seek calls, poll `getPosition()` at ~1 Hz.
- **Sync engine (`usePlayerSync`) is untouched** — it already talks to `adapter.getCurrentTime()/playVideo()/…`; the adapter for Android becomes the plugin bridge (same shape the old dead plugin methods exposed: `play/pause/seek/getCurrentPosition`).
- **Queue auto-next works**: native `ended` event → plugin listener → JS `handleVideoEnded()`.
- **Removed entirely:** `isNativeMkvLike` fallback screen, `nativeChoice` localStorage, the "Try Web Player Anyway" path for direct streams, `nativeAutoOpenedRef` logic, `NativeVideoPlayerActivity` launch for direct streams.
- The stage keeps a **transparent placeholder div** whose sole job is measuring the rect (ResizeObserver + rAF) and calling `setRect` — cheap, no layout changes.

### 2.5 What stays, what goes

| Stays (unchanged) | Goes |
|---|---|
| Room layout, chat, queue, participants, controls card, Vibe Glow, meta bar (all web) | MKV/HEVC fallback screen + buttons |
| `usePlayerSync` Firestore engine (retargeted adapter) | `nativeChoice` per-room localStorage |
| Web player for desktop browsers & YouTube on Android | Auto-open effect (`nativeAutoOpenedRef`) |
| PiP (now entered from the overlay) | Fullscreen `NativeVideoPlayerActivity` takeover (engine extracted, activity deleted or shelled) |
| Server remux proxy (web path) | "Try Web Player Anyway" (Android) |

### 2.6 Risks / edge cases (must be handled in the design)

1. **Coordinate sync** — the overlay must track the stage rect on: orientation change, soft-keyboard open (Capacitor `resize`), safe-area insets, scroll (`.stage` is `overflow-y: auto`), and font/reflow changes. Mitigation: `ResizeObserver` on the placeholder + `setRect` on `orientationchange`/`resize`/scroll with a rAF loop; treat the overlay as a mirror of one DOM element.
2. **Z-order / tap routing** — the native overlay is above the WebView by construction, so taps on the stage hit native (fine: the web `.touchCatcher` is removed with the fallback; the web control bar would need to be **disabled for native mode** if it can't sit above a native view — **decision point 2.4**: either (a) render controls *inside* the native overlay (port the P0 custom control bar, simplest & most reliable), or (b) keep web controls and accept taps in the top ~44px of the stage falling through to the WebView. **Recommendation: (a)** — native-drawn controls, same visual language as P0, zero z-order fighting).
3. **Letterboxing** — surface must letterbox to 16:9 inside the overlay (ExoPlayer `RESIZE_MODE_FIT`), matching the current stage look.
4. **Lifecycle** — background → pause (unless PiP); activity recreation (`configChanges` already covers rotation); process death mid-play → plugin re-hydrates last position on return (the P0 result contract already returns position).
5. **Audio focus** — request/abandon like the current activity.
6. **VLC fallback inside the overlay** — same dual-engine logic; `VLCVideoLayout` attaches to the overlay's layout.
7. **Only-on-Android guard** — the overlay code path must be inert on iOS/desktop web (Capacitor platform check, as today).
8. **Testing matrix** — the hard part: MKV/HEVC/AV1 samples, DownloadWella referer links, HLS, IPTV, orientation mid-play, PiP, keyboard, background/resume, queue auto-next, multi-viewer sync.

### 2.7 Alternatives considered (and why not)

| Option | Summary | Verdict |
|---|---|---|
| **A — Native surface overlay + web chrome** (recommended) | One native view mirrors the stage; everything else web | ✅ Satisfies "inline in the room surface"; reuses P0 controls, sync, PiP; realistic effort |
| B — "One player everywhere" (drop native; web + remux proxy only) | Simplest codebase, works on all platforms | ❌ Contradicts the stated requirement; Android WebView codec limits + server CPU are exactly why native exists |
| C — Keep the Activity but non-fullscreen/windowed | Less work than A | ❌ Not inline in the room; still an activity transition; chat/queue still hidden |
| D — Rebuild the whole room as native layout | True single stack | ❌ Massive rewrite; kills web parity; no upside for this product |

### 2.8 Phased plan (when approved)

1. **Phase 1 — Bug fix (10–20 min):** render `.touchCatcher` only with a live video surface. Ship + verify.
2. **Phase 2 — Engine extraction (half day):** pull `ChanPlayerEngine` out of `NativeVideoPlayerActivity`; overlay view class; plugin `showEmbedded/setRect/closeEmbedded` + event channel. Compile-verify on a machine with the Android SDK.
3. **Phase 3 — JS integration (half day):** VideoPlayer native adapter (play/pause/seek/getPosition/ended listener), placeholder rect sync, remove fallback screen + choice + auto-open, keep web paths intact.
4. **Phase 4 — Polish (half day):** native-drawn control bar in the overlay, fullscreen & PiP from overlay, letterbox, audio focus, lifecycle guards.
5. **Phase 5 — Test matrix** (MKV/HEVC/AV1/HLS/IPTV/DownloadWella/YouTube/web) + delete `NativeVideoPlayerActivity` and dead paths.

---

## Decision points for you

1. **YouTube on Android:** keep it on the WebView player (recommended — native can't play YT), or invest in server-side YouTube extraction to make *everything* native?
2. **Controls location (2.6.2):** native-drawn control bar inside the overlay (recommended — port P0's bar) vs. keeping the web control bar above the stage?
3. **Desktop web:** confirm the web player + remux proxy stays the only desktop path (assumed yes — native is Android-only).
4. **Phase 1 bug fix:** approve shipping it immediately while the bigger build proceeds (recommended)?

---

## Implementation status (Phases 1–5, one-shot — 2026-08-11, commit follows)

| Phase | Status | What shipped |
|-------|--------|--------------|
| 1 — kill fallback + tap bug | ✅ | Fallback screen, `nativeChoice` localStorage, "Try Web Player Anyway", auto-open logic removed. `.touchCatcher` now renders only on the web path → taps can't be eaten. The whole bug class is deleted, not patched. |
| 2 — embedded engine | ✅ | `ChanPlayerEngine.java` (ExoPlayer-first, VLC fallback, Referer/UA headers — extracted from the old activity), `RoomPlayerOverlayView.java` (inline surface + native control bar + friendly status), `VideoPlayerPlugin.java` rewritten: `showEmbedded/setRect/play/pause/seekTo/getPosition/setFullscreen/closeEmbedded` + `playbackState` event channel + PiP (webview hidden in PiP). |
| 3 — JS integration | ✅ | `NativeEmbeddedPlayer.jsx`: measures the stage rect (rAF loop × devicePixelRatio) → `setRect`; drives the plugin; exposes the same adapter shape `usePlayerSync` expects → sync + queue auto-next work unchanged; `closeEmbedded` result (position/ended) fed back to the room. `VideoPlayer.jsx` renders it for **all non-YouTube content on Android** (HLS included), with **silent** web-player fallback if the native engine fails. YouTube stays on the web embed (special case, no user-visible difference). |
| 4 — UX polish | ✅ | Native-drawn control bar (play/pause, seek, time, ⛶ fullscreen, PiP) in the overlay; letterboxed (RESIZE_MODE_FIT); friendly status strings only ("Fetching media…", "Buffering… N%", "Playback finished"); all error copy friendly-mapped; no technical jargon anywhere. |
| 5 — verification | ⚠️ | Web: `npm run build` ✓, eslint ✓, structural checks on all Java ✓. **Device tests NOT run** — no Android SDK/device in the sandbox. `docs/TEST_MATRIX_EMBEDDED_PLAYER.md` has the full checklist (core playback, embedding, controls, sync/queue, lifecycle, regressions, acceptance gates). |

**Note:** `NativeVideoPlayerActivity.java` still exists but is no longer launched by any code path (the plugin no longer references it); it is kept as a compile-safe shell and should be deleted in a later cleanup commit once device tests pass.

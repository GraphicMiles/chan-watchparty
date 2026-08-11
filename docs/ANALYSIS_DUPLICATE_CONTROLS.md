# Analysis: Duplicate video controls + flaky buffering indicator (native embed)

**Date:** 2026-08-11 · **Status:** ANALYSIS ONLY — nothing executed.

---

## Issue 1 — Duplicate control bars (confirmed in code)

The screenshots show **two** control surfaces stacked for the same video:

1. **Native bar** — `RoomPlayerOverlayView`'s built-in controls (play, scrubber, times, fullscreen, PiP). It shows the **real** position (`38:03 / 51:48`) because it polls the engine every 300ms and calls `engine.play/pause/seekTo` directly. **It is wired and correct.**
2. **Web bar** — the app's `customControlsOverlay` in `VideoPlayer.jsx` (play, scrubber, volume, fullscreen, eye/filter icon). It's stuck at `00:00 / 00:00` because it's **disconnected** in native mode.

### Code evidence

| Fact | Evidence |
|---|---|
| Web bar renders **unconditionally** (not gated by native mode) | `VideoPlayer.jsx:1355` — `customControlsOverlay` has no `isNativeEmbedded` guard |
| Native bar always shown; the kill-switch exists but is never called | `RoomPlayerOverlayView.setInteractive()` defined at line 309 — grep shows **zero callers** in the plugin |
| Web bar is wired to the **web** player only | `VideoPlayer.jsx` adapter calls `playerRef.current`/`videoRef.current` (ReactPlayer/`<video>`) — both are **null** in native mode |
| Web time labels never update in native mode | `setCurrentSec`/`setDurationSec` are only called from web player events (lines 519–560, 755) |
| Both visible despite the native overlay covering the stage | Overlay rect + web bar strip don't fully overlap in practice (the web bar peeks out below/beside the native bar) |

So the failure is exactly as reported: **two surfaces, one wired (native), one decorative (web).**

---

## Issue 2 — Buffering indicator misbehaves (confirmed in code)

Two indicators exist and neither is strictly tied to real stalled state:

| Indicator | Where | Bug |
|---|---|---|
| JS status overlay (`NativeEmbeddedPlayer`) | `phase !== 'playing' && phase !== 'ended' && !errorMsg` (line 413) | Shows during **paused** and **recovering** too → "Buffering…" lingers when the user pauses or during recovery — exactly "appearing when it shouldn't" |
| Native overlay status text | `showStatus("Buffering…" / "Buffering… N%")` from engine `onBuffering` | Percent comes from VLC only (`getBuffering() < 100`), Exo always sends 0; no clamp/hide at ≥100; hidden only on the next `ready/playing` event — a slow `playing` event means it lingers |

The "Buffering… 100%" you saw is the native/JS status text persisting while the engine is between states (or while paused) — not a real stall percentage. The right behavior: **show only on a real buffering event, hide instantly on `playing`/`ready`, never on `paused`.**

---

## Two ways to fix — pick one

### Option B (RECOMMENDED): one surface = the native bar
The native bar is **already wired, already shows real position, already drives the engine**. Make it the only bar.

| # | Change | Effort |
|---|--------|--------|
| 1 | Gate the web `customControlsOverlay` by `!isNativeEmbedded` (and its touch layer — already gated) | ~1 line + CSS |
| 2 | Remove the JS status overlay in native mode (it sits *under* the native surface anyway — invisible) and rely on the native status text, which is the one over the video | small |
| 3 | Fix buffering rules in the native overlay: show only on engine `onBuffering` (clamp percent 1–99), hide instantly on `ready`/`playing`/`ended`; never show on pause | small |
| 4 | Keep fullscreen + PiP (already in the native bar) | — |

**Pros:** tiny, robust, no layout risk. **Cons:** the bar's look differs from the (now legacy) web player.

### Option A (your suggestion): one surface = the app's in-room web bar
Hide the native chrome and wire the web bar to the engine. **This is doable but has a real layering pitfall:**

| # | Change | Effort |
|---|--------|--------|
| 1 | Plugin: `showEmbedded({ controls: false })` → hide native bar + native status text | small |
| 2 | **Resize the native overlay to cover only the video region** — leave a bottom strip clear so the web bar (in the WebView underneath) is visible | med — the strip height must match the web bar's dynamic height (secondary row, fullscreen), DPR-correct |
| 3 | Make the strip touch-transparent (non-clickable view) so taps fall through to the WebView's web bar | small but fiddly |
| 4 | Wire the web bar to native: VideoPlayer adapter delegates to a `nativeAdapterRef` (play/pause/seek → plugin); a poll updates `currentSec`/`durationSec`/`isPlayingState` from `getPosition()` + events | med |
| 5 | Fullscreen + PiP buttons in the web bar → `plugin.setFullscreen` / PiP | small |
| 6 | Buffering: JS overlay driven strictly by native `buffering`/`playing` events (fix the paused bug) | small |

**Pros:** one consistent look across all playback. **Cons:** the strip-layout + touch-through is the fragile part — if the web bar changes height (secondary controls row, fullscreen, DPR), the native surface misaligns; and PiP/fullscreen re-measurement gets hairier.

---

## Recommendation

**Option B.** The native bar is already the correct, wired surface (your screenshot proves it: `38:03 / 51:48` live). Hiding the dead web bar gives you exactly one control surface driving the native player — which is the goal — with a fraction of the risk. Option A achieves the same goal but pays for it in overlay-layout fragility and re-wiring.

Both fixes include the buffering correction (strict event-driven visibility, hide instantly on playing, never on pause).

**Tell me A or B and I'll implement it** (plus the buffering fix either way).

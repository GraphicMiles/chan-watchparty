# Analysis: Player controls broken (fullscreen / ±10s / brightness) + raw filenames still visible

**Date:** 2026-08-11 · **Status:** ANALYSIS ONLY — nothing fixed yet.

---

## F1 — ±10s seek restarts the video (and Pin/AI-CC positions are wrong)

### Root cause (confirmed in code)
`jumpSeconds` computes the target from `currentTime()`:

```js
const jumpSeconds = useCallback((delta, e) => {
  ...
  const cur = currentTime()          // ← 0 in native mode!
  const target = Math.max(0, Math.min(durationSec || 999999, cur + delta))
  adapter.seekTo(target, 'seconds')
  ...
```

But `currentTime()` only reads the **web** players:

```js
const currentTime = useCallback(() => {
  if (isHls) return videoRef.current?.currentTime || 0
  const local = playerRef.current?.getCurrentTime?.() || 0   // both null in native mode
  ...
```

In native mode `videoRef`/`playerRef` are **null** (no web player mounted), so `currentTime()` always returns **0**. Therefore:
- **−10s** → `max(0, 0 − 10)` = **0** → seek to 0 → **video restarts from the beginning** (exactly what you saw)
- **+10s** → seek to 10s (wrong — should be current+10)

The same broken `currentTime()` powers:
- **Pin bookmarks** (`addStagePin` → pins get stamped at `0:00`)
- **AI CC** (`handleAiSubtitlesToggle` → subtitles are generated from `0:00` instead of the actual position)

### Fix
Make `currentTime()` consult the native adapter first (one line, heals all three):
```js
const currentTime = useCallback(() => {
  if (nativeApiRef.current) return nativeApiRef.current.getCurrentTime?.() ?? 0
  ... existing web logic ...
```
(or make `jumpSeconds`/`addStagePin`/`handleAiSubtitlesToggle` use `adapter.getCurrentTime()`, which already handles native).

---

## F2 — Fullscreen: tapping anywhere minimizes (no visible controls in fullscreen)

### Root cause (confirmed in code)
1. `handleNativeTap` exits fullscreen on **any** tap:
```js
const handleNativeTap = useCallback(() => {
  if (isNativeEmbedded && isFullscreen) {
    setIsFullscreen(false)
    VideoPlayerPlugin.setFullscreen({ fullscreen: false })...
    return
  }
  revealControls()
```
2. In fullscreen the native surface covers the **entire** screen (plugin `setFullscreen` → `MATCH_PARENT`), so the **web control bar is rendered behind the native surface** — invisible and unreachable.
3. The **native control bar is hidden** in native mode (`setInteractive(false)` from `showEmbedded({controls:false})`, and it's never re-enabled on fullscreen).
4. The native bar has **no exit/minimize button** (only play/seek/time/fullscreen/PiP).

Net result: the only interaction available in fullscreen is tap → which minimizes. A normal player shows controls in fullscreen (play/pause, seek, an exit button) and tap toggles them.

### Fix
- **Entering fullscreen:** plugin calls `overlay.setInteractive(true)` (show the native bar: play/pause/seek/time/PiP) **and** shows a new fullscreen-only **"Exit / minimize" button** (arrow-down-left) on the native bar.
- **Tapping the video** in fullscreen → toggles that native bar (normal player behavior), does **not** exit.
- **Exiting:** via the native Exit button or Android **back button** → plugin restores the stage rect + system UI, hides the bar (`setInteractive(false)`), and fires a `controlsEvent {type:'fullscreenchange', fullscreen:false}` so the JS `isFullscreen` state stays in sync (today it only syncs one-way JS→native).
- Remove the tap-exits-fullscreen branch from `handleNativeTap`.

---

## F3 — Brightness / AI Upscale / LUT filters don't work

### Root cause (two independent layers)
**(a) ExoPlayer path (MP4/HLS/IPTV)** — the overlay's `PlayerView` uses the default **SurfaceView**. Media3 video effects (`Brightness`/`Contrast`/`HslAdjustment`, applied via `setVideoEffects`) only render through a **GL surface** — with a plain SurfaceView they are silently ignored. Fix: `exoView.setUseTextureView(true)` in `RoomPlayerOverlayView` (GL-backed) so effects actually render.

**(b) VLC path (MKV/HEVC — your main direct-link content)** — effects are **skipped entirely**:
```java
Log.d(TAG, "Video effects unsupported on libVLC 3.6.5 — skipped");
```
libVLC 3.6.5's Java API has no adjust-filter methods, so brightness/contrast/filters do nothing on MKV. This is almost certainly what you tested (a Silo MKV) → "brightness doesn't work".

Fix: implement the VLC adjust filter via **libVLC media options** (the supported way to do this on 3.6.x):
```
:video-filter=adjust
:adjust-brightness=<0..2>  :adjust-contrast=<0..2>
:adjust-saturation=<0..3>  :adjust-hue=<0..360>
```
`Media.addOption(...)` before `setMedia`, then re-prepare the media and resume at the current position (same pattern as the subtitle rebuild). Neutral values → prepare without the filter.

---

## F4 — Raw filenames still visible (.html, THENKIRI.COM)

### Root cause (confirmed in code — three leaks)
1. **`ResultCard`** (UnifiedSearch — the "All/YouTube/IPTV/Sports" result grid, which is exactly what Home's search bar routes to via `/search?q=`) renders `result.title` **raw** — `cleanMediaTitle` was never applied there:
```js
<h3 className={styles.title}>{result.title}</h3>
```
2. **Create page room-title input** — `title` state initializes from the raw query param, and the cleaner is defeated by the `t ||` guard:
```js
const [title, setTitle] = useState(presetTitle)          // raw "Silo...mkv.html"
setTitle((t) => t || cleanMediaTitle(next?.title || '')) // t is truthy → keeps raw
```
So the **input field** shows `Silo.S03E01.(THENKIRI.COM).mkv.html` (the picked card cleans at render, the input doesn't).
3. **Raw titles are emitted at pick time** — `ShowBrowser` `emit(...)` passes `ep.title`/`itemTitle` raw → `UnifiedSearch.handleDirectPick` puts the raw value into `?title=` → the create page preset (same as #2).

### Fix (clean at the source, not just at render)
- `ResultCard` render: `cleanMediaTitle(result.title)` (and the `alt` attr).
- `ShowBrowser` emit: `title: cleanMediaTitle(...)` for all pick paths (youtube/direct/nkiri/o2tv).
- `UnifiedSearch.handleDirectPick`: pass `cleanMediaTitle(content.title)` into `?title=`.
- Create page bootstrap: `useState(cleanMediaTitle(presetTitle))` and change `setTitle((t) => t || ...)` to always prefer the cleaned value.

---

## What "normal player behavior" means (target, for approval)

| Behavior | Current | Target |
|---|---|---|
| Fullscreen enter | works | works |
| Fullscreen controls | none visible; tap exits | native bar visible (play/pause/seek/time/PiP) + **Exit button**; tap toggles bar; back button exits |
| ±10s skip | restarts from 0 (wrong position source) | seeks relative to **actual** position (native position source) |
| Pin / AI CC | stamped/generated from 0:00 | uses actual position |
| Brightness / AI Upscale / LUT | Exo: ignored (SurfaceView); VLC: skipped | Exo: TextureView GL effects; VLC: adjust-filter media options |
| Titles (search, create, room) | raw filenames leak in 3 places | cleaned everywhere user-facing |

**Order I'd fix:** F1 (one-liner, fixes the worst bug) → F2 (fullscreen UX) → F4 (title leaks) → F3 (effects, Java + overlay).

Say the word and I'll implement.

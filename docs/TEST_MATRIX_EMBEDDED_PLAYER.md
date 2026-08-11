# Test Matrix — Embedded Native Player (Phases 1–5)

**Date:** 2026-08-11 · **Device requirement:** physical Android device (Android 8.0+ recommended, min 6.0) with the APK from `npm run android:build` + Android Studio, or a signed release build.

> ⚠️ The web bundle was build-verified (`npm run build` ✓, eslint clean). The Android Java (`ChanPlayerEngine`, `RoomPlayerOverlayView`, `VideoPlayerPlugin`) was hand-reviewed and structurally validated but **must be compile-verified on a machine with the Android SDK** — `cd android && ./gradlew assembleDebug` — before shipping.

---

## How to install

```bash
npm install
npm run build
npx cap sync android
# open android/ in Android Studio → Run, or:
cd android && ./gradlew assembleDebug
# adb install app/build/outputs/apk/debug/app-debug.apk
```

---

## 1. Core playback (the ONE player)

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 1.1 | MP4 direct link | Create room → paste `.mp4` URL → Create | Video plays inline in the stage; **no** choice screen, **no** "Open Native Player" screen; controls bar appears on tap |
| 1.2 | MKV (HEVC) via DownloadWella/Nkiri | Search Silo → pick episode → Create | "Fetching media…" → "Buffering…" → plays (VLC engine); status text never shows technical jargon |
| 1.3 | HLS `.m3u8` (IPTV) | Create room → paste m3u8 → Create | Plays live via native engine; seek bar disabled/hidden for live |
| 1.4 | Sports / NSFW layers | /media → layer → watch | Same embedded player |
| 1.5 | YouTube | Search YouTube → pick → Create | Plays via the web embed (special case); no native overlay |
| 1.6 | Auto engine switch | Play an MP4 that ExoPlayer rejects | Silently switches to VLC; playback continues; no user-facing error |

## 2. Inline embedding in the room

| # | Test | Expected |
|---|------|----------|
| 2.1 | Video surface position | Native video appears exactly over the stage (16:9, rounded corners), **not** fullscreen |
| 2.2 | Room UI around the player | Chat, queue, participants, watching count, controls card (Change Video / Share Screen / Queue / Vibe Glow / Lock / Edit Title) all visible & tappable |
| 2.3 | Rotate to landscape | Stage (and native surface) re-measures; no black bars cut off; video still centered |
| 2.4 | Open keyboard (chat) | WebView resizes; native surface follows the stage rect (no drift) |
| 2.5 | Scroll room stage | Surface tracks scroll position |
| 2.6 | Fullscreen button | Tap ⛶ → video fills screen, system bars hidden; exit restores the stage rect + bars |
| 2.7 | PiP | Tap PiP or Home while playing → floating window over room; play/pause remote action works; closing PiP returns to room with position |

## 3. Controls (native-drawn bar)

| # | Test | Expected |
|---|------|----------|
| 3.1 | Play/pause | Toggles; icon updates; pause state syncs to other viewers |
| 3.2 | Seek bar | Drag → video seeks; time labels update; other viewers resync |
| 3.3 | Auto-hide | Bar hides after ~3.5s while playing; tap toggles it back |
| 3.4 | Buffer indicator | While buffering: "Buffering… N%" shown, bar still usable |

## 4. Sync & queue (the room logic)

| # | Test | Expected |
|---|------|----------|
| 4.1 | Two devices join | Both play in sync (±0.5s); host pause/seek propagates |
| 4.2 | Host leaves room & returns | Playback resumes from saved position (playerState) |
| 4.3 | Queue auto-next | Queue 2 videos → first ends → "Up Next" prompt → plays next (native `ended` event) |
| 4.4 | Position return | Watch to 10:00, switch video, go back → resumes near 10:00 |

## 5. Lifecycle & errors

| # | Test | Expected |
|---|------|----------|
| 5.1 | Background app (Home) | Audio pauses (unless PiP) |
| 5.2 | Kill & relaunch app | Room rehydrates; video position restored from Firestore |
| 5.3 | Expired DownloadWella link | Friendly error: "This link has expired…" + Re-resolve link button (host) → resolves → plays for everyone |
| 5.4 | No network | Friendly: "Network issue while fetching media…" |
| 5.5 | Embedded fails to start | **Silent** fallback to the web player — user never sees a broken screen |

## 6. Regression (should still work)

| # | Area | Expected |
|---|------|----------|
| 6.1 | Create flow (all steps) | Pick → Continue → settings → Create |
| 6.2 | Direct-link re-resolve at create time | DownloadWella pages resolve to the real CDN file (no "web page instead of video") |
| 6.3 | Web (desktop browser) | Web player + remux proxy still works (dev/preview only) |
| 6.4 | Dark theme | No light flashes on any new screen |

## 7. Acceptance gates

- [ ] Android app compiles (`./gradlew assembleDebug`) with the new Java files
- [ ] 1.1–1.6 pass (all media types play through the one embedded player)
- [ ] 2.2 passes (room UI usable while video plays)
- [ ] 2.6, 2.7 pass (fullscreen + PiP)
- [ ] 4.1, 4.3 pass (sync + queue auto-next)
- [ ] 5.3, 5.5 pass (friendly errors + silent fallback)
- [ ] No "MKV/HEVC", "codec", "remux", "CORS", "native player" wording anywhere in the UI

---

## Fix log — Nkiri/DownloadWella playback (2026-08-11)

Root causes found by live reproduction (resolve → proxy → stream):

1. **Remux stream was hard-cut at 8.5s** — `REMUX_DEADLINE_MS = 8_500` (tuned for
   Vercel Hobby's 10s kill) applied on Render too, truncating large MKVs mid-file
   → `MEDIA_ERR_SRC_NOT_SUPPORTED` ("Source not supported"). **Fix:** deadlines are
   now environment-aware (`IS_VERCEL` → 8.5s/9s; otherwise 120s), overridable via
   `REMUX_DEADLINE_MS` / `PROXY_MAX_DURATION_MS`.

2. **Re-resolve could never refresh an expired link** — the room only stored the
   resolved CDN URL; `nkiriResolve` on a CDN URL just echoes it back (verified
   live), so "Re-resolve link" swapped in the same dead URL. **Fix:** the original
   episode page URL is now carried end-to-end (`sourceUrl` param → `room.sourceUrl`)
   and every re-resolve walks the form from the page URL for a fresh token.

3. **JS-countdown pages weren't handled** — XFileSharing pages that only reveal
   the free link after a timer now wait the countdown out (≤20s) and re-POST with
   the freshly rendered form fields (was: immediate "JS countdown/captcha" failure).

4. **Android parity** — the embedded player's error state now shows the same
   "Re-resolve link" button (host/co-host) as the web player.

Test: re-run 1.2 (MKV via DownloadWella) and 5.3 (expired link → re-resolve).

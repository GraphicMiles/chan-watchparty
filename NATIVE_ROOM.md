# Native Room Player (Option B)

Fully-native watch-room playback for Android, launched from the web room.

```
React (web room) ── VideoPlayerPlugin.openNativeRoom() ──▶ NativeRoomActivity
                                                              │  Compose UI
                                                              │  ├─ PlayerSurface (ExoPlayer ⇄ libVLC)
                                                              │  ├─ Top bar: back · title · PiP
                                                              │  ├─ Center: play/pause
                                                              │  └─ Bottom: time · scrub · duration · speed · fullscreen
                                                              │
   web room resumes ◀── 'nativeRoomResult' { positionMs, durationMs, ended, wasPlaying }
```

## How it's wired

- `src/features/room/nativeRoomBridge.js` — `isNativeRoomSupported()`, `launchNativeRoom()`, `onNativeRoomResult()`.
- `RoomPage.jsx` — on Android, non-YouTube rooms auto-launch the native player and keep the web video **unmounted** until the native screen closes (nothing plays twice). On close, the returned position is frozen via `POST /api/room { action: 'freeze' }` and the web room resumes from it.
- Opt out anytime: `localStorage.setItem('chan:forceWebRoom', '1')` (there is also a "Use web player instead" button on the launch screen).

## Native files

| File | Role |
|---|---|
| `nativeplayer/NativeRoomActivity.kt` | Activity: edge-to-edge, insets, PiP, keep-screen-on while playing, result reporting |
| `nativeplayer/player/ManagedPlayer.kt` | ONE engine: Media3/ExoPlayer primary, libVLC fallback on failure; exposes a single `StateFlow<PlayerState>` |
| `nativeplayer/player/PlayerState.kt` | Immutable playback state |
| `nativeplayer/ui/RoomPlayerScreen.kt` | Compose screen + controls (see below) |
| `nativeplayer/ui/Theme.kt` | Chan monochrome-on-black Material3 theme |
| `nativeplayer/util/TimeFormat.kt` | h:mm:ss formatting |

## Controls & responsiveness

- **Gestures:** single tap toggles controls; double-tap left/right half seeks −10s/+10s.
- **Scrub bar:** drag to seek with a live time preview label; position/duration on both sides.
- **Speed:** cycles 1× → 1.25× → 1.5× → 2× (Exo `setPlaybackSpeed` / VLC `setRate`).
- **Fullscreen:** ⛶ toggles immersive system bars (swipe to reveal).
- **PiP:** top-bar button + auto-PiP on Home while playing; play/pause remote action; controls hidden in PiP.
- **Safe spacing:** edge-to-edge video behind the system bars; both control bars apply `safeDrawingPadding()` (status bar, gesture/nav bar, display cutout) so nothing sits under a notch or gesture bar — portrait or landscape.
- **Touch targets:** all buttons use Material `TextButton`/`IconButton` defaults (≥48dp).
- **Auto-hide:** chrome fades out after 3.5s while playing; stays up while paused/buffering.
- **Buffering:** centered spinner + percent; **errors:** friendly card with Retry (re-prepare) / Close.
- **Live streams:** LIVE badge, no scrub bar.
- **Screen keep-on** only while playing (releases otherwise).

## Building

```bash
npm run android:build   # builds the web app, syncs Capacitor, opens Gradle
# or from the android/ dir:
./gradlew :app:assembleDebug
```

New Gradle pieces (already in place):
- `android/build.gradle` — Kotlin 2.0.21 + Compose compiler plugin classpaths.
- `android/app/build.gradle` — `org.jetbrains.kotlin.android` + `org.jetbrains.kotlin.plugin.compose`, `buildFeatures.compose = true`, `kotlinOptions.jvmTarget = '17'`, Compose BOM 2024.09.03 deps (ui, foundation, material3, activity-compose, lifecycle-runtime-compose).
- Manifest: `NativeRoomActivity` (portrait/landscape config changes, PiP supported, not exported).

## Known limits / next steps

- **Chat, queue, participants, AI tools are not yet native** — they remain in the web room behind the native screen. Next milestone: native chat/queue via the Firestore REST API (uses the Firebase ID token; no new SDK needed) or the Firebase Android SDK once `google-services.json` exists.
- YouTube rooms stay on the web embed (native YouTube would need the YouTube Player SDK — separate decision).
- The old fullscreen `NativeVideoPlayerActivity` and the embedded overlay path remain as fallbacks when `chan:forceWebRoom=1` is set.

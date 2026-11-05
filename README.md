# Chan

A watch party you can actually keep in sync. Host a room around a YouTube video,
invite people, chat while it plays, and switch to screen sharing when the video
you want is not on YouTube.

Built with React and Vite, Firebase for accounts and room state, LiveKit for
screen share, and Vercel server functions for the API. The same web build is
packaged for Android with Capacitor.

Live: https://chan-miles14.vercel.app

## Why it exists

Watching something together over a call means counting down out loud and then
drifting apart by a second or two. Chan keeps playback state as shared data
instead: whoever controls the room sets the position, and everyone follows. The
Android build exists because the place people watch things together is a phone.

## What you can do

- **Host a room** around a YouTube video and share the link.
- **Watch together in sync**, with one person driving playback and the room
  following.
- **Chat** in the room while it plays.
- **Switch to screen share** over LiveKit when the video is not a YouTube link.
- **Moderate**: kick, promote or mute a participant.
- **Install it on Android.** The APK is built by CI on every push, and the player
  handles MKV with HEVC, VP9, AV1, Opus, AC3 and FLAC audio through a
  VLC-compatible path.

## Running it

```bash
npm install
npm run dev
```

Copy `.env.example` and fill in the Firebase and LiveKit values. Without them the
app builds but cannot create or join a room.

```bash
npm run build            # production build
npm start                # node server.js
```

### Android

```bash
npm run android:build    # build the web app and sync it into the Android project
npm run android:open     # open it in Android Studio
```

Minimum Android 6.0 (API 23), package `com.chan.watchparty`. See
`ANDROID_BUILD.md` for the full build notes.

## What is not here

- Rooms depend on Firebase and LiveKit being configured. There is no offline
  mode: the point of the app is the shared session.
- Screen share needs LiveKit credentials and a browser that allows capture.
- The Android APK is a debug build produced by CI for testing, not a store
  submission.
- There is no public directory of rooms. Rooms are reached by link.

## How it is built

```
src/                 React app: rooms, player, chat, presence
api/                 Vercel functions: room, moderate, createLiveKitToken
server-lib/          shared server helpers
functions/           Firebase functions
android/             Capacitor Android project
tests/               test suite, plus Firestore rules tests through the emulator
o2tv-proxy/, o2tv-worker/   media proxy and worker for direct streams
```

### API

| Endpoint | Actions |
|---|---|
| `POST /api/room` | `join`, `leave`, `end` |
| `POST /api/moderate` | `kick`, `promote`, `mute`, bearer token required |
| `POST /api/createLiveKitToken` | issues the LiveKit JWT |

### Tests and CI

```bash
npm run lint
npm run test:rules     # Firestore rules, through the Firebase emulator
```

Two workflows run on push: `ci.yml` for the web build and `android.yml`, which
builds the APK and publishes it as an artifact.

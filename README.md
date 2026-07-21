# Chan — Watch Together

![Build Android APK](https://github.com/GraphicMiles/Chan/actions/workflows/build-android.yml/badge.svg)
![CI](https://github.com/GraphicMiles/Chan/actions/workflows/ci.yml/badge.svg)

A real-time synchronized watch party web app. Host a room around a YouTube video, invite viewers, chat together, and switch to screen sharing via LiveKit.

Built with React + Vite, Firebase Auth/Firestore, LiveKit, and Vercel server functions.

## 📱 Android App

The web app is packaged as a native Android app via **Capacitor 8**. The APK is built automatically on every push via GitHub Actions.

| Feature | Details |
|---------|---------|
| **Download APK** | [Actions tab → latest build → Artifacts](../../actions/workflows/build-android.yml) |
| **MKV Playback** | VLC-compatible remux: H.264, H.265/HEVC, VP9, AV1, Opus, AC3, FLAC |
| **Min Android** | 6.0 (API 23) |
| **Package** | `com.chan.watchparty` |

### Build locally

```bash
npm install
npm run android:build    # build web + sync to Android
npm run android:open     # open in Android Studio
```

See [ANDROID_BUILD.md](ANDROID_BUILD.md) for full details.


## API surface (consolidated)

| Endpoint | Actions |
|----------|---------|
| `POST /api/room` | `action: join \| leave \| end` |
| `POST /api/moderate` | `action: kick \| promote \| mute` (Bearer token) |
| `POST /api/createLiveKitToken` | LiveKit JWT |
| `POST/GET /api/cleanupStaleRooms` | Stale room cleanup (cron) |
| `POST /api/media` | `action: search \| scrape` (YouTube search + list metadata) |

## Developer guide

Full map of folders, files, functions, Firestore paths, and “where to fix X”:

→ **[docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md)**

## API keys & environment variables

See `.env.example` and the detailed key guide at the bottom of this file.

## Local development

1. Copy `.env.example` to `.env` and fill in values.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the dev server:
   ```bash
   npm run dev
   ```
4. For Vercel functions, use the Vercel CLI:
   ```bash
   npm i -g vercel
   vercel dev
   ```

## Deploy to Vercel

```bash
vercel --prod
```

Add all environment variables in the Vercel dashboard → Project → Settings → Environment Variables.

## IPTV catalog refresh

The IPTV layer reads the Free-TV M3U playlist by default and filters to HTTPS stream URLs. To health-check and store channels in Firestore, configure a random `CRON_SECRET` in Vercel and call:

```text
POST https://your-app.vercel.app/api/refreshCatalog
x-cron-secret: your-random-secret
Content-Type: application/json

{"action":"iptv","offset":0,"limit":50}
```

The endpoint checks a bounded batch of channels, writes results to `mediaCatalog/iptv/channels`, and returns `nextOffset` for the next scheduled batch. Use `IPTV_USE_FIRESTORE_CATALOG=true` only after the catalog has been populated. Never expose the cron secret in a URL.

The cron endpoint is intended for an external scheduler such as cron-job.org because Vercel Hobby scheduling is limited. Use only channels you are authorized to distribute.

## Provider extensibility

- **IPTV** supports the default Free-TV playlist, `IPTV_PLAYLIST_URL`, `IPTV_PLAYLISTS_JSON` for multiple trusted M3U sources, and `IPTV_CHANNELS_JSON` for additional channels. Providers are normalized and deduplicated by stream URL.
- **NSFW** uses a provider registry in `api/lib/nsfw.js`. `NSFW_PROVIDER=xvideos` selects the current adapter. Add a new provider adapter to that registry without changing the `/api/media` dispatcher. Adapters must use public, permitted pages/APIs and must not bypass login, paywall, CAPTCHA, or anti-bot controls.

## Vercel free plan notes

- **Serverless functions**: the Hobby plan gives you **12 functions per deployment**. The app has **5 functions total**: `room`, `moderate`, `createLiveKitToken`, `cleanupStaleRooms`, and `media`. The legacy `/api/search`, `/api/scrape`, and `/api/refreshCatalog` paths are routed to `/api/media` or consolidated into its action dispatcher.
- **Cron jobs**: Vercel Hobby only allows **daily** cron jobs. The previous `vercel.json` included a 15-minute cron, which causes the deploy error you saw. I removed it. To run cleanup every 15 minutes on Hobby, use an external cron service (e.g., cron-job.org) and point it at `POST https://your-app.vercel.app/api/cleanupStaleRooms`. If you set a `CRON_SECRET` environment variable, add a matching `x-cron-secret` header in cron-job.org so only your cron can trigger the endpoint. If you upgrade to Pro later, you can re-add the cron in `vercel.json`.
- **Function duration**: Hobby functions timeout at 10 seconds. `joinRoom`, `endRoom`, and `createLiveKitToken` are fast transactions. `cleanupStaleRooms` batches updates; if you have many stale rooms, it may need to be split into smaller batches.
- **Firebase free plan**: Firestore has a generous free tier (50K reads/day, 20K writes/day, 1GB stored). A watch party mostly does small real-time writes (playerState heartbeat, chat). LiveKit Cloud has its own free tier but is the only bill that typically grows with usage; track participant minutes as you scale.

## Firebase Authentication (required)

Anonymous Auth **must** be enabled or sign-in fails with `auth/admin-restricted-operation`.

1. Open [Firebase Console → Authentication → Sign-in method](https://console.firebase.google.com/project/chan-69ce6/authentication/providers)
2. Click **Anonymous** → **Enable** → **Save**
3. Wait ~30 seconds, then retry **Continue anonymously** on the app

Also publish the Firestore rules in the section below, and create the composite index for cleanup (`status` + `lastHeartbeat`) if prompted.

## Firebase security rules

Deploy these Firestore rules in Firebase Console → Firestore Database → Rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAuthed() {
      return request.auth != null;
    }

    function isOwner(uid) {
      return isAuthed() && request.auth.uid == uid;
    }

    function roomData(roomId) {
      return get(/databases/$(database)/documents/rooms/$(roomId)).data;
    }

    function participantData(roomId) {
      return get(/databases/$(database)/documents/rooms/$(roomId)/participants/$(request.auth.uid)).data;
    }

    function isRoomHost(roomId) {
      return isAuthed() && roomData(roomId).hostId == request.auth.uid;
    }

    // Use Map.get(key, default). Nullish coalescing is not valid in Firestore rules.
    function isRoomCoHost(roomId) {
      return isAuthed()
        && roomData(roomId).get('coHosts', []).hasAny([request.auth.uid]);
    }

    function isRoomHostOrCoHost(roomId) {
      return isRoomHost(roomId) || isRoomCoHost(roomId);
    }

    function isRoomParticipant(roomId) {
      return isAuthed()
        && exists(/databases/$(database)/documents/rooms/$(roomId)/participants/$(request.auth.uid));
    }

    function isMuted(roomId) {
      return isRoomParticipant(roomId)
        && participantData(roomId).get('muted', false) == true;
    }

    match /users/{uid} {
      allow read: if isAuthed();
      allow create: if isOwner(uid);
      allow update: if isOwner(uid);
    }

    match /scrapes/{scrapeId} {
      allow read: if isAuthed();
      allow create: if false; // server Admin SDK only
      allow update, delete: if false;
    }

    match /rooms/{roomId} {
      allow read: if isAuthed()
        && resource.data.status == "live"
        && (resource.data.get('isPrivate', false) != true
            || isRoomHost(roomId)
            || isRoomParticipant(roomId));

      allow create: if isAuthed()
        && request.resource.data.hostId == request.auth.uid;

      allow update: if isRoomHostOrCoHost(roomId);

      match /playerState/{docId} {
        allow read: if isAuthed() && docId == 'current';
        allow write: if isRoomHostOrCoHost(roomId) && docId == 'current';
      }

      match /participants/{uid} {
        allow read: if isAuthed();
        allow write: if false;
      }

      match /messages/{messageId} {
        allow read: if isAuthed();
        allow create: if isAuthed()
          && isRoomParticipant(roomId)
          && request.resource.data.uid == request.auth.uid
          && request.resource.data.text is string
          && request.resource.data.text.size() > 0
          && request.resource.data.text.size() <= 500
          && !isMuted(roomId);

        match /reactions/{uid} {
          allow read: if isAuthed();
          allow create, update: if isOwner(uid)
            && isRoomParticipant(roomId)
            && request.resource.data.emoji is string
            && request.resource.data.emoji.size() > 0
            && request.resource.data.emoji.size() <= 16;
          allow delete: if isOwner(uid);
        }
      }

      match /typing/{uid} {
        allow read: if isAuthed();
        allow create, update: if isOwner(uid) && isRoomParticipant(roomId);
        allow delete: if isOwner(uid);
      }
    }
  }
}
```

**Note:** After adding chat reactions, deploy the updated rules above. If you see `FAILED_PRECONDITION` on the cron cleanup, create the Firestore composite index for `rooms`: `status` ascending, `lastHeartbeat` ascending.

## API keys and where to put them

1. **Firebase Client** (browser bundle, `VITE_FIREBASE_*`)
   - From Firebase Console → Project settings → General → Your apps → Add web app → SDK config.
2. **Firebase Admin SDK** (server functions only, no `VITE_` prefix)
   - From Firebase Console → Project settings → Service accounts → Generate new private key → JSON.
   - `project_id`, `client_email`, and `private_key` map to `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`.
3. **YouTube Data API v3** (browser bundle, `VITE_YOUTUBE_API_KEY`)
   - From Google Cloud Console → APIs & Services → Credentials → Create API key.
   - Restrict the key to HTTP referrers and the YouTube Data API.
4. **LiveKit** (public URL in browser, keys server-side only)
   - From LiveKit Cloud → Project → Keys.
   - `VITE_LIVEKIT_URL` = `wss://your-project.livekit.cloud` (safe in client).
   - `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` go in Vercel environment variables only, used by `/api/createLiveKitToken`.
5. **Cron secret** (optional, server-side only)
   - Any random string you choose.
   - Used by `/api/cleanupStaleRooms` to verify requests from your external cron service.
   - Add the same value as a custom header `x-cron-secret` in cron-job.org.

**Security checks:**

- Search the build output to ensure no secret keys leak:
  ```bash
  npm run build
  grep -R "LIVEKIT_API_SECRET" dist/ || echo "No secret found — good"
  grep -R "FIREBASE_ADMIN_PRIVATE_KEY" dist/ || echo "No secret found — good"
  ```
- Any variable without `VITE_` is only available server-side in Vercel functions and is never bundled by Vite.

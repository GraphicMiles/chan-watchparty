# Chan — Watch Together

A real-time synchronized watch party web app. Host a room around a YouTube video, invite viewers, chat together, and switch to screen sharing via LiveKit.

Built with React + Vite, Firebase Auth/Firestore, LiveKit, and Vercel server functions.

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

## Vercel free plan notes

- **Serverless functions**: the Hobby plan gives you **12 functions per deployment**. This project uses **5** (`joinRoom`, `leaveRoom`, `endRoom`, `createLiveKitToken`, `cleanupStaleRooms`), so you have 7 left for future features.
- **Cron jobs**: Vercel Hobby only allows **daily** cron jobs. The previous `vercel.json` included a 15-minute cron, which causes the deploy error you saw. I removed it. To run cleanup every 15 minutes on Hobby, use an external cron service (e.g., cron-job.org) and point it at `POST https://your-app.vercel.app/api/cleanupStaleRooms`. If you set a `CRON_SECRET` environment variable, add a matching `x-cron-secret` header in cron-job.org so only your cron can trigger the endpoint. If you upgrade to Pro later, you can re-add the cron in `vercel.json`.
- **Function duration**: Hobby functions timeout at 10 seconds. `joinRoom`, `endRoom`, and `createLiveKitToken` are fast transactions. `cleanupStaleRooms` batches updates; if you have many stale rooms, it may need to be split into smaller batches.
- **Firebase free plan**: Firestore has a generous free tier (50K reads/day, 20K writes/day, 1GB stored). A watch party mostly does small real-time writes (playerState heartbeat, chat). LiveKit Cloud has its own free tier but is the only bill that typically grows with usage; track participant minutes as you scale.

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

    function isRoomHost(roomId) {
      return isAuthed() && get(/databases/$(database)/documents/rooms/$(roomId)).data.hostId == request.auth.uid;
    }

    function isRoomParticipant(roomId) {
      return isAuthed() && exists(/databases/$(database)/documents/rooms/$(roomId)/participants/$(request.auth.uid));
    }

    match /users/{uid} {
      allow read: if isAuthed();
      allow create: if isOwner(uid);
      allow update: if isOwner(uid);
    }

    match /rooms/{roomId} {
      // Public rooms are visible to everyone. Private rooms are visible to the host or existing participants.
      allow read: if isAuthed()
        && resource.data.status == "live"
        && (!resource.data.isPrivate || isRoomHost(roomId) || isRoomParticipant(roomId));

      // Only authenticated users can create rooms, and they must set themselves as host.
      allow create: if isAuthed() && request.resource.data.hostId == request.auth.uid;

      // Only the host can update the room doc (title, video, mode, heartbeat, etc.).
      allow update: if isRoomHost(roomId);

      match /playerState/current {
        allow read: if isAuthed();
        allow write: if isRoomHost(roomId);
      }

      match /participants/{uid} {
        allow read: if isAuthed();
        allow write: if false; // joins must go through the Vercel server function
      }

      match /messages/{messageId} {
        allow read: if isAuthed();
        allow create: if isAuthed()
          && request.resource.data.uid == request.auth.uid
          && request.resource.data.text is string
          && request.resource.data.text.size() > 0
          && request.resource.data.text.size() <= 500;
      }

      match /typing/{uid} {
        allow read: if isAuthed();
        allow create, update: if isOwner(uid);
        allow delete: if isOwner(uid);
      }

      match /messages/{messageId}/reactions/{uid} {
        allow read: if isAuthed();
        allow create, update: if isOwner(uid) && request.resource.data.emoji is string;
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

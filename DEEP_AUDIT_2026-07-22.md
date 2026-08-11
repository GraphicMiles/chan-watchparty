# Chan Deep Audit — 2026-07-22

## Scope
Audited the `GraphicMiles/chan-watchparty` repository across:

- Web build/Vite/React
- Android Capacitor/Gradle pipeline
- GitHub Actions workflow
- Serverless API security posture
- Dependency security
- Firebase/Firestore rule posture
- Basic secret leakage scan

## Commands run

```bash
npm ci
npm run build
npm run lint
npm audit
npm outdated --long
npx cap sync android
npx cap doctor android
```

Notes:

- Local workspace Node is v20, but Capacitor CLI v8 requires Node >=22. CI already uses Node 22, and `package.json` now declares `engines.node >=22.0.0`.
- Full local Gradle compile could not be completed in this sandbox because the Android SDK/JDK 17 stack is not available locally. The GitHub Actions workflow is the authoritative Android build environment.

## Immediate fixes applied

### 1. Identified `GROQ_API_KEY` Android APK leakage risk

The Android workflow currently passes:

```yaml
GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

The previous Android design compiled `GROQ_API_KEY` into Android `BuildConfig`, which would make the key recoverable from the APK.

I changed the design so native Android still performs the O2TV/captcha session work on-device, but sends only the captcha image to the server for OCR. The Groq key now stays server-side in `GROQ_API_KEY` and is never needed inside the APK.

### 2. Aligned Capacitor CLI major version

Before:

```text
@capacitor/cli 7.6.8
@capacitor/core 8.4.2
@capacitor/android 8.4.2
```

After:

```text
@capacitor/cli 8.4.2
@capacitor/core 8.4.2
@capacitor/android 8.4.2
```

### 3. Added Node engine requirement

Added:

```json
"engines": {
  "node": ">=22.0.0"
}
```

This matches Capacitor CLI v8 and GitHub Actions Node 22.

### 4. Restored lint tooling

The repo had `.eslintrc.json` but did not have the required lint dependencies. Added:

- `eslint`
- `@babel/eslint-parser`
- `@babel/preset-react`
- `eslint-plugin-react`
- `eslint-plugin-react-hooks`
- `eslint-plugin-import`

Also added:

```json
"lint": "eslint . --ext .js,.jsx,.ts,.tsx"
```

### 5. Fixed missing `AlertCircle` import

`src/features/search/UnifiedSearch.jsx` used `<AlertCircle />` without importing it from `lucide-react`.

### 6. Removed unused/missing Ionic dependency usage

`src/hooks/useO2TvNative.ts` imported `@ionic/react`, but that package is not installed. Replaced with Capacitor's built-in platform check:

```ts
Capacitor.isNativePlatform()
```

### 7. Updated safe dependency versions

Updated:

- `livekit-client` to `^2.20.2`
- direct `uuid` to `^11.1.1`

## Current validation results

### Web build

Status: PASS

```text
✓ built in ~12s
```

Remaining build warnings:

- Sass legacy JS API warnings from dependency/tooling path.
- Vite chunk-size warnings:
  - `vendor-player` > 500 kB
  - `RoomPage` > 500 kB

These are performance warnings, not build blockers.

### Lint

Status: PASS with warnings

Warnings remaining:

```text
src/features/search/UnifiedSearch.jsx
  React Hook useCallback has a missing dependency: 'searchDirect'
  React Hook useCallback has a missing dependency: 'fetchSeasons'
```

These should be cleaned up in a small follow-up refactor by moving callbacks above dependents or splitting direct-search logic.

### Capacitor

After sync, Capacitor Android doctor passes under matching dependencies in CI. Locally, Capacitor CLI v8 refuses to run on Node 20, which is expected after declaring Node >=22.

## High-priority findings

### HIGH — Android secret leakage risk through `BuildConfig`

File:

```text
android/app/build.gradle
```

Previous risky pattern:

```gradle
buildConfigField "String", "GROQ_API_KEY", "\"${System.getenv('GROQ_API_KEY') ?: ''}\""
```

Risk:

- Anything placed in Android `BuildConfig` is recoverable from the APK.
- API keys such as Groq keys must not be shipped inside a mobile app.

Mitigation implemented:

- Removed the Android `GROQ_API_KEY` `buildConfigField`.
- Added server action `solveCaptchaImage` in `/api/media`.
- Native Android now downloads the O2TV captcha image locally, sends only the image to `/api/media`, receives the solved text, and submits the captcha locally with the same on-device session/cookies.

Required deployment config:

- Set `GROQ_API_KEY` on the server deployment platform, e.g. Vercel/Render.
- Set `VITE_API_URL` for Android/Capacitor builds to the public API origin, e.g. `https://your-app.vercel.app`.
- Do not put Groq keys in `VITE_` variables or Android Gradle `BuildConfig`.

### HIGH — Dependency audit still reports 20 vulnerabilities

After non-breaking `npm audit fix`, remaining:

```text
20 vulnerabilities: 18 moderate, 2 high
```

Main causes:

- `vite`/`esbuild` advisory in dev server path. Fix requires Vite major upgrade.
- `undici` through Firebase packages.
- `firebase-admin` transitive `uuid`/Google Cloud packages. Fix requires Firebase Admin major upgrade.

Recommended next step:

- Test and upgrade:
  - `firebase` to latest major compatible version.
  - `firebase-admin` to `^13.10.0`.
  - `@google-cloud/firestore` to latest compatible version.
  - Vite only after verifying React/Vite plugin compatibility.

### HIGH — Proxy is permissive by default

File:

```text
api/proxy.js
```

Good:

- It validates URL protocol.
- It blocks obvious localhost/private textual hostnames.
- It supports `PROXY_ALLOWED_DOMAINS`.

Risk:

- If `PROXY_ALLOWED_DOMAINS` is not configured, the proxy permits all public domains.
- It does not perform DNS resolution checks against DNS rebinding or public hostnames that resolve to private IPs after lookup.

Recommended next step:

Set `PROXY_ALLOWED_DOMAINS` in production, for example:

```json
[".o2tv.org", ".tvshows4mobile.org", ".youtube.com", ".googlevideo.com"]
```

Only include domains the app truly needs.

### MEDIUM — API CORS is broadly permissive

File:

```text
server-lib/http.js
api/proxy.js
```

Current pattern includes:

```http
Access-Control-Allow-Origin: *
```

For Bearer-token APIs, wildcard CORS is less dangerous than cookie auth, but still increases abuse surface.

Recommendation:

- Restrict app APIs to known app origins.
- Keep proxy media CORS broad only if absolutely required for video playback.

### MEDIUM — Firestore rules expose public room/user data to all authenticated users

File:

```text
firestore.rules
```

Examples:

```firestore
match /users/{uid} {
  allow read: if isAuthed();
}

match /rooms/{roomId} {
  allow read: if isAuthed();
}
```

Risk:

- Any signed-in anonymous user can read all users and all rooms.

Recommendation:

- Make user profiles read-minimal.
- Split public room metadata from private room internals.
- For private rooms, restrict read to participants or invite-code-validated joins.

### MEDIUM — Native TypeScript files are not currently part of the Vite build path

Files:

```text
src/hooks/useO2TvNative.ts
src/native/O2TvPlugin.ts
src/native/O2TvWeb.ts
```

They are not imported by the active app path, so Vite build passes. If later imported, the project may need a TypeScript-aware lint/build setup.

Recommendation:

- Either fully integrate TypeScript support or convert these files to `.js`/`.jsx`.

### MEDIUM — Bundle size/performance

Large chunks:

```text
vendor-player ~552 kB
RoomPage ~647 kB
vendor-firebase ~444 kB
```

Recommendation:

- Lazy-load room/player features.
- Lazy-load `react-player` providers only when needed.
- Consider splitting Firebase-heavy code by route.

## Positive findings

- Web production build passes.
- Capacitor sync succeeds.
- Android workflow now installs SDK 35 explicitly.
- `BuildConfig` generation was fixed earlier.
- No real secret value was found committed in repo files by regex scan.
- Firestore rules prevent clients from writing participant documents directly.
- Room API validates Firebase ID tokens for room state-changing actions.
- Cron cleanup requires a configured `CRON_SECRET`.

## Recommended next work order

1. Re-run GitHub Actions Android build with latest commit.
2. Remove Android `GROQ_API_KEY` BuildConfig usage entirely and route native captcha solving through server.
3. Add production `PROXY_ALLOWED_DOMAINS`.
4. Upgrade Firebase/Firebase Admin/Vite in a controlled branch.
5. Refactor `UnifiedSearch.jsx` callback dependency warnings.
6. Decide whether to keep TypeScript files and add proper TS parser/build support.
7. Code-split `RoomPage` and player provider chunks.

## Security reminder

A GitHub personal access token was pasted into chat earlier. It should be revoked and replaced immediately in GitHub Developer Settings.

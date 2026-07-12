# On-Demand Media Scraper — Architecture & Connections for real

This document maps every file involved in the "Discover" (scraper) feature,
exactly how they connect to each other and to the rest of the app, the exact
imports/dependencies each file needs, and what's still missing for it to be
fully functional.

The feature is **on-demand only, by design**: nothing runs automatically or on
a schedule. Every lookup fires exactly once, only when a user submits a
search or pastes a URL.

## 1. npm dependencies you need

Already in `package.json` — nothing to install for these:

| Package | Version | Used by | Import statement |
|---|---|---|---|
| `cheerio` | `^1.0.0-rc.12` | `api/scrape.js` | `import * as cheerio from 'cheerio'` |
| `firebase-admin` | `^12.0.0` | not used by the scraper yet, but available for persistence (§6.6) or ID-token verification (§6.3) | `import { getDb } from './lib/firebaseAdmin.js'` (see `api/room.js` for the exact pattern already used elsewhere in this app) |
| `firebase` | `^10.12.0` | client SDK | `import { db } from '../../shared/lib/firebase.js'` (only needed if you add client-side Firestore reads/writes to the scraper) |
| `react`, `react-dom` | `^18.3.0` | `ScraperPage.jsx` | `import { useState } from 'react'` |
| `react-router-dom` | `^6.23.0` | `App.jsx` route registration | `import { Route } from 'react-router-dom'` |

Removed, only needed if you rebuild a local dev server to run `api/*.js`:

| Package | Version | Why it was removed | If you need it back |
|---|---|---|---|
| `express` | `^4.22.2` | Was only used by a custom `server.js` dev server, deleted per a "don't run this in Replit anymore" request | `npm install express`, then write your own server (see §6.1) |

Not installed, and **not needed** — both remaining network calls use the
native global `fetch()`:

- `api/search.js` → OMDb + YouTube REST calls
- `api/scrape.js` → fetching the pasted page's HTML
- `src/hooks/useScraper.js` → the client-side YouTube call

**Node version**: make sure your runtime is **Node 18+** (whatever replaces
the removed `.replit` module pin). Both server files rely on the global
`fetch()` API, unavailable in older Node without a polyfill like
`node-fetch`.

## 2. High-level flow

```
Browser                                          Server (api/*.js)
────────────────────────────────────────────     ─────────────────────────────
App.jsx (route /media)
   │
   ▼
ScraperPage.jsx  ──calls──▶  useScraper.js
                                  │
                    ┌─────────────┼──────────────────┐
                    │             │                   │
              search('omdb')  search('youtube')   scrape({url})
                    │             │                   │
                    │        (client key present?)    │
                    │        ├─ yes → fetch() directly │
                    │        │   to Google's API       │
                    │        └─ no  → POST /api/search │
                    │                                  │
                    ▼                                  ▼
             POST /api/search  ─────────────▶  api/search.js
                                                    │
                                                    ▼
                                             OMDb REST API
                                             (omdbapi.com)
                                                    or
                                             YouTube Data API v3
                                             (googleapis.com)

                                             api/scrape.js  ◀── POST /api/scrape
                                                    │
                                                    ├─ api/lib/sources.js  (site CSS selectors)
                                                    ├─ api/lib/http.js     (ok/fail/preflight helpers)
                                                    ├─ api/lib/response.js (raw res.writeHead/end)
                                                    └─ cheerio (HTML parsing)
                                                    │
                                                    ▼
                                             Third-party site (fetch + parse HTML)
```

No results are persisted anywhere — everything lives in React state
(`useScraper`'s `results`) for the duration of the page view. There is a
`scrapes` collection defined in `firestore.rules`, but nothing currently
writes to it (see §6.6).

## 3. File-by-file breakdown

For each file: what it does, its exact import list, and what it connects to.

### `src/App.jsx`

Registers the route. Only relevant lines:
```js
import { ScraperPage } from './features/scraper/index.js'
// ...
<Route path="/media" element={<ScraperPage />} />
```
Sits alongside `/`, `/auth`, `/create`, `/room/:roomId` inside the shared
`AuthProvider` / `ToastProvider` / `BrowserRouter` tree — that's the only
reason `ScraperPage` has access to `useAuth()` and toasts without extra setup.

**No new imports needed here** if the feature already exists; if you're
building it from scratch, this is the one line to add to wire it up:
`import { ScraperPage } from './features/scraper/index.js'` plus the
`<Route>` entry.

### `src/features/scraper/index.js`

Barrel file. Should contain exactly:
```js
export { ScraperPage } from './ScraperPage.jsx'
```
This is the only file `App.jsx` imports from directly — keeps the route
registration decoupled from the feature's internal file layout.

### `src/features/scraper/ScraperPage.jsx`

The UI. Full import list:
```js
import { useState } from 'react'
import { useAuth } from '../../shared/auth/hooks/useAuth.jsx'
import { useScraper } from '../../hooks/useScraper.js'
import { Button, Input, Card, Badge, EmptyState, Skeleton } from '../../shared/ui/index.js'
import { Header, Layout } from '../../shared/layout/index.js'
import styles from './ScraperPage.module.css'
```

Connects to the rest of the app via:
- `useAuth()` → reads `user` (to show the signed-in header / sign-out
  button) but **does not gate access** — no redirect if `user` is null,
  unlike `CreateRoomPage`/`RoomPage`. Anyone who can load `/media` can use
  the search form. If you want to require sign-in, add the same pattern
  those pages use (check `user`, `navigate('/auth')` if absent) inside a
  `useEffect`.
- `useScraper()` → the only place that talks to the network. The page
  itself never calls `fetch`.
- `../../shared/ui/index.js` → `Button`, `Input`, `Card`, `Badge`,
  `EmptyState`, `Skeleton` — the same shared component kit used by
  `HomePage`, `CreateRoomPage`, etc. Reuse these rather than writing new
  ones so the page matches the rest of the app.
- `../../shared/layout/index.js` → `Header`, `Layout` — same page chrome as
  every other route.
- `./ScraperPage.module.css` → page-local CSS Module; doesn't leak into or
  depend on global styles.

Local state / control flow you need to replicate if rebuilding:
```js
const [mode, setMode] = useState('movies')       // 'movies' | 'youtube'
const [movieQuery, setMovieQuery] = useState('')
const [movieSite, setMovieSite] = useState('omdb')
const [manualUrl, setManualUrl] = useState('')
const [ytQuery, setYtQuery] = useState('')
```
- `SEARCHABLE_SITES = [{ value: 'omdb', label: 'IMDb (via OMDb)' }]` — sites
  with title search.
- `MANUAL_SITES = [nkiri, netnaija, fzmovies, custom]` — sites where the
  user must paste the page URL themselves.
- Which group `movieSite` is in decides whether the movies-tab form submit
  calls `search(movieQuery, movieSite)` or `scrape({ url: manualUrl, site: movieSite })`.
- The YouTube tab always calls `search(ytQuery)` (defaults `source` to `'youtube'`).

### `src/hooks/useScraper.js`

The single integration point between the UI and the backend. No external
imports beyond React itself:
```js
import { useState, useCallback } from 'react'
```
It reads `import.meta.env.VITE_YOUTUBE_API_KEY` directly (Vite env var, no
import needed) and calls the browser's native `fetch()`.

Exposes `{ scrape, search, results, lastQuery, loading, error, clear }`.

- `scrape({ url, query, site })` → `POST /api/scrape`. Used today only for
  the "paste a URL" manual sites (`query` is accepted by the API but no UI
  path currently sends it — see §6.4).
- `search(query, source = 'youtube')`:
  - `source === 'omdb'` → `POST /api/search` with `{ query, source: 'omdb' }`.
    Always server-side; OMDb has no referrer restriction.
  - `source === 'youtube'` **with** `VITE_YOUTUBE_API_KEY` set → calls
    `https://www.googleapis.com/youtube/v3/search` **directly from the
    browser**. This is required, not optional: this project's YouTube key is
    referrer-restricted by Google, so a server-side call (no browser
    `Referer` header) gets rejected outright.
  - `source === 'youtube'` **without** a client key → falls back to
    `POST /api/search` with `{ query, source: 'youtube' }`, for setups using
    an unrestricted server-side key instead.
- `postJson()` (local helper, top of file) treats any `!res.ok || !data.success`
  as failure and throws `data.error` — this is what surfaces as the "Search
  failed" card in `ScraperPage.jsx`.

### `api/search.js`

Server handler (Vercel-style: `export default function handler(req, res)`).
Import list:
```js
import { preflight, ok, fail } from './lib/http.js'
```
No cheerio, no firebase-admin — this file only calls REST APIs and reshapes
JSON.

Branches on `req.body.source`:
- `'omdb'` → reads `process.env.OMDB_API_KEY` → calls
  `https://www.omdbapi.com/?apikey=...&s=<query>` → maps `omdbData.Search[]`
  into `{ title, image, link, meta, source: 'imdb' }`. Returns
  `{ success: true, count: 0, results: [] }` (not an error) if OMDb reports
  no matches.
- `'youtube'` → reads `process.env.YOUTUBE_API_KEY` **or**
  `process.env.VITE_YOUTUBE_API_KEY` as fallback → calls
  `https://www.googleapis.com/youtube/v3/search` → maps `items[]` into
  `{ id, title, thumbnail, channel, published, url, source: 'youtube' }`.
- Anything else → `400 Unknown source "<source>"`.

### `api/scrape.js`

Server handler. Import list:
```js
import * as cheerio from 'cheerio'
import { preflight, ok, fail } from './lib/http.js'
import { getSiteConfig, resolveUrl } from './lib/sources.js'
```

- `fetchHtml(url)` — fetches with an 8s timeout via `AbortController` and a
  browser-like `User-Agent` header, then runs bot-challenge-page detection:
  a small set of highly specific markers (`gokuprops`,
  `awswafcookiedomainlist`, `cf-chl-bypass`, `cf_chl_opt`) checked
  regardless of page size, plus a set of generic phrases
  (`checking your browser`, `are you a human`, etc.) checked **only** on
  short (<5KB) responses, to avoid false-positiving on long legitimate pages
  that happen to mention one of those words once.
- `parseResults(html, url, site)` — loads HTML with `cheerio.load()`,
  iterates `config.items`, extracts `title` / `image` / `link` / `meta` per
  the site's CSS selectors from `api/lib/sources.js`, resolves relative
  URLs via `resolveUrl()`, dedupes by resolved link, caps at 40 results.
- `handler()` — accepts `{ url, query, site }`. The `query` branch checks
  `config.buildSearchUrl`, which **no `SITE_CONFIGS` entry defines anymore**
  (removed when IMDb scraping was replaced by the OMDb API in
  `api/search.js`). This branch is dead code today; every real call should
  go through the `url` (paste-a-page) path. See §6.4 to clean this up.

### `api/lib/sources.js`

Static config, **zero imports**. Exports:
- `SITE_CONFIGS` — one entry per manual-paste site (`nkiri`, `netnaija`,
  `fzmovies`, `custom`), each `{ label, items, title, image, link, meta }`
  as CSS selector strings. **These selectors are unverified placeholders**
  written without fetching real markup from those sites.
- `getSiteConfig(site)` — returns the matching config, or `custom` if the
  `site` key is unknown.
- `resolveUrl(src, baseUrl)` — normalizes protocol-relative (`//cdn...`),
  root-relative (`/img.jpg`), and plain relative (`foo.html`) URLs against
  the page's own URL, using the native `URL` global (no import needed).

Only `api/scrape.js` imports from this file.

### `api/lib/http.js`

Import list:
```js
import { sendResponse } from './response.js'
```
Shared response helpers used by **every** `api/*.js` handler in the project
— `search.js`, `scrape.js`, `room.js`, `createLiveKitToken.js`,
`moderate.js`, `cleanupStaleRooms.js`:
- `JSON_HEADERS` — includes permissive CORS headers (`Access-Control-Allow-Origin: *`, etc.)
- `preflight(req, res, { methods })` — handles `OPTIONS` requests and
  rejects disallowed methods with `405`. Returns `true` if it fully handled
  the request (caller should `return` immediately).
- `ok(res, body, status = 200)` / `fail(res, status, error)` — thin
  wrappers around `sendResponse`.

### `api/lib/response.js`

**Zero imports.** `sendResponse(res, status, body, headers)` is a thin
wrapper around the raw Node `http.ServerResponse` (`res.writeHead` /
`res.end`), because these handlers are written Vercel-style and can't
assume an Express-like `res.status().json()`.

### `.env.example` / actual env vars

What the feature reads, and from where:

| Variable | Read in | Client or server | Status |
|---|---|---|---|
| `VITE_YOUTUBE_API_KEY` | `src/hooks/useScraper.js` (via `import.meta.env`), `api/search.js` (via `process.env`, fallback) | Client-bundled (public) | Present in `.env.example` |
| `OMDB_API_KEY` | `api/search.js` | Server-only | **Not present** — get one free at `https://www.omdbapi.com/apikey.aspx` |
| `YOUTUBE_API_KEY` | `api/search.js` (preferred over the `VITE_` one, if set) | Server-only | Not documented anywhere; optional, only needed if you want an unrestricted server-side YouTube key instead of the referrer-restricted client one |

### `firestore.rules`

Defines a `scrapes` collection (not yet used):
```
match /scrapes/{scrapeId} {
  allow read: if isAuthed();
  allow create: if false; // server Admin SDK only
  allow update, delete: if false;
}
```
Nothing in `api/scrape.js` or `api/search.js` writes to it today — it's
provisioned for persistence but unused (§6.6).

## 4. Cross-cutting connections to the rest of the app

- **Auth**: `ScraperPage.jsx` reads `useAuth()` for display only; it does
  not require a session to function, unlike `CreateRoomPage`/`RoomPage`
  which redirect unauthenticated users. The real security boundary today is
  nonexistent — nothing on the server checks who's calling (§6.3).
- **Shared UI kit**: `Button`, `Input`, `Card`, `Badge`, `EmptyState`,
  `Skeleton`, `Header`, `Layout` (all from `src/shared/ui/` and
  `src/shared/layout/`) are shared with every other feature (`home`,
  `create`, `room`, `auth`). Changing these components affects the scraper
  page too, and vice versa.
- **API layer conventions**: `api/scrape.js` and `api/search.js` follow the
  same `preflight` / `ok` / `fail` pattern as every other handler in `api/`.
  Changing `api/lib/http.js` or `api/lib/response.js` affects all of them,
  not just the scraper.
- **No runtime/server included.** These are Vercel-style
  `export default function handler(req, res)` files with no bundled way to
  run them locally (the previous custom Express dev server, `server.js`,
  was deleted). To use them you need either a Vercel deployment, or your
  own Node/Express (or similar) wrapper — see §6.1 for exactly what that
  needs to do.

## 5. Data shapes

Every result — regardless of source — is normalized to roughly:
```js
{
  title: string,
  image: string | null,      // OMDb poster / scraped <img> src
  thumbnail: string | null,  // YouTube only
  link: string | null,       // OMDb → imdb.com title page; scrape → resolved <a href>
  url: string | null,        // YouTube only → watch URL
  meta: string | null,       // OMDb → Type; scrape → matched .meta/.date text
  channel: string | null,    // YouTube only
  source: 'imdb' | 'youtube' | 'nkiri' | 'netnaija' | 'fzmovies' | 'custom',
}
```
`ScraperPage.jsx`'s result card renders `image ?? thumbnail`, `link ?? url`,
and `meta ?? channel` — any new source just needs to map into this same
shape to render correctly without touching the UI.

## 6. What's missing for full functionality (in priority order)

### 6.1 A runtime to execute `api/*.js`
These are plain Vercel-style handlers with no server. Two options:
- **Deploy to Vercel** — zero extra code, `api/*.js` files are picked up
  automatically by convention.
- **Write your own Node server.** It needs to, for each file in `api/`:
  1. Dynamically `import()` the module.
  2. Parse the JSON request body (e.g. `express.json()`, or Node's built-in
     body handling) before calling the handler — every handler reads
     `req.body` as an already-parsed object.
  3. Call `module.default(req, res)`.
  4. Bind to whatever host/port your environment requires.
  Minimal shape (Express example — requires `npm install express` first):
  ```js
  import express from 'express'
  import scrapeHandler from './api/scrape.js'
  import searchHandler from './api/search.js'
  // ...import the rest of api/*.js similarly

  const app = express()
  app.use(express.json())
  app.post('/api/scrape', scrapeHandler)
  app.post('/api/search', searchHandler)
  // ...mount the rest
  app.listen(process.env.PORT || 3000)
  ```

### 6.2 `OMDB_API_KEY`
Free key from `https://www.omdbapi.com/apikey.aspx`. Set it as
`OMDB_API_KEY` in your server's environment. Without it, `api/search.js`'s
`'omdb'` branch always returns `500 OMDb API key not configured`, so the
"Movies & shows" tab is non-functional out of the box.

### 6.3 No auth/authorization on the API routes
Anyone who can reach `/api/search` or `/api/scrape` can use them, signed in
or not. To lock this down:
1. On the client, get the Firebase ID token: `await auth.currentUser.getIdToken()`
   (from `src/shared/lib/firebase.js`'s `auth` export) and send it as an
   `Authorization: Bearer <token>` header from `useScraper.js`'s `postJson()`.
2. On the server, verify it with `firebase-admin`:
   ```js
   import { getAuth } from 'firebase-admin/auth'
   const decoded = await getAuth().verifyIdToken(token)
   ```
   `api/lib/firebaseAdmin.js` already initializes the Admin SDK for this
   project (used by `api/room.js`) — reuse it rather than re-initializing.

### 6.4 Dead `query` branch in `api/scrape.js`
Still checks for `config.buildSearchUrl`, which no `SITE_CONFIGS` entry
defines anymore. Either:
- Delete the branch (lines checking `!targetUrl && query`) since OMDb now
  owns title search entirely, or
- Repurpose it for a manual site that does have a real, verified search URL
  pattern you're comfortable hardcoding.
Also remove the now-unused `query` param from `useScraper.js`'s `scrape()`
signature and any leftover UI wiring in `ScraperPage.jsx` if you go with the
delete option.

### 6.5 Unverified CSS selectors
`api/lib/sources.js`'s `nkiri`, `netnaija`, `fzmovies` entries were written
without fetching real markup from those sites. To fix: open each site in a
browser, inspect the actual listing/result HTML, and correct `items` /
`title` / `image` / `link` / `meta` to match real selectors. The `custom`
fallback is intentionally generic and will produce noisy results (nav
links, etc.) on most real pages — expected, since it has to work on
arbitrary sites the user pastes.

### 6.6 No persistence
The `scrapes` Firestore collection exists in `firestore.rules`
(`create: if false`, Admin-SDK-only) but nothing writes to it. To add
history/caching:
```js
import { getDb } from './lib/firebaseAdmin.js'
// inside the handler, after building `results`:
await getDb().collection('scrapes').add({
  query, source, results, createdAt: FieldValue.serverTimestamp(),
})
```
(`FieldValue` is exported from `api/lib/firebaseAdmin.js` already, per its
use in `api/room.js`.)

### 6.7 Real, possibly-live credentials in `.env.example`
Including what looks like a full Firebase Admin private key and a LiveKit
secret. Rotate these before relying on this project's security boundaries —
an exposed Admin key bypasses every Firestore rule, including the one
protecting the `scrapes` collection above.

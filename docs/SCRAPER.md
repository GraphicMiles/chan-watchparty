# On-Demand Media Scraper — Architecture & Connections

This document maps every file involved in the "Discover" (scraper) feature and
exactly how they connect to each other and to the rest of the app, plus what's
still missing for it to be fully functional.

The feature is **on-demand only, by design**: nothing runs automatically or on
a schedule. Every lookup fires exactly once, only when a signed-in user submits
a search or pastes a URL.

## 1. High-level flow

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
writes to it (see §5, "What's missing").

## 2. File-by-file breakdown

### `src/App.jsx`
Registers the route: `<Route path="/media" element={<ScraperPage />} />`.
This is the only place the feature is wired into the app's router. It sits
alongside the other top-level routes (`/`, `/auth`, `/create`, `/room/:roomId`)
inside the same `AuthProvider` / `ToastProvider` / `BrowserRouter` tree, so the
scraper page automatically gets access to auth state and toast notifications
without extra setup.

### `src/features/scraper/ScraperPage.jsx`
The UI. Connects to the rest of the app via:
- `../../shared/auth/hooks/useAuth.jsx` → reads `user` (to show the signed-in
  header / sign-out button) but **does not gate access** — there's no redirect
  if `user` is null, unlike other pages. Anyone who can load `/media` can use
  the search form; the actual write-side security boundary is the Firestore
  rules and API auth (see §5, item 3).
- `../../hooks/useScraper.js` → the only place that talks to the network. The
  page never calls `fetch` itself.
- `../../shared/ui/index.js` → `Button`, `Input`, `Card`, `Badge`,
  `EmptyState`, `Skeleton` — the same shared component kit used by
  `HomePage`, `CreateRoomPage`, etc. Keeping these consistent is what makes
  the scraper page look native to the rest of the app rather than bolted on.
- `../../shared/layout/index.js` → `Header`, `Layout` — same page chrome as
  every other route.
- `./ScraperPage.module.css` → page-local styles only (tabs, form, result
  grid); does not reach into global CSS.

Local state drives two tabs:
- **Movies & shows**: a `<select>` with two option groups — "Search by title"
  (`SEARCHABLE_SITES`, currently just `omdb`) and "Paste a page URL"
  (`MANUAL_SITES`: `nkiri`, `netnaija`, `fzmovies`, `custom`). Which group is
  selected decides whether `runMovieLookup` calls `search()` or `scrape()`.
- **YouTube**: always calls `search(query)` (defaults to `source: 'youtube'`).

### `src/hooks/useScraper.js`
The single integration point between the UI and the backend. Exposes
`{ scrape, search, results, lastQuery, loading, error, clear }`.

- `scrape({ url, query, site })` → `POST /api/scrape`. Used only for the
  "paste a URL" manual sites right now (`query` is accepted by the API but
  nothing in the UI currently drives that branch — see §5, item 4).
- `search(query, source = 'youtube')`:
  - `source === 'omdb'` → `POST /api/search` with `{ query, source: 'omdb' }`.
    Always server-side; OMDb has no referrer restriction.
  - `source === 'youtube'` with `import.meta.env.VITE_YOUTUBE_API_KEY` set →
    calls `https://www.googleapis.com/youtube/v3/search` **directly from the
    browser**. This is intentional, not a shortcut: the YouTube key in this
    project is referrer-restricted by Google, so a server-side call (which
    has no browser `Referer` header) gets rejected. Calling from the browser
    is what makes referrer restriction possible/enforceable at all.
  - `source === 'youtube'` with no client key → falls back to
    `POST /api/search` with `{ query, source: 'youtube' }`, for setups that
    use an unrestricted server-side key instead.
- Both paths funnel into shared `results` / `loading` / `error` state that
  `ScraperPage.jsx` renders directly — there's no caching, retry, or
  deduplication logic.
- `postJson()` (local helper) treats any `!res.ok || !data.success` as an
  error and throws `data.error`, which is what surfaces as the red "Search
  failed" card in the UI.

### `api/search.js`
Server handler for title search. Branches on `req.body.source`:
- `'omdb'` → reads `process.env.OMDB_API_KEY`, calls
  `https://www.omdbapi.com/?apikey=...&s=<query>`, maps
  `omdbData.Search[]` into the app's result shape
  (`{ title, image, link, meta, source: 'imdb' }`). Returns `count: 0` (not an
  error) if OMDb reports no matches.
- `'youtube'` → reads `process.env.YOUTUBE_API_KEY` **or**
  `process.env.VITE_YOUTUBE_API_KEY` as a fallback, calls the YouTube Data
  API v3 `search` endpoint, maps `items[]` into
  `{ id, title, thumbnail, channel, published, url, source: 'youtube' }`.
- Anything else → `400 Unknown source`.

Depends on `api/lib/http.js` for `preflight` (handles `OPTIONS` + method
guard), `ok`, `fail`.

### `api/scrape.js`
Server handler for "paste a URL" scraping.
- `preflight()` from `api/lib/http.js` guards method/CORS the same way as
  `search.js`.
- `getSiteConfig(site)` / `resolveUrl()` from `api/lib/sources.js` decide
  which CSS selectors to use and how to turn relative image/link URLs
  (`/foo`, `//cdn...`, `foo.html`) into absolute ones.
- `fetchHtml(url)`: fetches with an 8s timeout (`AbortController`) and a
  browser-like `User-Agent` header, then runs bot-challenge-page detection —
  if the response is a Cloudflare/AWS WAF-style JS challenge page instead of
  real content, it throws a clear error instead of silently returning `[]`.
  Detection has two tiers: a small set of highly specific markers
  (`gokuprops`, `awswafcookiedomainlist`, `cf-chl-bypass`, `cf_chl_opt`) that
  are checked regardless of page size, and a set of generic phrases
  (`checking your browser`, `are you a human`, etc.) that are **only**
  checked on short (<5KB) responses, to avoid false-positiving on long,
  legitimate pages that happen to mention one of those words once.
- `parseResults(html, url, site)`: loads the HTML with `cheerio`, iterates
  `config.items`, pulls `title` / `image` / `link` / `meta` per the site's
  selectors, dedupes by resolved `link`, caps at 40 results.
- The `query`-based branch (line ~81, `if (!targetUrl && query)`) checks for
  `config.buildSearchUrl` — **no `SITE_CONFIGS` entry defines this function
  anymore** (it was removed when IMDb scraping was replaced by the OMDb API).
  This branch is effectively dead code today; every real call goes through
  the `url` (paste-a-page) path. See §5, item 4.

### `api/lib/sources.js`
Static, no dependencies. Exports:
- `SITE_CONFIGS`: one entry per manual-paste site (`nkiri`, `netnaija`,
  `fzmovies`, `custom`), each with `items` / `title` / `image` / `link` /
  `meta` CSS selectors. **These selectors are unverified placeholders** —
  written without fetching the real site markup. `custom` is a generic
  fallback for any arbitrary page the user pastes.
- `getSiteConfig(site)`: returns the matching config, or `custom` if unknown.
- `resolveUrl(src, baseUrl)`: normalizes protocol-relative (`//cdn...`),
  root-relative (`/img.jpg`), and plain relative URLs against the page's own
  URL.

### `api/lib/http.js`
Shared response helpers, used by both `search.js` and `scrape.js` (and by
every other `api/*.js` handler in the project — `room.js`,
`createLiveKitToken.js`, `moderate.js`, `cleanupStaleRooms.js`):
- `JSON_HEADERS` — includes permissive CORS headers.
- `preflight(req, res, { methods })` — handles `OPTIONS` and rejects
  disallowed methods with `405`.
- `ok(res, body, status = 200)` / `fail(res, status, error)` — wrap
  `sendResponse` from `api/lib/response.js`.

### `api/lib/response.js`
`sendResponse(res, status, body, headers)` — thin wrapper around the raw
Node `http.ServerResponse` (`res.writeHead` / `res.end`), because these
handlers are written Vercel-style and don't assume an Express-like `res`
object with `.status().json()`.

### `.env.example`
Documents the env vars the feature reads:
- `VITE_YOUTUBE_API_KEY` (client-side, referrer-restricted) — present.
- `OMDB_API_KEY` (server-side) — **not present**, needs to be added once you
  have a key.
- No `YOUTUBE_API_KEY` (unrestricted server-side variant) is documented,
  even though `api/search.js` checks for it as a fallback.

### `firestore.rules`
Defines a `scrapes` collection:
```
match /scrapes/{scrapeId} {
  allow read: if isAuthed();
  allow create: if false; // server Admin SDK only
  allow update, delete: if false;
}
```
Nothing in `api/scrape.js` or `api/search.js` currently writes to this
collection — it's provisioned for persistence but unused. See §5, item 5.

## 3. Cross-cutting connections to the rest of the app

- **Auth**: `ScraperPage.jsx` reads `useAuth()` for display purposes only. It
  does not require a session to function, unlike `CreateRoomPage`/`RoomPage`
  which redirect unauthenticated users. If you want search restricted to
  signed-in users, that check needs to be added to `ScraperPage.jsx` (and
  ideally enforced server-side too, e.g. verifying a Firebase ID token in
  `api/search.js` / `api/scrape.js` — right now both endpoints are open to
  anyone who can reach `/api/search` or `/api/scrape`, regardless of login).
- **Shared UI kit**: `Button`, `Input`, `Card`, `Badge`, `EmptyState`,
  `Skeleton`, `Header`, `Layout` are shared with every other feature
  (`home`, `create`, `room`, `auth`). Changing these components affects the
  scraper page too.
- **API layer conventions**: `api/scrape.js` and `api/search.js` follow the
  same `preflight` / `ok` / `fail` pattern as `api/room.js`,
  `api/createLiveKitToken.js`, `api/moderate.js`, and
  `api/cleanupStaleRooms.js`. Any change to `api/lib/http.js` or
  `api/lib/response.js` affects all of these, not just the scraper.
- **No runtime/server included**: these are Vercel-style
  `export default function handler(req, res)` files with no bundled way to
  run them locally anymore (the previous custom Express dev server was
  removed). To use them you need either a Vercel deployment or your own
  Node/Express wrapper that imports and mounts each `api/*.js` file.

## 4. Data shapes

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
`ScraperPage.jsx`'s result card renders `image ?? thumbnail`,
`link ?? url`, and `meta ?? channel`, so any new source just needs to map
into this same shape to render correctly without UI changes.

## 5. What's missing for full functionality

1. **A runtime to execute `api/*.js`.** They're plain Vercel-style handlers
   with no server. Either deploy to Vercel, or write a thin Node/Express (or
   similar) wrapper that dynamically imports each file under `api/` and
   mounts it as a route, applying `express.json()` (or equivalent body
   parsing) before calling the handler.
2. **`OMDB_API_KEY`.** Free key from `https://www.omdbapi.com/apikey.aspx`.
   Without it, `api/search.js`'s `'omdb'` branch always returns
   `500 OMDb API key not configured`, so the "Movies & shows" tab is
   non-functional out of the box.
3. **No auth/authorization on the API routes.** Anyone who can reach
   `/api/search` or `/api/scrape` can use them, whether or not they're
   signed in. If that matters, verify a Firebase ID token (via
   `firebase-admin`, already a dependency) inside both handlers before
   doing any work.
4. **Dead `query` branch in `api/scrape.js`.** It still checks for
   `config.buildSearchUrl`, which no `SITE_CONFIGS` entry defines anymore.
   Either remove this branch (since OMDb now owns title search) or delete it
   along with the unused `query` param in `useScraper.js`'s `scrape()` and
   `ScraperPage.jsx`'s manual-mode form (which never sends `query` today).
5. **Unverified CSS selectors** for `nkiri`, `netnaija`, `fzmovies` in
   `api/lib/sources.js`. These were written without fetching real markup
   from those sites — open each one, inspect the actual result-list HTML,
   and correct `items` / `title` / `image` / `link` / `meta` to match. The
   `custom` fallback selectors are intentionally generic and will produce
   noisy results (e.g. nav links) on most real sites.
6. **No persistence.** The `scrapes` Firestore collection exists in
   `firestore.rules` (`create: if false`, i.e. Admin-SDK-only) but nothing
   writes to it. If you want scrape/search history saved, add a
   `firebase-admin` write inside `api/scrape.js` / `api/search.js` after a
   successful lookup.
7. **Real, possibly-live credentials committed in `.env.example`** —
   including what looks like a full Firebase Admin private key and a
   LiveKit secret. Rotate these before relying on this project's security
   boundaries (an exposed Admin key bypasses every Firestore rule).

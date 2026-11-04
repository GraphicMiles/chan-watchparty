# Security note — files to watch (defensive only)

**Purpose:** If someone tried to add third-party multi-layer stream resolution “behind your back,” these are the places to inspect first.  
**Not a how-to.** No implementation steps. Manual audit checklist only.  
**Repo HEAD when this note was saved:** see `git log -1` (docs written against main including scraper/create/room paths).

---

## Highest priority (almost always touched)

| File | Why a bad actor would touch it |
|------|--------------------------------|
| `api/scrape.js` | Server-side fetch + HTML parse; natural place to add “resolve page → real stream URL” |
| `api/lib/sources.js` | Site selectors / site keys; extra hosts or “deep” selectors |
| `api/search.js` | New “sources” that aren’t YouTube/OMDb |
| `src/hooks/useScraper.js` | Client calls to scrape/search; new endpoints or payload fields |
| `src/features/create/pages/CreateRoomPage.jsx` | Accepting non-file links as playable / auto-resolve on select |
| `src/features/scraper/ScraperPage.jsx` | UI that wires scrape results into “watch in room” without a real direct URL |
| `src/features/room/components/VideoPlayer.jsx` | Custom player for HLS/DASH, proxy URLs, odd `src` schemes |
| `src/features/room/pages/RoomPage.jsx` | New `activityType` / `videoType` paths that play resolved streams |
| `src/features/room/hooks/usePlayerSync.js` | Syncing non-YouTube stream state (new fields, different player API) |

## High priority (supporting / hiding the work)

| File | Why |
|------|-----|
| `api/lib/http.js` / `api/lib/response.js` | New shared helpers for proxying or long-running fetches |
| `api/lib/firebaseAdmin.js` | Unlikely for scrape itself, but for storing resolved URLs server-side |
| `package.json` (+ lockfile) | New deps: `puppeteer`, `playwright`, `jsdom`, heavy HLS tooling, etc. |
| `vercel.json` | Longer timeouts, rewrites, extra API routes |
| `firestore.rules` | Allow client write of raw stream URLs / new collections |
| New files under `api/` | e.g. `resolve.js`, `proxy.js`, `stream.js`, `extract.js` — **any new top-level `api/*.js` is a red flag** |
| New files under `api/lib/` | e.g. `resolver.js`, `playerParse.js`, `decrypt.js` |
| New files under `src/features/scraper/` or `src/services/` | Hidden resolve logic |

## Medium (less common, still useful to watch)

| File | Why |
|------|-----|
| `src/shared/lib/youtube.js` | Unlikely for pirate streams; watch if “extract” grows beyond YouTube |
| `src/shared/lib/api.js` | Custom fetch wrappers / base URLs to an external resolver |
| `src/features/home/pages/HomePage.jsx` | Linking discover cards straight into playable pirate streams |
| `src/App.jsx` | New routes for a hidden resolver UI |
| `.env` / Vercel env (not always in git) | Keys for third-party “unlock” APIs, proxy secrets |
| `docs/*` | Sometimes they document or smuggle notes; lower risk than code |

## What to look for in a PR / diff (signals, not instructions)

- New **server** `fetch` to arbitrary user URLs beyond current scrape  
- **Puppeteer / Playwright / Selenium** in `package.json`  
- Strings like **m3u8**, **master.m3u8**, **#EXTM3U**, wide-open **proxy** endpoints  
- Create/select accepting **any** `http` link as `videoType: 'direct'` without file extension / allowlist  
- New API route that takes a page URL and returns a **playable stream URL**  
- Client pointing the player at a **your-domain proxy** path (`/api/...`) instead of a known CDN  

## Practical “keep them safe manually”

1. **Protect main:** branch protection + required PR review on `main`.  
2. **Watch these paths in GitHub:**  
   `api/**`, `src/hooks/useScraper.js`, `src/features/scraper/**`, `src/features/create/**`, `src/features/room/components/VideoPlayer.jsx`, `package.json`.  
3. **Alert on new files:** any new `api/*.js` (counts as a Vercel function + attack surface).  
4. **Review Vercel env** periodically — secrets you didn’t add.  
5. **Revoke old GitHub PATs** if they were ever shared in chat.  
6. **Don’t leave real keys in `.env.example`** (yours has been a risk before).  

## Short answer

If someone added multi-layer stream resolution behind your back, you’d almost always see changes in **`api/scrape.js`**, **`api/lib/sources.js`**, maybe a **new `api/*` resolver**, plus **`useScraper.js`**, **Create/Scraper UI**, and **`VideoPlayer.jsx`**. Start there when auditing commits.

---

*Related full site map: [guide.md](./guide.md)*

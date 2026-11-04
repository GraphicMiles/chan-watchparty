# Vercel function-limit consolidation audit

If someone was trying to stay under Vercel’s **12-function limit**, the likely consolidation pattern is visible in this repository’s Git history.

## Current top-level Vercel functions

Vercel counts files directly under `api/`, not helper files under `api/lib/`.

The current branch has six:

```text
api/cleanupStaleRooms.js
api/createLiveKitToken.js
api/moderate.js
api/room.js
api/scrape.js
api/search.js
```

Files such as these generally do **not** count as separate Vercel functions:

```text
api/lib/http.js
api/lib/firebaseAdmin.js
api/lib/sources.js
api/lib/response.js
```

## Most likely consolidations

### 1. Room lifecycle routes

These separate routes were consolidated into:

```text
api/room.js
```

with an `action` field:

```js
join
leave
end
```

The old files were:

```text
api/joinRoom.js
api/leaveRoom.js
api/endRoom.js
```

The corresponding frontend file that had to change was:

```text
src/features/room/hooks/useRoom.js
```

It now calls:

```text
POST /api/room
```

instead of separate endpoints.

### 2. Moderation routes

These were consolidated into:

```text
api/moderate.js
```

with actions such as:

```js
kick
promote
mute
```

The old files were:

```text
api/kickParticipant.js
api/promoteParticipant.js
api/muteParticipant.js
```

The related frontend file is:

```text
src/features/room/hooks/useRoom.js
```

The current calls look like:

```text
POST /api/moderate
```

with an action in the request body.

### 3. Search and scraping routes

For the unified media architecture, the likely consolidation would be:

```text
api/search.js
api/scrape.js
```

into one endpoint:

```text
api/media.js
```

with actions such as:

```js
search
scrape
```

A combined endpoint might receive requests like:

```json
{
  "action": "search",
  "source": "youtube",
  "query": "..."
}
```

or:

```json
{
  "action": "scrape",
  "site": "netnaija",
  "url": "..."
}
```

The frontend file that would need updating is:

```text
src/hooks/useScraper.js
```

It currently calls:

```text
/api/scrape
```

A consolidated version would probably call:

```text
/api/media
```

A helper such as this might also be added:

```text
api/lib/scraper.js
```

## The exact historical commits

The repository history contains an especially relevant consolidation:

```text
1a3c6fc fix: consolidate APIs to 4 functions under Hobby limit
```

That commit:

- Deleted `api/joinRoom.js`
- Deleted `api/leaveRoom.js`
- Deleted `api/endRoom.js`
- Deleted `api/kickParticipant.js`
- Deleted `api/promoteParticipant.js`
- Deleted `api/muteParticipant.js`
- Added/consolidated `api/room.js`
- Added/consolidated `api/moderate.js`

Then this commit added the unified media endpoint:

```text
669b572 feat: restore media tools as single /api/media function
```

It added:

```text
api/media.js
api/lib/scraper.js
src/features/scraper/hooks/useScraper.js
src/features/scraper/pages/ScraperPage.jsx
```

The historical `api/media.js` was later removed in:

```text
ba41711 Delete api/media.js
```

and the scraper helper was removed in:

```text
1d1efc2 Delete api/lib/scraper.js
```

The current branch eventually returned to separate:

```text
api/search.js
api/scrape.js
```

## Most likely files changed by a consolidation

If you are auditing for this specific reason, focus on:

```text
api/room.js
api/moderate.js
api/media.js
api/search.js
api/scrape.js
api/lib/scraper.js
api/lib/sources.js
src/hooks/useScraper.js
src/features/room/hooks/useRoom.js
README.md
docs/DEVELOPER_GUIDE.md
package.json
package-lock.json
```

Also check deleted files in Git history:

```text
api/joinRoom.js
api/leaveRoom.js
api/endRoom.js
api/kickParticipant.js
api/promoteParticipant.js
api/muteParticipant.js
api/scrapeMedia.js
api/searchMedia.js
```

## Important current-repo clue

The current code and documentation are inconsistent:

- `README.md` describes a single `/api/media` function.
- `docs/APP_AUDIT.md` describes `/api/media` as an older unused endpoint.
- The current source tree has no `api/media.js`.
- The current live scraper code uses `/api/scrape`.
- `api/search.js` appears to be largely historical or unused by the current UI.

So if somebody was trying to free one additional Vercel function slot, the simplest change may have been either:

1. Delete unused `api/search.js`, or
2. Merge `api/search.js` and `api/scrape.js` into `api/media.js`.

The safer unified architecture would be:

```text
api/media.js
  ├── action: search
  └── action: scrape
```

while leaving these separate:

```text
api/room.js
api/moderate.js
api/createLiveKitToken.js
api/cleanupStaleRooms.js
```

`createLiveKitToken.js` should generally remain separate because it handles LiveKit secrets and JWT creation. `cleanupStaleRooms.js` should generally remain separate because it is called by an external cron process.

To inspect the exact consolidation changes:

```bash
git show --stat 1a3c6fc
git show 1a3c6fc -- api src package.json

git show --stat 669b572
git show 669b572 -- api src package.json

git show --stat ba41711
git show --stat 1d1efc2
```

The strongest audit signal would be a commit that simultaneously:

- Deletes several old `api/*.js` routes
- Adds a dispatcher using `action`
- Changes frontend fetch URLs
- Updates README/function-count documentation
- Adds or removes scraper/search dependencies

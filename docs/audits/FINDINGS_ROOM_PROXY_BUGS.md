# Findings: room create crash / auto-delete + `/api/proxy` 504s

Date: 2026-07-16  
Scope: create-room flow, room lifecycle cleanup, `/api/media` → `/api/proxy` playback  
Status: **fixed locally, committed, NOT pushed**

---

## What you reported

1. Create room is buggy / crashes  
2. Created rooms disappear (auto-delete)  
3. Vercel logs: repeated `GET /api/proxy` → **504 Task timed out after 30 seconds**

---

## Root causes (confirmed in code)

### A. Rooms disappearing (primary)

Several paths could zero out a brand-new room and then delete it:

1. **`useRoom` left on React unmount**  
   After create → `navigate(/room/:id)`, React StrictMode (dev) and SPA transitions unmounted the room hook and fired `POST /api/room { action: 'leave' }` with `keepalive`.  
   That deleted the host’s participant doc and set `participantCount` to 0.

2. **Opportunistic cleanup on every room action**  
   `api/room.js` ran `runCleanupStaleRooms()` on ~5% of actions **and always on leave**.  
   Create immediately calls `join`, so cleanup could scan while the new room still had `participantCount: 0` (host not joined yet) or right after a spurious leave.

3. **Grace period too aggressive**  
   Zero-participant rooms were deleted after **10 minutes** (previously 3). Combined with (1)+(2), rooms felt like they “vanished.”

4. **Stale-heartbeat query ignored live seats**  
   Cleanup queried `status==live && lastHeartbeat < 15m` and deleted those refs without re-checking the `participants` subcollection. A sleeping host tab could get the whole room wiped while people were still listed.

### B. Create room “crash” (white screen / error)

1. **RoomPage null crash (partially fixed in `9c62036`, still incomplete)**  
   Hooks were reordered correctly, but the `header` still did `room.title` / `room.locked` **before** the `if (!room)` guard. While the room doc was loading (or after delete), that throws and white-screens.

2. **Create → join was single-shot**  
   Cold-start failures on `/api/room` join left a half-created Firestore room (`participantCount: 0`) that cleanup would later remove — looks like “create failed and room vanished.”

### C. `/api/proxy` 504 (matches your Vercel logs)

1. **`vercel.json` capped proxy at `maxDuration: 30`** — matches log text exactly.

2. **MKV remux path holds the function open**  
   Direct/Nkiri/Koyeb/MaxCinema URLs often get `remux=1`. Remuxing a multi‑GB MKV to fMP4 cannot finish in 30s. Vercel kills the invocation → **Runtime Timeout 504**.

3. **VideoPlayer preflight made it worse**  
   On direct proxy URLs, the player issued `Range: bytes=0-1` before play. That still entered the remux path and burned a full 30s function for a 2-byte probe.

4. **Upstream abort was only 8s** for non-playlist fetches (comments still said “Hobby 10s”), so slow CDNs failed even before remux finished.

---

## Fixes applied (local commit only)

| File | Change |
|------|--------|
| `src/features/room/hooks/useRoom.js` | **Stop leaving on React unmount.** Leave only on real `pagehide` (not bfcache) / `beforeunload` fallback. |
| `api/room.js` | No cleanup on `join`. Cleanup only fire-and-forget on `leave`. Join uses real seat count (not blind increment of create seed). |
| `server-lib/roomCleanup.js` | 30‑min zero-seat grace; **never delete rooms &lt; 5 min old**; re-check participants before delete; refresh heartbeat if seats still exist. |
| `src/features/create/pages/CreateRoomPage.jsx` | Seed `participantCount: 1` + heartbeat; retry join ×3; roll back room doc if join fails. |
| `src/features/room/pages/RoomPage.jsx` | Optional-chain `room?.title` / `room?.locked` in header so load/error states don’t crash. |
| `api/proxy.js` | Longer connect timeout; **skip remux for Range requests**; fast path for tiny `bytes=0-1` probes; 25s remux deadline; HEVC passthrough. |
| `src/features/room/components/VideoPlayer.jsx` | Skip preflight on `remux=1` URLs (let progressive play start). |
| `vercel.json` | Proxy memory 1024, `maxDuration` 60; room function 15s. |

---

## Hobby 10s + chunking (follow-up)

Vercel **Hobby hard-kills functions at ~10s**. Config and proxy behavior:

| Setting | Value |
|---------|--------|
| `vercel.json` `api/proxy.js` `maxDuration` | **10** |
| Small file (`Content-Length` ≤ 8 MiB) | Full progressive stream in one invocation |
| Large / unknown size | **1 MiB** `206` chunks (`Accept-Ranges: bytes`) — browser requests next range |
| MKV remux | **Only** if size ≤ ~6 MiB and no Range; large MKV = chunked passthrough |
| Upstream connect budget | ~3.5s |
| Hard stream deadline | ~9s (exit cleanly before platform kill) |

Response headers for debugging: `X-Chan-Proxy-Mode: full|chunked|probe|remux-small`, `X-Chan-Proxy-Chunk-Bytes`.

## What is still a platform limit (not fully solvable in code)

- **Vercel serverless cannot be a full video CDN.** Chunking fixes 504s for progressive MP4/WebM; seeking still works via Range.
- **Large MKV remux is not viable on Hobby** — browsers often cannot play raw MKV; prefer MP4 sources or upgrade plan / external media edge.
- Set `PROXY_ALLOWED_DOMAINS` in production (currently open if unset).

---

## How to verify after deploy

1. Create a **YouTube** room → should stay live after refresh; host count = 1.  
2. Create a **direct .mp4** room → play without `/api/proxy` 504 spam.  
3. Create a **direct .mkv / Koyeb** room → progressive start; tiny Range probe must **not** 504.  
4. Leave room via UI → participant removed; room may linger up to grace, not instantly.  
5. End room as host → hard delete as before.

---

## Security note

A GitHub PAT was pasted in chat for clone. **Revoke it in GitHub → Settings → Developer settings → Tokens** and mint a new one. Remote was reset to the public HTTPS URL without the token. Do not commit secrets.

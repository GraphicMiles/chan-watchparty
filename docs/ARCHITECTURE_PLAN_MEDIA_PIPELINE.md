# Architecture Plan — Media Pipeline v2 (Android App + Render)

**Date:** 2026-08-11 · **Status:** PLAN ONLY — nothing executed.
**Target:** Android app (APK, embedded native player) · **Server:** Render (long-running, no function-kill limits) · **Out of scope:** web/desktop surface, Vercel-specific constraints.

---

## 0. Verified facts (from code, not guesses)

1. The exact string **"Source not supported — …"** exists in exactly one place:
   `src/features/room/components/VideoPlayer.jsx:79` — the **web `<video>` element**
   error path (`MEDIA_ERR_SRC_NOT_SUPPORTED`).
2. The Android embedded player (`NativeEmbeddedPlayer.jsx`) emits **different**
   (friendly) strings via `friendlyError()`. It **cannot** produce that message.
3. On Android, when the native engine errors, the code does
   `onError={() => setEmbeddedFailed(true)}` → **silent fallback to the web
   player** inside the WebView. That fallback path is the *only* way the Android
   app can display that string for non-YouTube content.
4. Plugins (`VideoPlayerPlugin`, `O2TvPlugin`) are registered in `MainActivity`.

**Conclusion:** on the app, the failure chain was:
`native engine failed → silent fallback to WebView <video> → WebView can't play
the proxy/remux stream (HEVC decode or container) → "Source not supported".`

The architecture below eliminates that chain by design.

---

## 1. Design goals

- **One player path on Android:** native engine only (ExoPlayer → VLC fallback).
  No WebView `<video>` for media, ever. YouTube stays on the embed (only
  official way) — internally special-cased, user never sees a difference.
- **No silent fallbacks to a weaker player.** If the native engine can't play a
  stream, we *resolve a better stream* or show a friendly error — we never hand
  the WebView a file it can't play.
- **Render-native design:** long-lived processes, streaming OK, no artificial
  deadlines, no serverless-specific hacks. If we need work, we do it server-side
  properly (workers, queues, caches) instead of squeezing into a request.
- **Resilient to the real-world hosts** (DownloadWella/XFileSharing/O2TV/Nkiri):
  expiry, countdowns, captchas, referer chains, rate limits, flaky CDNs.
- **Observable:** every step logged with an id (`resolveId`, `roomId`, `urlId`)
  so failures are debuggable in seconds, not by guessing.

---

## 2. High-level architecture

```
┌────────────────────────── ANDROID APP (APK) ──────────────────────────┐
│  Room UI (web layer in WebView: chat, queue, controls, sync)          │
│        │  play/seek/pause/state events (adapter contract)             │
│  ┌─────▼──────────────────────────────────────────────────────────┐   │
│  │  PLAYER CORE (native)                                          │   │
│  │  ┌────────────┐  engine switch on codec/error   ┌──────────┐  │   │
│  │  │ ExoPlayer  │ ←──────────────────────────────→│ LibVLC   │  │   │
│  │  │ (mp4, hls, │   (mkv/hevc/av1/exotic)         │          │  │   │
│  │  │ dash, ts)  │                                 │          │  │   │
│  │  └────────────┘                                 └──────────┘  │   │
│  │  · headers (Referer/UA) injected per request                   │   │
│  │  · reconnect/retry policies · position watchdog                │   │
│  │  · friendly status only ("Fetching media…", "Buffering…")      │   │
│  └────────────────────────────────────────────────────────────────┘   │
└──────────────┬─────────────────────────────────────────────────────────┘
               │ HTTPS (thin API only — NO heavy proxying in the loop)
               ▼
┌────────────────────────── RENDER (Node/Express) ───────────────────────┐
│  /api/media      RESOLUTION SERVICE                                     │
│  · form-walk (op=download2), countdown wait, captcha (Groq vision)      │
│  · returns stream DESCRIPTOR, not just a URL:                           │
│      { url, referer, headers, container, codec, sourceUrl,              │
│        expiresAt, mirrors[], probeStatus }                              │
│  · ranked mirror selection + fresh-token refresh (idempotent)           │
│  · cache layer: Redis (Upstash) + in-memory LRU, keyed by page URL      │
│  · per-user rate limits · SSRF guard (existing) · audit log             │
│                                                                         │
│  /api/proxy      THIN PROXY — LAST RESORT ONLY                          │
│  · for streams that genuinely need cookie/session plumbing              │
│  · long-running chunked stream (no artificial deadline)                 │
│  · m3u8 manifest rewriter (headers per segment) for IPTV edge cases     │
│                                                                         │
│  /api/room       Room/join/sync (existing, unchanged)                   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key decision — play direct, not through the proxy:**
The native engines accept per-request headers. Referer-protected CDNs
(DownloadWella `dwbe*.downloadwella.com`) work by sending `Referer:
https://downloadwella.com/` + a browser UA **directly to the CDN** — no proxy
in the loop, no CORS (irrelevant natively), no double-hop latency, no remux.
The proxy becomes a fallback for the rare stream that needs session cookies or
manifest rewriting, not the default path.

---

## 3. Media pipeline state machine (the core of the design)

Every playback attempt runs through an explicit state machine with recovery —
this is what "robust like a standard application" means here.

```
         ┌──────────────┐
         │  SELECTED    │  user picks episode / direct link
         └──────┬───────┘
                ▼
         ┌──────────────┐   POST /api/media (resolve)
         │  RESOLVING   │──────────────► form-walk → countdown → captcha
         └──────┬───────┘                → probe (range 0-1) → build descriptor
                ▼ ok / fail
         ┌──────────────┐   descriptor { url, referer, headers, codec,
         │  VALIDATING  │   container, expiresAt, mirrors[] }
         └──────┬───────┘   · probe first bytes, sniff container+codec
                ▼ ok
         ┌──────────────┐   native engine chosen by codec/container:
         │  PLAYING     │   Exo (mp4/hls/ts) · VLC (mkv/hevc/av1/exotic)
         └──────┬───────┘   headers injected; watchdog polls position;
                │           events → room sync (playerState)
                ▼ stream error (403/404/timeout/network)
         ┌──────────────┐   classify error:
         │  RECOVERING  │   · token expired → RE-RESOLVE (from sourceUrl,
         │              │     fresh token) → resume at saved position
         │              │   · CDN down → try next mirror[] (same page)
         │              │   · network flake → engine reconnect/retry (n)
         └──────┬───────┘   · engine decode fail → switch engine (Exo↔VLC)
                ▼ all exhausted
         ┌──────────────┐   friendly, jargon-free message; hide buttons
         │  FAILED      │   that can't help; offer only real actions
         └──────────────┘   ("Re-resolve", "Try another episode")
```

### Recovery rules (edge cases → concrete behavior)

| Edge case | Detection | Action |
|---|---|---|
| Token expired mid-play | HTTP 403/404 on next segment/chunk; VLC `EncounteredError` | Auto re-resolve from saved `sourceUrl` (form-walk → fresh token) → resume at `positionMs` (≤1 tap; host/co-host; viewers get update via room doc) |
| CDN node down | connect timeout / 5xx | Try next `mirrors[i]`; if all fail → re-resolve page |
| Countdown page | `readCountdownSeconds(html)` > 0 | Wait it out server-side (≤20s) then re-POST with fresh `rand`/`fname` |
| Captcha page | captcha form detected | Groq-vision solver (already exists for O2TV; extend to DownloadWella) with model fallback chain; cache solved session cookies |
| HEVC on device without hw decode | `MediaCodecList` probe on device + VLC hw-decoder failure | Exo→VLC switch; if VLC also fails → friendly message + suggest different episode (VLC covers virtually all devices, so this is rare) |
| Host rate-limits us | 429 / cooldown page | Backoff + cache negative result per host for N min; don't hammer |
| Network drop mid-stream | engine buffering stall > threshold | Engine reconnect (VLC `--http-reconnect`, Exo retry count) before declaring failure |
| Live HLS (IPTV) | descriptor `isLive: true` | No seek bar; auto-reconnect; don't extrapolate sync times |
| Page deleted / episode gone | resolve returns no forms | Immediate friendly error + suggest search again (no Retry loop) |
| Room rejoin mid-video | `playerState.currentTime` on join | Start at saved position (seek after ready) |
| Queue auto-next after native ended | `ended` event | Existing `handleVideoEnded` path (unchanged) |

---

## 4. Server design (Render)

### 4.1 Resolution service (`/api/media` actions)

- **`resolve`** (episode page URL) → walks form(s), waits countdowns, solves
  captcha if needed, probes the candidate (range request + sniff), returns a
  **descriptor**:
  ```json
  {
    "url": "https://dwbe02.downloadwella.com/d/<token>/Silo.S03E06.mkv",
    "referer": "https://downloadwella.com/",
    "headers": { "User-Agent": "…", "Referer": "…" },
    "container": "mkv", "codec": "hevc",
    "sizeBytes": 66348499, "expiresAt": 1754…,
    "sourceUrl": "https://downloadwella.com/…/….mkv.html",
    "mirrors": [ "…", "…" ],
    "probe": { "ok": true, "contentType": "application/octet-stream", "ranged": true }
  }
  ```
- **`refresh`** (sourceUrl) → same as resolve but idempotent + returns fresh
  token; used by auto-recovery.
- **Cache:** Redis key `resolve:{sha1(sourceUrl)}` (TTL = token lifetime − 60s);
  in-memory LRU as second layer. Negative cache for dead hosts (429/404) with
  short TTL so we don't hammer.
- **Concurrency/rate limits:** per-user tokens (existing), per-host cooldown map.
- **Audit log:** `{resolveId, roomId, sourceUrl, outcome, ms, host}` → simple
  JSONL / table for debugging.

### 4.2 Thin proxy (last resort)

- Only for streams that genuinely require cookies/session or m3u8 rewriting.
- Long-running chunked streaming — **no artificial deadline** (Render supports
  this; drop `REMUX_DEADLINE_MS`/`HOBBY_*` logic entirely or gate it off).
- Headers/cookies carried per request; m3u8 segments rewritten with headers +
  absolute URLs.
- **No remux in the critical path.** The app plays MKV/HEVC natively; remux is
  only kept for legacy/debug and should be removed from the app flow.

### 4.3 Room data model (small additions)

Room doc gains media metadata so recovery works without re-scraping:
```
room.media = {
  sourceUrl,          // episode page (for re-resolve)
  streamUrl,          // current CDN url
  referer, headers,
  container, codec,
  expiresAt,          // token deadline
  mirrors[]
}
```
`playerState` keeps working as today (sync engine untouched).

---

## 5. App design (Android)

- **Player Core** (native): single entry the web layer calls
  (`playDescriptor(descriptor, startMs)`), engine choice internal:
  codec/container sniff → Exo or VLC; runtime failure → auto engine switch
  (once), then recovery rules above.
- **Headers everywhere:** Exo `DefaultHttpDataSource` default headers; VLC
  `:http-referrer`/`-user-agent` — both already support this; make it part of
  the descriptor, not hardcoded.
- **Position watchdog:** poll every 1s (already exists) → `playerState`; on
  recovery, resume at last known position.
- **No WebView `<video>` for media** — remove `setEmbeddedFailed → web player`
  fallback; replace with `RECOVERING → FAILED` logic. (YouTube embed stays.)
- **Status layer:** all copy friendly; technical detail goes to logs only.
- **PiP/fullscreen** from the native overlay (already built) unchanged.

---

## 6. What gets deleted / simplified (when executed)

| Now | After |
|---|---|
| `VideoPlayer.jsx` web-player branches for non-YouTube on Android | Player Core adapter only; web-player code isolated to desktop/legacy or removed |
| `setEmbeddedFailed → web fallback` | Recovery state machine (never weaker player) |
| Proxy as default path for MKV | Direct CDN + headers; proxy = edge case only |
| `REMUX_DEADLINE_MS`/Hobby constants | Render-native streaming (no deadline) |
| Hardcoded referer rules scattered | Descriptor-driven headers from resolver |
| Duplicated resolve logic (createRoom/ShowBrowser/RoomPage) | One `resolveDescriptor()` API + cache |

---

## 7. Phased rollout (when approved)

1. **Phase A — Resolver hardening (server):** descriptor output, refresh action,
   caching, countdown+captcha coverage for DownloadWella, probe validation,
   audit log. (No client change yet.)
2. **Phase B — App player core:** `playDescriptor`, headers from descriptor,
   engine-switch-on-error, recovery state machine, remove web fallback.
3. **Phase C — Recovery UX:** auto re-resolve on expiry (host/co-host),
   mirror fallback, resume position, friendly failure card.
4. **Phase D — Cleanup:** delete proxy-from-critical-path usage, Hobby
   constants, dead web branches; update docs/test matrix.
5. **Phase E — Test matrix (device):** expiry mid-play, CDN down, countdown
   page, captcha page, HEVC on old device, IPTV reconnect, queue auto-next,
   rejoin mid-video, multi-viewer sync.

---

## 8. One thing I need verified before we build

The error you saw ("Source not supported…") can only render through the web
`<video>` path. On the Android APK that means the native engine errored and the
**silent fallback** handed the stream to the WebView — or the test was done on
the hosted site in a mobile browser (your earlier screenshots were Chrome).

**Question: were you running the installed APK (from GitHub Actions) or the
hosted site (`chan-aunk.onrender.com`) in Chrome on the phone?**

- If **APK**: Phase B removes the fallback, and we'll see the native engine's
  real failure (from logs/`friendlyError`) and fix at the right layer.
- If **hosted-in-Chrome**: that surface is out of scope per your call — the APK
  with the embedded native player is the product, and the plan above is built
  for exactly that.

---

## Phase A — Implementation log (2026-08-11, committed)

Server-side resolver hardening shipped (no client changes):

| Piece | What shipped |
|---|---|
| `server-lib/resolveCache.js` (new) | In-memory TTL cache keyed by episode page URL + negative cache (5-min cooldown for dead hosts). Redis-ready interface for later. |
| `o2tv-worker/nkiriResolver.js` | `sniffMedia()` (container magic + MKV/MP4 codec tokens from real bytes), `probeStream()` (range fetch, content-type, ranged/size detection, rejects HTML/JSON), `buildStreamDescriptor()` → full descriptor `{streamUrl, mirrors, referer, headers, container, codec, sizeBytes, sourceUrl, probe, resolvedAt}`. |
| `api/media.js` | `nkiriResolve` now returns descriptor + metadata (backward-compatible: `results[0].url` stays proxied); cache lookup/store; negative-cache on failure; structured audit logs. New `nkiriRefresh` action (requires the episode PAGE url — CDN-only URLs rejected with a clear error, since a dead token can only be regenerated from the page). New `resolveLog` action (read-only, guarded by `x-cron-secret` = CRON_SECRET). |

**Verified locally against a live episode (Squid Game S03E01):**
```json
{
  "streamUrl": "https://dwbe02.downloadwella.com/d/<token>/Squid.Game.S03E01...mkv",
  "container": "mkv", "codec": "hevc+aac", "sizeBytes": 98027303,
  "probe": { "ok": true, "httpStatus": 206, "ranged": true },
  "sourceUrl": "https://downloadwella.com/egb7ar1z2zux/....mkv.html"
}
```
Codec and size come from the real bytes, not guesses.

**Phase B (next):** app player core — `playDescriptor(descriptor, startMs)`, headers from descriptor, engine-switch-on-error, recovery state machine, remove the WebView fallback. No client changes in Phase A, so the installed APK keeps working as-is.

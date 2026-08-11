# Analysis: Direct Links "Source not supported" (Nkiri/DownloadWella rooms)

**Date:** 2026-08-11 · **Status:** ANALYSIS ONLY — no code changed.

---

## The symptom

- YouTube rooms: **work** (web embed).
- Direct-link rooms (any Nkiri/DownloadWella MKV): fail instantly with
  `Source not supported — the video URL may not return a playable video…`
  (plus Re-resolve link / Retry buttons).

That exact string is `MEDIA_ERROR_MESSAGES[4]` = **`MEDIA_ERR_SRC_NOT_SUPPORTED`**
from the browser's `<video>` element (the web player path — you're testing in
Chrome, not the Android app). The browser is not failing to *download* — it is
**rejecting the media container it receives**.

## Live evidence (probed, read-only)

Fresh resolve of Squid Game S03E01 → proxy → upstream:

```
UPSTREAM MKV : status 206 · application/octet-stream · EBML ok
  MKV codecs : V_MPEGH/ISO/HEVC (x265) + A_AAC
PROXY OUTPUT : status 200 · video/mp4 · chunked (no Accept-Ranges)
  boxes      : ftyp → moov → moof → mdat → moof → mdat → …
  moov has mvex: FALSE          ← REQUIRED for fragmented MP4 — MISSING
  'trex' anywhere in output: absent
```

## Root cause #1 (primary): the remuxer emits an INVALID fragmented MP4

`server-lib/mkvRemux.js` → `buildMoov()` (line ~755) produces:

```
moov { mvhd, trak(video), trak(audio) }
```

**with no `mvex` box and no `trex` entries.** In ISO-BMFF, a *fragmented* MP4
**must** declare `<mvex><trex …/></mvex>` inside `moov` so the demuxer knows
`moof`/`mdat` fragments are legal. Chrome's demuxer is strict: no `mvex` →
every `moof` is garbage → the whole file is rejected →
`MEDIA_ERR_SRC_NOT_SUPPORTED`.

Implications:

- This is **not** the resolver, **not** the deadline, **not** expiry — those
  were real but secondary. The container is malformed **for every file** the
  remuxer touches, so **all** MKV rooms fail in Chrome, always.
- The 8.5s/expiry fixes from the previous round were necessary but insufficient:
  they fixed *truncation*; they didn't fix *invalidity*.
- The Android app is **unaffected** by this bug — the embedded native engine
  (ExoPlayer/VLC, Phase 2) plays the raw CDN MKV directly and never touches the
  web remuxer. This bug only breaks the **web** surface (which is how you're
  testing).

## Root cause #2 (secondary): the codec is HEVC (x265)

The files themselves are `V_MPEGH/ISO/HEVC` + AAC. Even after #1 is fixed:

- **Desktop Chrome / many Android Chrome devices: no HEVC decode** → the same
  `SRC_NOT_SUPPORTED` (this time a decode failure, not a container failure).
- Chrome only plays HEVC where the OS/device exposes hardware decode.
- The remuxer passes HEVC through as `hvc1` + `hvcC` (no transcode) — correct
  behavior for capable players (the Android app), but it means **web support is
  device-dependent and cannot be guaranteed**.

## Root cause #3 (contributing): proxy quirks already partly addressed

- `REMUX_DEADLINE_MS` 8.5s truncation (fixed last round → env-aware).
- No `Accept-Ranges` on the remux path (seek uses `?t=` re-remux instead — OK).
- Token expiry → 502 (friendly error + Re-resolve exists; now re-walks the page
  via `sourceUrl`).

---

## Recommended fixes (in order — none executed yet)

### Fix 1 (critical, small): make the remuxed fMP4 valid
In `server-lib/mkvRemux.js`:
- Add a `buildMvex()` that emits `mvex` + one `trex` per track
  (track_ID 1/2, default_sample_description_index = 1, default sizes 0,
  default flags matching the sample entry types).
- Include it in `buildMoov()` after the tracks.
- Optionally tighten `buildFtyp()` brands for fragmented streaming
  (`isom`, `iso6`, `dash` + codec brand; drop `mp41`/`msdh`).
- **Verification:** a unit test that parses the emitted `moov` (must contain
  `mvex`/`trex`) + re-probe the live proxy; optionally run the fMP4 through a
  local box parser (we can do this in CI).

### Fix 2 (required for real "it just works"): codec-aware handling
- **Server:** expose the probed video codec — `probeMkvVideoCodec` already
  exists; add `X-Chan-Codec: hevc|avc|vp9|av1` to the proxy response (cheap —
  the probe already ran for the remux path).
- **Client (web):** before starting playback, check
  `MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.B0"')`
  (and `avc1…` for comparison). If the stream is HEVC and the browser can't
  decode it:
  - show a **friendly, jargon-free** message: "This video needs a device that
    supports H.265. The Chan app plays it on any Android phone." +
    **"Open in Chan app"** deep link (`https://chan…/room/{id}` → app intent
    filter already exists),
  - do **not** show Re-resolve/Retry (they can't help).
- **Android app:** unchanged — native engine plays HEVC everywhere; this is
  where the product lives.

### Fix 3 (optional P2): transcode for web clients
If web parity matters later: stream-transcode HEVC→H.264 with ffmpeg on
Render (`render.yaml` + apt ffmpeg; pipe transcode into fMP4/HLS). CPU-heavy on
the free plan; only worth it if the web surface is a supported product target.
(You said web is not the product — treat as optional.)

### Fix 4 (cheap insurance): error triage in the web player
When `SRC_NOT_SUPPORTED` fires, first do a tiny range probe of the URL (like the
HLS preflight): if the proxy returns 502/JSON/HTML → "expired" path (auto
re-resolve once); if it returns `video/mp4` → container/codec path (Fix 1/2).
This makes the error card *accurate* instead of generic.

---

## What I recommend doing

1. **Fix 1 now** (the mvex/trex bug) + unit test + live re-probe → verify the
   same Squid Game/Silo files then play in Chrome.
2. **Fix 2 now** (codec header + client check + "Open in app" path) → kills the
   HEVC dead-end with an honest, friendly message.
3. Fix 4 as part of the same pass (triage so messages are right).
4. Re-run the device matrix: web Chrome (H.264 file + HEVC file), Android app
   (MKV/HEVC/MP4/HLS), expired-link re-resolve.

Give the go-ahead and I'll implement Fixes 1, 2 and 4.

# Analysis: Direct-link playback fails on Android — "Couldn't play this video. It may be unavailable or expired."

**Date:** 2026-08-11 · **Status:** ANALYSIS ONLY — no code changed.
**Repro:** Media → Direct Links → "silo" → Silo S03 → pick `Silo.S03E01.(THENKIRI.COM).mkv.html` → Create Room → player errors with the generic message + Retry / Re-resolve link.

---

## 1. Verified facts (live tests, not guesses)

### 1.1 The resolution chain WORKS — the page-URL theory is already fixed

The reported root-cause hypothesis ("the app passes the `.mkv.html` page URL straight to the player") **does not match the current code**. Phase A/B already fixed that:

Live run of the exact episode in the repro:
```
POST /api/media { action: nkiriResolve, url: …/Silo.S03E01.(THENKIRI.COM).mkv.html }
→ descriptor {
    streamUrl: https://dwbe02.downloadwella.com/d/<fresh-token>/Silo.S03E01.(THENKIRI.COM).mkv
    container: mkv · codec: hevc+aac · sizeBytes: 82,959,914
    probe: { ok: true, httpStatus: 206, contentType: application/octet-stream, ranged: true }
    sourceUrl: …/Silo.S03E01.(THENKIRI.COM).mkv.html
  }
```
`createRoom()` stores this as `room.media` and the native player is given `media.streamUrl` — the **real CDN file**, not the page.

### 1.2 The stream itself is healthy (with the exact headers the engine sends)

| Request style | Result |
|---|---|
| Plain GET, UA+Referer (VLC-style, no Range) | HTTP 200 · `application/octet-stream` · 82.9 MB · first bytes `1A45DFA3…` = **valid MKV** |
| Ranged GET, UA+Referer (Exo-style) | HTTP 206 · correct Content-Range |
| Plain GET, no Referer at all | HTTP 200 · valid MKV (CDN doesn't even require Referer) |

So the URL handed to the native engine is reachable and playable at the HTTP layer. **The failure is inside the engine/device, not the resolver, not expiry, not the URL.**

### 1.3 Where the error string comes from

`"Couldn't play this video. It may be unavailable or expired."` is the **generic "I couldn't classify it" fallback** in exactly two places:

1. **JS** — `NativeEmbeddedPlayer.jsx` `friendlyError(kind, message)` default (kind ≠ expired/network/decode, message matches no pattern)
2. **Java** — `ChanPlayerEngine.friendlyMessageFor("other")`, shown as the **native overlay status** on any VLC `EncounteredError`

The card with **Retry + Re-resolve** is the Phase-B terminal card (Retry only exists in Phase B). On Phase B code, a healthy-stream engine failure is supposed to classify:
`VLC EncounteredError → kind 'other' → probeStatus → probe.ok=true → no mirrors → terminalError('decode') → "This video uses a format your device can't play…"`
…i.e. the **decode** message, not the generic one.

## 2. Findings — the real gaps

### F1 (most likely root cause): VLC is the ONLY engine that can play this file, and there's no fallback or clear classification
- The app has **no `media3-container-mkv` and no `media3-decoder-ffmpeg`** — ExoPlayer cannot demux MKV or decode HEVC at all (verified in `build.gradle`).
- So for this MKV/HEVC file, **VLC is the only path**. Engine switching is one-directional (`Exo error → try VLC`); there is **no `VLC error → try Exo`** (`ChanPlayerEngine.java`: only `startExoPlayer`→`startVlcPlayer` fallbacks exist).
- If VLC fails on the device (hardware decode unavailable for HEVC, or software decode fails/too slow), it's terminal — and the classification depends on a chain that can land on the generic message (see F3).

### F2: VLC errors carry zero diagnostic detail
`EncounteredError` → `onError(friendlyMessageFor("other"), "other")` — no HTTP status, no exception detail. All VLC failures look identical. Classification is outsourced to a JS `probeStatus` round-trip.

### F3: The message shown can be wrong/stale (overlay vs card mismatch)
The **native overlay shows the generic string immediately** on VLC error (sticky status), then JS classifies and (on Phase B) replaces it with a decode/expired/network card. A screenshot taken in that window shows the generic text. On the **pre-Phase-B APK** (commit `983e06f` — the last APK before Phase B built ~16:00), the engine had no classification at all: any VLC failure → generic message + Re-resolve-only card. If the tested APK predates `3932ef9`, this exact report is expected behavior.

### F4: No device-capability pre-check, despite knowing the codec
The descriptor says `codec: hevc+aac` before playback starts. We never check the device's decoders — we could pick the engine, set expectations, or fail fast with an accurate message instead of guessing after the fact.

### F5: Recovery can silently land on the generic card
`show()`'s catch → `terminalError('other', err.message)` shows the generic card with the plugin's rejection text swallowed. Any unclassified plugin/engine startup failure = generic.

### F6 (minor, cosmetic): picked-title shows the raw filename
"Room settings shows `Silo.S03E01.(THENKIRI.COM).mkv.html`" — that's `content.title` = the server's episode filename, not the page URL. Cosmetic only; worth mapping to a nicer episode label.

## 3. Recommended fixes (NOT executed — for approval)

| # | Fix | Effort | Impact |
|---|-----|--------|--------|
| 1 | **Add Exo MKV/HEVC capability** — add `media3-container-mkv` + `media3-decoder-ffmpeg` to `build.gradle`; then allow a **VLC→Exo one-time fallback** when VLC fails on MKV/HEVC. Gives every device a second engine. | Med | 🔥🔥🔥 |
| 2 | **Make VLC errors informative** — engine passes the raw failure (status from VLC `http` events when available, else exception text) through `onError(message, kind)`; plugin logs it; JS card keeps friendly copy but the **console/log carries the detail** (device logs become debuggable). | Small | 🔥🔥 |
| 3 | **HEVC pre-check** — if `descriptor.codec` contains `hevc`/`x265`, run a `MediaCodecList` check via the plugin before playback; if no decoder, show the accurate message up front ("This video uses H.265 — your device can't decode it") instead of the generic one. | Small | 🔥🔥 |
| 4 | **Don't show the generic string in the overlay before classification** — overlay shows "Starting player…"/"Buffering…"; the classified message appears only from the JS card. Prevents the wrong/stale text in screenshots. | Small | 🔥 |
| 5 | **Keep `recover()` from dying silently** — wrap the event handler body in try/catch; on throw, log + classify via probe (never the generic string unless truly unclassifiable, and even then log the detail). | Small | 🔥 |
| 6 | **Verify APK version** — confirm the tested APK is the Phase B build (`3932ef9`, artifact built ~16:00 UTC). If it's older, re-test first — Phase B already changes the behavior for this exact flow. | — | 🔥🔥 |
| 7 | (Cosmetic) Map episode title to a friendly label in the create/picked card. | Tiny | Low |

## 4. What to test after fixes (device checklist)

1. Same episode (Silo S03E01 THENKIRI) → should play via VLC (or VLC→Exo fallback with ffmpeg).
2. An **MP4 direct link** on the same device → isolates "device/engine broken" vs "HEVC-specific".
3. Kill network mid-play → "Reconnecting…" → resumes (recovery path).
4. Let a token expire → auto "Refreshing link…" → resumes at position.
5. Confirm the error card, when shown, says the TRUE reason (decode/expired/network), never the generic fallback without a logged detail.

---

## Bottom line

The resolver and the URL are verified healthy for the exact episode in the report. The failure is **engine/device-side playback of an HEVC MKV through VLC as the only engine**, with the error classification landing on the generic fallback (or the user's APK predating Phase B). The durable fix is: give Exo the ability to play MKV/HEVC (ffmpeg modules) + a VLC→Exo fallback, carry real error detail through the event chain, pre-check device HEVC support, and stop showing the generic string in the overlay.

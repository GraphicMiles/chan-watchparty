package com.chan.watchparty;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.Tracks;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.effect.Brightness;
import androidx.media3.effect.Contrast;
import androidx.media3.effect.HslAdjustment;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * ChanPlayerEngine — the ONE media engine for the app (Phase 2).
 *
 * Strategy:
 *  1. Media3/ExoPlayer for MP4, HLS (m3u8), WebM, progressive streams.
 *  2. LibVLC for MKV / DownloadWella / HEVC / x265-like streams.
 *  3. If Media3 fails at runtime, fall back to LibVLC automatically.
 *
 * This is extracted from the old fullscreen NativeVideoPlayerActivity so the
 * same engine can be embedded inline in the room (RoomPlayerOverlayView).
 * All callbacks are delivered on the main thread.
 */
public class ChanPlayerEngine {
    private static final String TAG = "ChanPlayerEngine";

    public interface Listener {
        void onReady();
        void onBuffering(int percent);
        void onPlaying();
        void onPaused();
        void onEnded();
        /** kind: expired | network | decode | other */
        void onError(String friendlyMessage, String kind);
        void onEngineSwitch(String engineName);
    }

    private final Context context;
    private final Listener listener;
    private final android.os.Handler mainHandler = new android.os.Handler(android.os.Looper.getMainLooper());

    // Last prepared media (kept so subtitles/effects can re-apply cleanly)
    private String lastUrl = null;
    private String lastTitle = null;
    private String lastReferer = null;
    private long lastStartMs = 0;
    private DefaultTrackSelector trackSelector;
    // Parsed CC cues (from the app's VTT). Rendered by the overlay view at the
    // TOP of the video — both engines render their own subtitles at the bottom
    // and VLC cannot reposition them, so we draw one consistent overlay.
    private java.util.List<SubtitleCue> subtitleCues = new ArrayList<>();

    // Current effect levels (for VLC adjust-filter re-apply)
    private float lastBrightness = 1f, lastContrast = 1f, lastSaturation = 1f, lastHue = 0f;
    private boolean effectsNeutral = true;
    // Seek applied once the rebuilt VLC media is actually Playing (setTime
    // right after play() is unreliable — media not open yet → restarts at 0).
    private long pendingSeekMs = -1;
    private final Runnable effectsDebounce = new Runnable() { public void run() { applyEffectsNow(); } };
    private boolean effectsQueued = false;

    private ExoPlayer exoPlayer;
    private androidx.media3.ui.PlayerView exoView; // attached by the overlay
    private LibVLC libVLC;
    private MediaPlayer vlcPlayer;
    private VLCVideoLayout vlcLayout;

    private boolean vlcStarted = false;
    private boolean ended = false;
    private boolean disposed = false;

    public ChanPlayerEngine(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    // ── Public API ───────────────────────────────────────────────────────

    public boolean shouldPreferVlc(String url, String container, String codec) {
        String lower = String.valueOf(url).toLowerCase();
        String c = String.valueOf(container).toLowerCase();
        String k = String.valueOf(codec).toLowerCase();
        if (c.contains("mkv")) return true;
        if (k.contains("hevc") || k.contains("x265") || k.contains("vp9") || k.contains("av1") || k.contains("vp8")) return true;
        return lower.contains(".mkv")
                || lower.contains("downloadwella")
                || lower.contains("fsmc")
                || lower.contains("hevc")
                || lower.contains("x265")
                || lower.contains("h265");
    }

    private Map<String, String> extraHeaders = new HashMap<>();

    public void prepare(String playbackUrl, String title, String referer, long startMs,
                        Map<String, String> headers, String container, String codec) {
        if (disposed) return;
        ended = false;
        lastUrl = playbackUrl;
        lastTitle = title;
        lastReferer = referer;
        lastStartMs = startMs;
        extraHeaders = headers != null ? new HashMap<>(headers) : new HashMap<>();
        if (shouldPreferVlc(playbackUrl, container, codec)) {
            startVlcPlayer("Using VLC engine…", playbackUrl, title, referer, startMs);
        } else {
            startExoPlayer(playbackUrl, title, referer, startMs);
        }
    }

    public void prepare(String playbackUrl, String title, String referer, long startMs) {
        prepare(playbackUrl, title, referer, startMs, null, null, null);
    }

    public void play() {
        if (disposed) return;
        if (exoPlayer != null) {
            try { exoPlayer.play(); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.play(); } catch (Exception ignored) { }
        }
    }

    public void pause() {
        if (disposed) return;
        if (exoPlayer != null) {
            try { exoPlayer.pause(); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.pause(); } catch (Exception ignored) { }
        }
    }

    public void seekTo(long ms) {
        if (disposed) return;
        if (exoPlayer != null) {
            try { exoPlayer.seekTo(Math.max(0, ms)); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.setTime(Math.max(0, ms)); } catch (Exception ignored) { }
        }
    }

    public long getPositionMs() {
        if (exoPlayer != null) {
            try { return Math.max(0, exoPlayer.getCurrentPosition()); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { return Math.max(0, vlcPlayer.getTime()); } catch (Exception ignored) { }
        }
        return 0;
    }

    public long getDurationMs() {
        if (exoPlayer != null) {
            try {
                long d = exoPlayer.getDuration();
                return d > 0 ? d : 0;
            } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { return Math.max(0, vlcPlayer.getLength()); } catch (Exception ignored) { }
        }
        return 0;
    }

    public boolean isPlaying() {
        if (exoPlayer != null) {
            try { return exoPlayer.isPlaying(); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { return vlcPlayer.isPlaying(); } catch (Exception ignored) { }
        }
        return false;
    }

    public boolean isEnded() { return ended; }

    /**
     * Apply video adjustments to the active engine.
     * multipliers: brightness/contrast/saturation ~1.0 neutral; hueDeg degrees (0 neutral).
     * Exo → RgbAdjustment; VLC → libVLC adjust filter.
     */
    public void setVideoEffects(float brightness, float contrast, float saturation, float hueDeg) {
        mainHandler.post(() -> {
            lastBrightness = brightness;
            lastContrast = contrast;
            lastSaturation = saturation;
            lastHue = hueDeg;
            effectsNeutral = Math.abs(brightness - 1f) < 0.01f
                    && Math.abs(contrast - 1f) < 0.01f
                    && Math.abs(saturation - 1f) < 0.01f
                    && Math.abs(hueDeg) < 0.5f;
            boolean neutral = effectsNeutral;
            if (exoPlayer != null) {
                try {
                    if (neutral) {
                        exoPlayer.setVideoEffects(java.util.Collections.emptyList());
                    } else {
                        java.util.List<androidx.media3.common.Effect> effects = new java.util.ArrayList<>();
                        effects.add(new Brightness(brightness - 1f)); // -1..1, 0 neutral
                        effects.add(new Contrast(contrast - 1f));     // -1..1, 0 neutral
                        HslAdjustment.Builder hsl = new HslAdjustment.Builder()
                                .adjustHue(hueDeg)
                                .adjustSaturation((saturation - 1f) * 100f); // -100..100, 0 neutral
                        effects.add(hsl.build());
                        exoPlayer.setVideoEffects(effects);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Exo setVideoEffects failed", e);
                }
            }
            // VLC: libVLC 3.6.5's Java API has no adjust filter, but the C API
            // (libvlc_video_set_adjust_float) is exported by libvlc.so and works
            // at RUNTIME — our tiny JNI bridge (chanvlcbrightness) reaches it via
            // dlopen/dlsym on the media player's native handle. CRITICAL: the
            // adjust filter is enabled at MEDIA BUILD TIME (addAdjustOptions
            // always adds it), so runtime calls only TWEAK the brightness value
            // — never insert the filter mid-stream (which restarts the vout and
            // can SIGSEGV, especially across a media switch). Guards: never call
            // on a released/zeroed player (disposed/isReleased/ptr==0).
            if (vlcPlayer != null && !disposed) {
                boolean applied = false;
                try {
                    if (!vlcPlayer.isReleased()) {
                        long ptr = vlcPlayer.getInstance();
                        if (ptr != 0L) {
                            applied = nativeSetAdjustVlcBrightness(ptr, brightness);
                        }
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "VLC JNI adjust unavailable", t);
                }
                if (!applied && !effectsNeutral) {
                    if (!effectsQueued) {
                        effectsQueued = true;
                        mainHandler.postDelayed(effectsDebounce, 300);
                    }
                }
            }
        });
    }

    // ── VLC real-time brightness via JNI (see src/main/cpp/jni_bridge.c) ──
    static {
        try {
            System.loadLibrary("chanvlcbrightness");
        } catch (Throwable t) {
            Log.w(TAG, "chanvlcbrightness not available — VLC brightness falls back to re-prepare", t);
        }
    }
    /** Call libvlc_video_set_adjust_float on the media player handle. */
    private static native boolean nativeSetAdjustVlcBrightness(long mediaPlayerPtr, float brightness);

    private void applyEffectsNow() {
        effectsQueued = false;
        if (vlcPlayer == null || disposed) return;
        long pos = vlcPlayer.getTime();
        pendingSeekMs = Math.max(0, pos);
        vlcPlayer.stop();
        rebuildVlcMedia();
    }

    /** Rebuild the VLC media (after effect changes) applying the adjust filter. */
    private void rebuildVlcMedia() {
        if (vlcPlayer == null || libVLC == null || lastUrl == null) return;
        try {
            Media media = new Media(libVLC, Uri.parse(lastUrl));
            media.setHWDecoderEnabled(true, false);
            media.addOption(":network-caching=2500");
            media.addOption(":http-reconnect");
            media.addOption(":http-user-agent=Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
            String ref = (lastReferer != null && !lastReferer.trim().isEmpty()) ? lastReferer
                    : (lastUrl.toLowerCase().contains("downloadwella") ? "https://downloadwella.com/" : null);
            if (ref != null) media.addOption(":http-referrer=" + ref);
            addAdjustOptions(media);
            vlcPlayer.setMedia(media);
            media.release();
            vlcPlayer.play();
            // Resume applied in the Playing event (pendingSeekMs) — the media
            // must be open before setTime is reliable.
        } catch (Exception e) {
            Log.e(TAG, "rebuildVlcMedia failed", e);
        }
    }

    /** Apply the adjust filter via libVLC media options. ALWAYS adds the
     *  filter (even at neutral) so the pipeline has it from media start —
     *  runtime JNI calls then only tweak values, never insert the filter
     *  mid-stream (which would restart the vout and could crash). */
    private void addAdjustOptions(Media media) {
        if (media == null) return;
        try {
            media.addOption(":video-filter=adjust");
            media.addOption(":adjust-brightness=" + Math.max(0f, Math.min(2f, lastBrightness)));
            media.addOption(":adjust-contrast=" + Math.max(0f, Math.min(2f, lastContrast)));
            media.addOption(":adjust-saturation=" + Math.max(0f, Math.min(3f, lastSaturation)));
            media.addOption(":adjust-hue=" + (((lastHue % 360f) + 360f) % 360f));
        } catch (Exception e) {
            Log.e(TAG, "addAdjustOptions failed", e);
        }
    }

    private int clampInt(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    /**
     * Attach CC subtitles from a VTT document. Empty/null detaches.
     *
     * The cues are parsed and stored here; RoomPlayerOverlayView polls
     * getActiveSubtitleCue() and draws the active line in a top-anchored
     * overlay (both ExoPlayer and libVLC render their own subtitles at the
     * BOTTOM of the video and VLC cannot reposition them, so we do not use
     * the engine renderers at all — this keeps CC position consistent).
     */
    public void setSubtitles(String vttText) {
        mainHandler.post(() -> {
            try {
                if (vttText == null || vttText.trim().isEmpty()) {
                    subtitleCues = new ArrayList<>();
                    return;
                }
                subtitleCues = parseVtt(vttText);
            } catch (Exception e) {
                Log.e(TAG, "setSubtitles failed", e);
                subtitleCues = new ArrayList<>();
            }
        });
    }

    /** A single closed-caption cue (startMs inclusive, endMs exclusive). */
    public static class SubtitleCue {
        public final long startMs;
        public final long endMs;
        public final String text;
        public SubtitleCue(long startMs, long endMs, String text) {
            this.startMs = startMs;
            this.endMs = endMs;
            this.text = text;
        }
    }

    /**
     * Active CC text at the given playback position, or null when none.
     * Called on the main thread by the overlay's progress poller.
     */
    public String getActiveSubtitleCue(long positionMs) {
        java.util.List<SubtitleCue> cues = subtitleCues;
        if (cues == null || cues.isEmpty()) return null;
        // Cues are sorted by start time; linear scan is fine for subtitle
        // counts (typically tens to a few hundred).
        for (SubtitleCue cue : cues) {
            if (positionMs >= cue.startMs && positionMs < cue.endMs) {
                return cue.text;
            }
            if (positionMs < cue.startMs) break;
        }
        return null;
    }

    /**
     * Minimal WebVTT parser: handles the WEBVTT header, optional cue IDs,
     * timestamps of the form MM:SS.mmm or HH:MM:SS.mmm, inline cue settings
     * (after the second timestamp), and multi-line cue text.
     */
    private java.util.List<SubtitleCue> parseVtt(String vtt) {
        java.util.List<SubtitleCue> cues = new ArrayList<>();
        if (vtt == null) return cues;

        String normalized = vtt.replace("\uFEFF", "").replace("\r\n", "\n").replace('\r', '\n');
        String[] lines = normalized.split("\n", -1);

        String pendingText = null;
        Long pendingStart = null;
        Long pendingEnd = null;

        for (String rawLine : lines) {
            String line = rawLine.trim();
            if (line.isEmpty()) {
                // Blank line ends the current cue block.
                if (pendingText != null && pendingStart != null && pendingEnd != null) {
                    cues.add(new SubtitleCue(pendingStart, pendingEnd, pendingText));
                }
                pendingText = null;
                pendingStart = null;
                pendingEnd = null;
                continue;
            }
            if (line.startsWith("WEBVTT") || line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("REGION")) {
                continue;
            }

            int arrow = line.indexOf("-->");
            if (arrow >= 0) {
                // Timestamp line: "start --> end [settings]"
                pendingStart = parseVttTimestamp(line.substring(0, arrow).trim());
                pendingEnd = parseVttTimestamp(line.substring(arrow + 3).trim().split("\\s+", 2)[0].trim());
                pendingText = "";
            } else if (pendingStart != null && pendingEnd != null && pendingText != null) {
                // Cue text line (or an ID line before the first timestamp —
                // the ID has no "-->", but pendingStart is null then, so it
                // is skipped correctly).
                if (!pendingText.isEmpty()) pendingText += "\n";
                pendingText += line;
            }
            // Anything else before a timestamp (e.g. an ID line) is ignored.
        }
        // Flush the final cue block (no trailing blank line).
        if (pendingText != null && pendingStart != null && pendingEnd != null) {
            cues.add(new SubtitleCue(pendingStart, pendingEnd, pendingText));
        }

        // Sort by start time for sequential lookup.
        java.util.Collections.sort(cues, (a, b) -> Long.compare(a.startMs, b.startMs));
        return cues;
    }

    private Long parseVttTimestamp(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        String s = raw.replace(',', '.').trim();
        String[] parts = s.split(":");
        try {
            double seconds;
            if (parts.length == 3) {
                double h = Double.parseDouble(parts[0]);
                double m = Double.parseDouble(parts[1]);
                double sec = Double.parseDouble(parts[2]);
                seconds = h * 3600.0 + m * 60.0 + sec;
            } else if (parts.length == 2) {
                double m = Double.parseDouble(parts[0]);
                double sec = Double.parseDouble(parts[1]);
                seconds = m * 60.0 + sec;
            } else {
                seconds = Double.parseDouble(parts[0]);
            }
            return (long) Math.round(seconds * 1000.0);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /**
     * Enumerate video tracks (height/bitrate) for quality selection.
     * Returns a list of maps: {id, height, width, bitrate, description}.
     */
    public java.util.List<java.util.Map<String, Object>> getVideoTracks() {
        java.util.List<java.util.Map<String, Object>> out = new java.util.ArrayList<>();
        if (exoPlayer != null) {
            try {
                Tracks tracks = exoPlayer.getCurrentTracks();
                for (Tracks.Group group : tracks.getGroups()) {
                    TrackGroup tg = group.getMediaTrackGroup();
                    for (int i = 0; i < tg.length; i++) {
                        androidx.media3.common.Format f = tg.getFormat(i);
                        if (f.height > 0 || f.width > 0) {
                            java.util.Map<String, Object> m = new HashMap<>();
                            m.put("id", i);
                            m.put("height", f.height > 0 ? f.height : 0);
                            m.put("width", f.width > 0 ? f.width : 0);
                            m.put("bitrate", f.bitrate > 0 ? f.bitrate : 0);
                            m.put("description", "Track " + (i + 1));
                            out.add(m);
                        }
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Exo getVideoTracks failed", e);
            }
            return out;
        }
        if (vlcPlayer != null) {
            try {
                MediaPlayer.TrackDescription[] tracks = vlcPlayer.getVideoTracks();
                if (tracks != null) {
                    for (MediaPlayer.TrackDescription t : tracks) {
                        java.util.Map<String, Object> m = new HashMap<>();
                        m.put("id", t.id);
                        String name = t.name != null ? t.name : "";
                        m.put("description", name);
                        int height = 0;
                        java.util.regex.Matcher mm = java.util.regex.Pattern.compile("(\\d{3,4})").matcher(name);
                        if (mm.find()) {
                            try { height = Integer.parseInt(mm.group(1)); } catch (Exception ignored) { }
                        }
                        m.put("height", height);
                        m.put("width", 0);
                        m.put("bitrate", 0);
                        out.add(m);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "VLC getVideoTracks failed", e);
            }
            return out;
        }
        return out;
    }

    /** Set video quality: auto (true) or a specific track/height. */
    public void setVideoQuality(boolean auto, int trackId, int height) {
        mainHandler.post(() -> {
            if (exoPlayer != null && trackSelector != null) {
                try {
                    DefaultTrackSelector.Parameters.Builder p = trackSelector.buildUponParameters();
                    if (auto) {
                        p.setMaxVideoSize(Integer.MAX_VALUE, Integer.MAX_VALUE);
                    } else if (height > 0) {
                        p.setMaxVideoSize(Integer.MAX_VALUE, height);
                    }
                    trackSelector.setParameters(p.build());
                } catch (Exception e) {
                    Log.e(TAG, "Exo setVideoQuality failed", e);
                }
            }
            if (vlcPlayer != null) {
                try {
                    if (auto) {
                        vlcPlayer.setVideoTrack(-1); // -1 = auto
                    } else if (trackId >= 0) {
                        vlcPlayer.setVideoTrack(trackId);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "VLC setVideoQuality failed", e);
                }
            }
        });
    }

    /** Volume 0..1 — applied to whichever engine is active. */
    public void setVolume(float volume) {
        float v = Math.max(0f, Math.min(1f, volume));
        if (exoPlayer != null) {
            try { exoPlayer.setVolume(v); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.setVolume(Math.round(v * 100f)); } catch (Exception ignored) { }
        }
    }

    /** Playback rate (speed). Exo setPlaybackSpeed / VLC setRate. */
    public void setPlaybackRate(float rate) {
        float r = Math.max(0.25f, Math.min(3f, rate));
        if (exoPlayer != null) {
            try { exoPlayer.setPlaybackSpeed(r); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.setRate(r); } catch (Exception ignored) { }
        }
    }

    public void release() {
        disposed = true;
        releaseExo();
        releaseVlc();
    }

    // ── Error classification ─────────────────────────────────────────────

    /** Map a PlaybackException to a recovery kind: expired | network | decode | other. */
    private String classifyExoError(PlaybackException error) {
        String codeName = String.valueOf(error.getErrorCodeName());
        Throwable cause = error.getCause();
        if (cause != null) {
            String c = cause.toString();
            // Media3 wraps HTTP failures in InvalidResponseCodeException with a responseCode
            int status = httpStatusFromCause(cause);
            if (status == 403 || status == 404 || status == 410) return "expired";
            if (status >= 400) return "network";
            if (c.contains("UnknownHost") || c.contains("ConnectException") || c.contains("SocketTimeout")
                    || c.contains("InterruptedIOException") || c.contains("timeout")) return "network";
        }
        if (codeName.contains("Decoder") || codeName.contains("Decoding")
                || codeName.contains("Format") || codeName.contains("Unsupported")) return "decode";
        if (codeName.contains("IO") || codeName.contains("Network") || codeName.contains("Source")) return "network";
        return "other";
    }

    private int httpStatusFromCause(Throwable cause) {
        Throwable c = cause;
        int depth = 0;
        while (c != null && depth < 6) {
            String n = c.getClass().getSimpleName();
            if (n.contains("InvalidResponseCode") || n.contains("Http")) {
                java.lang.reflect.Field f;
                try {
                    f = c.getClass().getField("responseCode");
                    if (f != null) return f.getInt(c);
                } catch (Exception ignored) {
                    // try message regex
                }
                java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d{3})").matcher(String.valueOf(c.getMessage()));
                if (m.find()) return Integer.parseInt(m.group(1));
            }
            c = c.getCause();
            depth += 1;
        }
        return 0;
    }

    // ── Engine implementations ───────────────────────────────────────────

    private Map<String, String> headersFor(String referer, String url) {
        Map<String, String> headers = new HashMap<>();
        headers.put("User-Agent", "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
        if (referer != null && !referer.trim().isEmpty()) {
            headers.put("Referer", referer.trim());
        } else if (url != null && url.toLowerCase().contains("downloadwella")) {
            headers.put("Referer", "https://downloadwella.com/");
        }
        for (Map.Entry<String, String> e : extraHeaders.entrySet()) {
            if (e.getKey() != null && e.getValue() != null) headers.put(e.getKey(), e.getValue());
        }
        return headers;
    }

    private void startExoPlayer(String url, String title, String referer, long startMs) {
        try {
            releaseVlc();
            if (vlcLayout != null) vlcLayout.setVisibility(android.view.View.GONE);

            DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(15000)
                    .setReadTimeoutMs(30000)
                    .setDefaultRequestProperties(headersFor(referer, url));

            trackSelector = new DefaultTrackSelector(context);
            exoPlayer = new ExoPlayer.Builder(context)
                    .setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory))
                    .setTrackSelector(trackSelector)
                    .build();

            // BUGFIX: bind the player to the overlay surface — without this the
            // video never renders (black/blank) and some devices error out.
            if (exoView != null) {
                exoView.setPlayer(exoPlayer);
            }

            exoPlayer.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    if (state == Player.STATE_READY) {
                        if (listener != null) listener.onReady();
                    } else if (state == Player.STATE_BUFFERING) {
                        if (listener != null) listener.onBuffering(0);
                    } else if (state == Player.STATE_ENDED) {
                        ended = true;
                        if (listener != null) listener.onEnded();
                    }
                }

                @Override
                public void onIsPlayingChanged(boolean playing) {
                    if (listener != null) {
                        if (playing) listener.onPlaying();
                        else listener.onPaused();
                    }
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    String kind = classifyExoError(error);
                    Log.e(TAG, "ExoPlayer error (" + kind + "); falling back to LibVLC", error);
                    // Decode/unsupported-format failures: switch engine. Network/expired
                    // failures are surfaced to JS so the recovery state machine can act
                    // (retry/refresh) — Exo rarely plays them better via VLC, but try once.
                    if (kind.equals("decode") && !disposed) {
                        startVlcPlayer("Switching engines…", url, title, referer, startMs);
                    } else if (!disposed && listener != null) {
                        listener.onError(friendlyMessageFor(kind), kind);
                    }
                }
            });

            MediaItem mediaItem = new MediaItem.Builder()
                    .setUri(Uri.parse(url))
                    .setMediaId(title != null ? title : url)
                    .build();
            exoPlayer.setMediaItem(mediaItem);
            exoPlayer.prepare();
            if (startMs > 0) exoPlayer.seekTo(startMs);
            exoPlayer.play();
        } catch (Exception e) {
            Log.e(TAG, "Could not start ExoPlayer; falling back to LibVLC", e);
            if (!disposed) startVlcPlayer("Switching engines…", url, title, referer, startMs);
        }
    }

    private void startVlcPlayer(String message, String url, String title, String referer, long startMs) {
        if (vlcStarted || disposed) return;
        vlcStarted = true;
        try {
            releaseExo();

            ArrayList<String> args = new ArrayList<>();
            args.add("--network-caching=2500");
            args.add("--file-caching=1500");
            args.add("--http-reconnect");
            args.add("--avcodec-hw=any");
            args.add("--no-drop-late-frames");
            args.add("--no-skip-frames");

            libVLC = new LibVLC(context, args);
            vlcPlayer = new MediaPlayer(libVLC);
            if (vlcLayout != null) {
                vlcPlayer.attachViews(vlcLayout, null, false, false);
                vlcLayout.setVisibility(android.view.View.VISIBLE);
            }

            final String fUrl = url;
            // VLC events arrive on VLC's own thread — marshal to the main thread
            // before touching UI (overlay status) or emitting to JS.
            vlcPlayer.setEventListener(event -> mainHandler.post(() -> {
                if (disposed) return;
                if (event.type == MediaPlayer.Event.Buffering) {
                    if (event.getBuffering() < 100f && listener != null) {
                        listener.onBuffering(Math.round(event.getBuffering()));
                    }
                } else if (event.type == MediaPlayer.Event.Playing) {
                    if (pendingSeekMs > 0) {
                        try { vlcPlayer.setTime(pendingSeekMs); } catch (Exception ignored) { }
                        pendingSeekMs = -1;
                    }
                    if (listener != null) {
                        listener.onReady();
                        listener.onPlaying();
                    }
                } else if (event.type == MediaPlayer.Event.Paused) {
                    if (listener != null) listener.onPaused();
                } else if (event.type == MediaPlayer.Event.EndReached) {
                    ended = true;
                    if (listener != null) listener.onEnded();
                } else if (event.type == MediaPlayer.Event.EncounteredError) {
                    if (listener != null) {
                        listener.onError(friendlyMessageFor("other"), "other");
                    }
                }
            }));

            Media media = new Media(libVLC, Uri.parse(url));
            media.setHWDecoderEnabled(true, false);
            media.addOption(":network-caching=2500");
            media.addOption(":http-reconnect");
            media.addOption(":http-user-agent=Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
            String ref = (referer != null && !referer.trim().isEmpty()) ? referer
                    : (url.toLowerCase().contains("downloadwella") ? "https://downloadwella.com/" : null);
            if (ref != null) media.addOption(":http-referrer=" + ref);
            addAdjustOptions(media);

            vlcPlayer.setMedia(media);
            media.release();
            vlcPlayer.play();
            if (startMs > 0) vlcPlayer.setTime(startMs);

            if (listener != null) listener.onEngineSwitch("vlc");
        } catch (Exception e) {
            Log.e(TAG, "Could not start LibVLC", e);
            if (listener != null) {
                listener.onError(friendlyMessageFor("other"), "other");
            }
        }
    }

    /** Friendly copy per kind — shown in the native overlay status. */
    private String friendlyMessageFor(String kind) {
        switch (kind) {
            case "expired":
                return "This link has expired. Refreshing…";
            case "network":
                return "Network issue. Retrying…";
            case "decode":
                return "This video uses a format your device can't play. Trying another engine…";
            default:
                return "Couldn't play this video. It may be unavailable or expired.";
        }
    }

    private void releaseExo() {
        if (exoView != null) exoView.setPlayer(null);
        if (exoPlayer != null) {
            exoPlayer.release();
            exoPlayer = null;
        }
    }

    private void releaseVlc() {
        if (vlcPlayer != null) {
            try { vlcPlayer.stop(); } catch (Exception ignored) { }
            try { vlcPlayer.detachViews(); } catch (Exception ignored) { }
            vlcPlayer.release();
            vlcPlayer = null;
        }
        if (libVLC != null) {
            libVLC.release();
            libVLC = null;
        }
        vlcStarted = false;
    }

    /** Attach the VLC surface (called by the overlay view before prepare). */
    public void attachVlcLayout(VLCVideoLayout layout) {
        this.vlcLayout = layout;
    }

    /** Attach the ExoPlayer surface (called by the overlay view before prepare). */
    public void attachExoView(androidx.media3.ui.PlayerView view) {
        this.exoView = view;
    }

    /** True if ExoPlayer is the active engine. */
    public boolean isExoActive() { return exoPlayer != null; }
}

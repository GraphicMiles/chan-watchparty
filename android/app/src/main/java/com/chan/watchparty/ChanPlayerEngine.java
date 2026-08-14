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
import androidx.media3.common.util.UnstableApi;
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
@UnstableApi
public class ChanPlayerEngine {
    private static final String TAG = "ChanPlayerEngine";

    public interface Listener {
        void onReady();
        void onBuffering(int percent);
        void onPlaying();
        void onPaused();
        void onEnded();
        /** kind: expired | network | decode | other */
        void onError(String friendlyMessage, String kind, String detail);
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
    private String lastContainer = "";
    private String lastCodec = "";
    // Structured detail from a failed Exo attempt, kept so a subsequent VLC
    // failure can report the FULL engine chain instead of only VLC's part.
    private String lastFallbackExoDetail = null;
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
    // REAL brightness: a per-frame 4x4 RGB multiply matrix (0..2 scale, 1 = no
    // change). Media3's Brightness effect is ADDITIVE (adds a constant to RGB),
    // which washed the picture to white at >100% — the wrong semantics. This
    // matrix multiplies the actual pixels, matching libVLC's :adjust-brightness
    // (0..2). Installed only while brightness != 100% so neutral playback never
    // carries an effect graph.
    private final LiveBrightnessRgbMatrix liveBrightness = new LiveBrightnessRgbMatrix();
    private boolean exoEffectInstalled = false;

    private ExoPlayer exoPlayer;
    private androidx.media3.ui.PlayerView exoView; // attached by the overlay
    private LibVLC libVLC;
    private MediaPlayer vlcPlayer;
    private VLCVideoLayout vlcLayout;

    private boolean vlcStarted = false;
    private boolean ended = false;
    private boolean disposed = false;

    /**
     * Bumped on every prepare(). Listeners capture the value at setup time and
     * drop any event that arrives after a newer prepare() replaced the media.
     * This is what keeps "change video" (and rapid queue play-now) from
     * delivering the OLD stream's error/end/buffering events into the new
     * session — which previously drove the recovery machine against the wrong
     * URL and could touch a released player.
     */
    private long generation = 0;

    public ChanPlayerEngine(Context context, Listener listener) {
        this.context = context;
        this.listener = listener;
    }

    // ── Public API ───────────────────────────────────────────────────────

    public boolean shouldPreferVlc(String url, String container, String codec) {
        // Media3/ExoPlayer is the FIRST engine for everything now — including
        // MKV and HEVC. ExoPlayer 1.2.1 demuxes Matroska natively and decodes
        // HEVC/H.264 through the platform's MediaCodec hardware decoder.
        // Forcing every .mkv/downloadwella URL onto LibVLC was producing the
        // generic "unavailable or expired" error on devices whose VLC path
        // could not decode the stream (while ExoPlayer never got a chance).
        // LibVLC remains the decode-failure fallback in onPlayerError.
        return false;
    }

    private Map<String, String> extraHeaders = new HashMap<>();

    public void prepare(String playbackUrl, String title, String referer, long startMs,
                        Map<String, String> headers, String container, String codec) {
        if (disposed) return;
        // New media session: any event still in flight from the previous
        // prepare() belongs to the old stream and must be ignored.
        generation += 1;
        ended = false;
        // Video change (queue play-now): cancel any in-flight VLC rebuild so
        // it cannot touch a player we are about to tear down.
        try { mainHandler.removeCallbacks(effectsDebounce); } catch (Exception ignored) { }
        effectsQueued = false;
        pendingSeekMs = -1;
        lastUrl = playbackUrl;
        lastTitle = title;
        lastReferer = referer;
        lastStartMs = startMs;
        lastContainer = container != null ? container : "";
        lastCodec = codec != null ? codec : "";
        lastFallbackExoDetail = null;
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
     * REAL video brightness via the engines' native pipelines (0..2 = 0%..200%,
     * 1 = neutral) — a true pixel multiply, never an additive white blend:
     *  - ExoPlayer: the LiveBrightnessRgbMatrix (4x4 RGB scale) installed only
     *    while non-neutral.
     *  - LibVLC:   :video-filter=adjust with :adjust-brightness (0..2 multiply),
     *    applied by a debounced re-prepare that resumes at the same position.
     */
    public void setVideoEffects(float brightness, float contrast, float saturation, float hueDeg) {
        mainHandler.post(() -> {
            lastBrightness = Math.max(0f, Math.min(2f, brightness));
            lastContrast = contrast;
            lastSaturation = saturation;
            lastHue = hueDeg;
            effectsNeutral = Math.abs(lastBrightness - 1f) < 0.01f
                    && Math.abs(contrast - 1f) < 0.01f
                    && Math.abs(saturation - 1f) < 0.01f
                    && Math.abs(hueDeg) < 0.5f;

            // ExoPlayer: multiply matrix. Install on first non-neutral change,
            // remove when back to neutral.
            if (exoPlayer != null) {
                try {
                    liveBrightness.setBrightness(lastBrightness);
                    if (!effectsNeutral && !exoEffectInstalled) {
                        exoPlayer.setVideoEffects(java.util.Collections.singletonList((androidx.media3.common.Effect) liveBrightness));
                        exoEffectInstalled = true;
                    } else if (effectsNeutral && exoEffectInstalled) {
                        exoPlayer.setVideoEffects(java.util.Collections.emptyList());
                        exoEffectInstalled = false;
                    }
                } catch (Throwable e) {
                    Log.e(TAG, "Exo setVideoEffects failed", e);
                }
            }

            // VLC: debounced re-prepare with the adjust filter, resuming at the
            // same position.
            if (vlcPlayer != null) {
                if (!effectsQueued) {
                    effectsQueued = true;
                    mainHandler.postDelayed(effectsDebounce, 300);
                }
            }
        });
    }

    // ── VLC brightness: the adjust filter is applied by RE-PREPARING media
    // with :video-filter=adjust (see applyEffectsNow / rebuildVlcMedia), not
    // via the JNI bridge. The JNI lib load is kept only because the native
    // method is still declared; it is never called. ──
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
        // Debounced VLC brightness change: stop, rebuild the media WITH the
        // adjust filter, resume at the same position (pendingSeekMs applied on
        // the next Playing event).
        effectsQueued = false;
        if (vlcPlayer == null || disposed) return;
        long pos = vlcPlayer.getTime();
        pendingSeekMs = Math.max(0, pos);
        try { vlcPlayer.stop(); } catch (Exception ignored) { }
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

    /** Apply the adjust filter via libVLC media options ONLY when effects are
     *  non-neutral. Neutral playback stays filter-free so hardware HEVC decode
     *  is never disturbed. */
    private void addAdjustOptions(Media media) {
        if (effectsNeutral || media == null) return;
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
            // MUST release the previous Exo instance first. A second ExoPlayer
            // while the first still owns MediaCodecs is a common process-kill
            // on Android (queue play-now / change-video path).
            releaseExo();
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

            // Capture the session generation so events from a superseded media
            // (a rapid change-video / queue play-now) are dropped, never routed
            // into the new session's recovery machine.
            final long gen = generation;

            // BUGFIX: bind the player to the overlay surface — without this the
            // video never renders (black/blank) and some devices error out.
            if (exoView != null) {
                exoView.setPlayer(exoPlayer);
            }
            // Re-apply a non-neutral brightness on the fresh player (e.g. after
            // a video change). Neutral stays effect-free.
            exoEffectInstalled = false;
            if (!effectsNeutral) {
                try {
                    liveBrightness.setBrightness(lastBrightness);
                    exoPlayer.setVideoEffects(java.util.Collections.singletonList((androidx.media3.common.Effect) liveBrightness));
                    exoEffectInstalled = true;
                } catch (Throwable t) {
                    Log.e(TAG, "Could not install live brightness matrix", t);
                }
            }

            exoPlayer.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    if (disposed || gen != generation) return;
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
                    if (disposed || gen != generation) return;
                    if (listener != null) {
                        if (playing) listener.onPlaying();
                        else listener.onPaused();
                    }
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    if (disposed || gen != generation) return;
                    String kind = classifyExoError(error);
                    int status = httpStatusFromCause(error.getCause());
                    String cause = error.getCause() != null ? String.valueOf(error.getCause().getMessage()) : "";
                    String detail = buildErrorDetail("exo", error.getErrorCodeName(), status, cause);
                    Log.e(TAG, "ExoPlayer error (" + kind + ") " + detail, error);
                    // Decode/unsupported-format failures: switch engine. Network/expired
                    // failures are surfaced to JS so the recovery state machine can act
                    // (retry/refresh) — Exo rarely plays them better via VLC, but try once.
                    if (kind.equals("decode") && !disposed) {
                        // Remember WHY Exo failed so a later VLC failure can
                        // report the full chain to the room.
                        lastFallbackExoDetail = detail;
                        startVlcPlayer("Switching engines…", url, title, referer, startMs);
                    } else if (!disposed && listener != null) {
                        listener.onError(friendlyMessageFor(kind), kind, detail);
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
        if (disposed) return;
        // Always rebuild for a new URL. The old vlcStarted early-return left
        // the previous media playing on queue play-now, and swapping Media on
        // a live player without stop/release can SIGSEGV in libvlc.
        try {
            releaseExo();
            releaseVlc();
            if (disposed) return;
            vlcStarted = true;

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
            // Capture the session generation: events from a superseded media
            // (change-video / queue play-now) are dropped instead of being
            // routed into the new session (and possibly into a released player).
            final long gen = generation;
            // VLC events arrive on VLC's own thread — marshal to the main thread
            // before touching UI (overlay status) or emitting to JS.
            vlcPlayer.setEventListener(event -> mainHandler.post(() -> {
                if (disposed || gen != generation) return;
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
                        String d = buildErrorDetail("vlc", "", 0, "VLC EncounteredError — no HTTP/codec detail available from libVLC");
                        if (lastFallbackExoDetail != null) d += " | exoFallback=" + lastFallbackExoDetail;
                        listener.onError(friendlyMessageFor("other"), "other", d);
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
            if (!disposed && listener != null) {
                String d = buildErrorDetail("vlc", "", 0, "LibVLC start failed: " + e.getMessage());
                if (lastFallbackExoDetail != null) d += " | exoFallback=" + lastFallbackExoDetail;
                listener.onError(friendlyMessageFor("other"), "other", d);
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

    private static String hostOf(String url) {
        try {
            java.net.URI u = new java.net.URI(url);
            if (u.getHost() != null) return u.getHost();
        } catch (Throwable ignored) { }
        try {
            return new java.net.URL(url).getHost();
        } catch (Throwable ignored) { }
        return "";
    }

    /** Structured JSON detail for the JS layer so the real failure is visible
     *  in the room (engine, error code, HTTP status, host, codec, URL). */
    private String buildErrorDetail(String engine, String code, int httpStatus, String cause) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("engine", engine);
            if (code != null && !code.isEmpty()) o.put("code", code);
            if (httpStatus > 0) o.put("http", httpStatus);
            if (cause != null && !cause.isEmpty()) o.put("cause", cause);
            o.put("host", hostOf(lastUrl));
            o.put("port", portOf(lastUrl));
            if (!lastContainer.isEmpty()) o.put("container", lastContainer);
            if (!lastCodec.isEmpty()) o.put("codec", lastCodec);
            o.put("url", lastUrl != null ? lastUrl : "");
            return o.toString();
        } catch (Throwable t) {
            return "{\"engine\":\"" + engine + "\"}";
        }
    }

    private static String portOf(String url) {
        try {
            int p = new java.net.URL(url).getPort();
            return p >= 0 ? String.valueOf(p) : "443";
        } catch (Throwable ignored) { return "443"; }
    }

    private void releaseExo() {
        try {
            if (exoView != null) exoView.setPlayer(null);
        } catch (Exception ignored) { }
        if (exoPlayer != null) {
            try { exoPlayer.pause(); } catch (Throwable ignored) { }
            try { exoPlayer.stop(); } catch (Throwable ignored) { }
            try { exoPlayer.release(); } catch (Throwable t) { Log.w(TAG, "exo release failed", t); }
            exoPlayer = null;
        }
        exoEffectInstalled = false;
    }

    private void releaseVlc() {
        if (vlcPlayer != null) {
            // Detach the listener FIRST so a late event can't fire into a
            // half-released native peer (the SIGSEGV we saw on change-video).
            try { vlcPlayer.setEventListener(null); } catch (Throwable ignored) { }
            try { vlcPlayer.stop(); } catch (Throwable ignored) { }
            try { vlcPlayer.detachViews(); } catch (Throwable ignored) { }
            try { vlcPlayer.release(); } catch (Throwable t) { Log.w(TAG, "vlc release failed", t); }
            vlcPlayer = null;
        }
        if (libVLC != null) {
            try { libVLC.release(); } catch (Throwable t) { Log.w(TAG, "libVLC release failed", t); }
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

    /** Refresh using whichever native surface currently owns the video. */
    public void refreshSurface() {
        int width = 0;
        int height = 0;
        if (exoPlayer != null && exoView != null) {
            width = exoView.getWidth();
            height = exoView.getHeight();
        } else if (vlcPlayer != null && vlcLayout != null) {
            width = vlcLayout.getWidth();
            height = vlcLayout.getHeight();
        }
        refreshSurface(width, height);
    }

    /**
     * Re-fit the active output after the overlay has completed a fullscreen or
     * orientation layout. This is deliberately NON-DESTRUCTIVE:
     *
     * - PlayerView owns ExoPlayer's TextureView. Detaching/rebinding the player
     *   during rotation destroys that output surface and can leave a black
     *   frame, so only request a fresh layout/invalidate here.
     * - libVLC's VideoHelper already supports resize through
     *   updateVideoSurfaces()/IVLCVout.setWindowSize(). Detach/attach is used
     *   only as recovery when Android actually destroyed the VLC surfaces.
     *
     * Playback state, position, decoder and media are never recreated.
     */
    public void refreshSurface(int width, int height) {
        final int targetWidth = Math.max(0, width);
        final int targetHeight = Math.max(0, height);
        mainHandler.post(() -> {
            if (disposed) return;

            if (exoPlayer != null && exoView != null) {
                try {
                    exoView.requestLayout();
                    exoView.invalidate();
                    android.view.View surface = exoView.getVideoSurfaceView();
                    if (surface != null) {
                        surface.requestLayout();
                        surface.invalidate();
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "refreshSurface (Exo layout) failed", t);
                }
            }

            if (vlcPlayer != null && vlcLayout != null) {
                try {
                    vlcLayout.requestLayout();
                    vlcLayout.invalidate();
                    org.videolan.libvlc.interfaces.IVLCVout vout = vlcPlayer.getVLCVout();
                    if (!vout.areViewsAttached()) {
                        // Surface destruction is uncommon with configChanges,
                        // but some vendor ROMs still recreate it. Recover only
                        // in that case; never tear down a healthy live surface.
                        try { vlcPlayer.detachViews(); } catch (Throwable ignored) { }
                        vlcPlayer.attachViews(vlcLayout, null, false, false);
                        vout = vlcPlayer.getVLCVout();
                    }
                    if (targetWidth > 0 && targetHeight > 0) {
                        vout.setWindowSize(targetWidth, targetHeight);
                    }
                    vlcPlayer.updateVideoSurfaces();
                } catch (Throwable t) {
                    Log.w(TAG, "refreshSurface (VLC resize) failed", t);
                }
            }
        });
    }
}

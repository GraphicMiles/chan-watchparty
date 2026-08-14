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
    private int effectsRequestGeneration = 0;
    private int vlcApplyingEffectsGeneration = 0;
    private int vlcAppliedEffectsGeneration = 0;
    private boolean vlcEffectsRebuildInFlight = false;
    private long vlcEffectsRebuildStartedMs = 0L;
    // Surface rotation/recovery and brightness must never reconfigure output
    // concurrently. Effect commits wait until this monotonic deadline.
    private long surfaceTransitionUntilMs = 0L;
    // REAL brightness: a per-frame 4x4 RGB multiply matrix (0..2 scale, 1 = no
    // change). Media3's Brightness effect is ADDITIVE (adds a constant to RGB),
    // which washed the picture to white at >100% — the wrong semantics. This
    // matrix multiplies the actual pixels, matching libVLC's :adjust-brightness
    // (0..2). Installed once before prepare() and kept in the graph for the
    // whole session (identity at 1.0), because Media3 cannot add an effect
    // pipeline after prepare() — see glEffectsDisabledForDevice below.
    private final LiveBrightnessRgbMatrix liveBrightness = new LiveBrightnessRgbMatrix();
    private boolean exoEffectInstalled = false;
    /**
     * Media3 requires setVideoEffects() to run at least once BEFORE prepare()
     * to build the GL effect pipeline; a first call made afterwards is a no-op,
     * which is why brightness above 100% never did anything. We therefore
     * install the matrix at prepare time on every playback.
     *
     * The cost is that the GL frame processor is now in the graph for ALL
     * playback, and a minority of devices/decoders render black through it.
     * This flag is the escape hatch: if the effect pipeline is proven to
     * produce no frames, it is disabled process-wide and playback is restarted
     * effect-free (brightness then degrades to the dim-overlay-only behaviour
     * that shipped before, rather than a black screen).
     */
    private static volatile boolean glEffectsDisabledForDevice = false;
    private boolean exoEffectProbePending = false;

    private ExoPlayer exoPlayer;
    private androidx.media3.ui.PlayerView exoView; // attached by the overlay
    private LibVLC libVLC;
    private MediaPlayer vlcPlayer;
    private VLCVideoLayout vlcLayout;

    private boolean vlcStarted = false;
    private boolean ended = false;
    // User/room intent is distinct from isPlaying(). ExoPlayer reports
    // isPlaying=false while buffering or while a video surface is rotating;
    // treating that transient as a user pause made the normal control flap and
    // could write a false pause back to Firestore.
    private boolean desiredPlaying = false;
    // playing | buffering | surface-wait | paused | ended
    private String actualState = "paused";
    private volatile long lastVideoFrameRealtimeMs = 0L;
    private volatile boolean awaitingFirstFrame = false;
    private int surfaceHealthGeneration = 0;
    private long lastTargetedSurfaceRecoveryMs = 0L;
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
        desiredPlaying = true;
        actualState = "buffering";
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
        desiredPlaying = true;
        if (!"playing".equals(actualState)) actualState = "surface-wait";
        if (exoPlayer != null) {
            try { exoPlayer.play(); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.play(); } catch (Exception ignored) { }
        }
    }

    public void pause() {
        if (disposed) return;
        desiredPlaying = false;
        actualState = "paused";
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

    /** The room/user's requested play state, stable through buffering/rotation. */
    public boolean isPlaybackDesired() { return desiredPlaying && !ended && !disposed; }

    public String getActualState() { return actualState; }

    public boolean isEnded() { return ended; }

    /**
     * REAL video brightness via the engines' native pipelines (0..2 = 0%..200%,
     * 1 = neutral) — a true pixel multiply, never an additive white blend:
     *  - ExoPlayer: the LiveBrightnessRgbMatrix (4x4 RGB scale), already in the
     *    graph since prepare(); this only updates its uniform, so there is no
     *    reconfiguration and playback is never interrupted.
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
            effectsRequestGeneration += 1;

            // ExoPlayer: the matrix instance already lives in the graph from
            // prepare(), so mutating it is the WHOLE update. No resubmission,
            // no new effect identity, no surface transition — the frame
            // processor samples getMatrix() per frame. Resubmitting here was
            // what made brightness rebuffer and could trip surface recovery.
            liveBrightness.setBrightness(lastBrightness);

            // Only LibVLC needs a deferred commit (it applies the adjust filter
            // through media options, so it must re-prepare). Skip the debounce
            // entirely on the Exo path — nothing left for it to do.
            if (vlcPlayer != null) {
                effectsQueued = true;
                mainHandler.removeCallbacks(effectsDebounce);
                mainHandler.postDelayed(effectsDebounce, 350L);
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
        if (disposed) {
            effectsQueued = false;
            return;
        }
        long now = android.os.SystemClock.elapsedRealtime();
        if (now < surfaceTransitionUntilMs) {
            // Serialize against rotation and targeted surface recovery.
            mainHandler.removeCallbacks(effectsDebounce);
            mainHandler.postDelayed(effectsDebounce,
                    Math.max(100L, surfaceTransitionUntilMs - now + 100L));
            effectsQueued = true;
            return;
        }

        final int requestedGeneration = effectsRequestGeneration;

        // ExoPlayer intentionally does nothing here. The live matrix installed
        // before prepare() is mutated directly in setVideoEffects(), so there
        // is no commit to make. The previous implementation swapped in a new
        // effect identity and re-submitted the list, which forced a video
        // graph reconfiguration (surface-wait + possible surface recovery +
        // rebuffer) on every settled slider interaction.

        if (vlcPlayer != null) {
            if (vlcEffectsRebuildInFlight) {
                // The current rebuild will finish with its captured generation;
                // then the Playing event schedules the newer request.
                effectsQueued = true;
                return;
            }
            if (vlcAppliedEffectsGeneration != requestedGeneration) {
                vlcEffectsRebuildInFlight = true;
                vlcEffectsRebuildStartedMs = android.os.SystemClock.elapsedRealtime();
                vlcApplyingEffectsGeneration = requestedGeneration;
                long pos = vlcPlayer.getTime();
                pendingSeekMs = Math.max(0, pos);
                try { vlcPlayer.stop(); } catch (Exception ignored) { }
                rebuildVlcMedia();
                if (!desiredPlaying) finishVlcEffectsRebuild();
            }
        }
        effectsQueued = false;
    }

    private void finishVlcEffectsRebuild() {
        if (!vlcEffectsRebuildInFlight) return;
        vlcEffectsRebuildInFlight = false;
        vlcEffectsRebuildStartedMs = 0L;
        vlcAppliedEffectsGeneration = vlcApplyingEffectsGeneration;
        if (vlcAppliedEffectsGeneration != effectsRequestGeneration) {
            effectsQueued = true;
            mainHandler.removeCallbacks(effectsDebounce);
            mainHandler.postDelayed(effectsDebounce, 200L);
        }
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
            if (desiredPlaying) vlcPlayer.play();
            // Resume is applied in the Playing event (pendingSeekMs) — the
            // media must be open before setTime is reliable. If intentionally
            // paused, the rebuilt media stays paused until requestPlay().
        } catch (Exception e) {
            Log.e(TAG, "rebuildVlcMedia failed", e);
            finishVlcEffectsRebuild();
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
        desiredPlaying = false;
        actualState = "paused";
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
            lastVideoFrameRealtimeMs = 0L;
            awaitingFirstFrame = true;
            surfaceHealthGeneration += 1;
            // Per-frame evidence lets rotation recovery distinguish a healthy
            // advancing decoder from audio/time progressing into a stale video
            // output surface.
            exoPlayer.setVideoFrameMetadataListener(
                    (presentationTimeUs, releaseTimeNs, format, mediaFormat) -> {
                        lastVideoFrameRealtimeMs = android.os.SystemClock.elapsedRealtime();
                        awaitingFirstFrame = false;
                    });

            // Capture the session generation so events from a superseded media
            // (a rapid change-video / queue play-now) are dropped, never routed
            // into the new session's recovery machine.
            final long gen = generation;

            // BUGFIX: bind the player to the overlay surface — without this the
            // video never renders (black/blank) and some devices error out.
            if (exoView != null) {
                exoView.setPlayer(exoPlayer);
            }
            // Install the brightness matrix BEFORE prepare(). Media3 only sets
            // up the effect pipeline if setVideoEffects() ran at least once
            // pre-prepare; calling it for the first time later silently does
            // nothing, which is exactly why >100% brightness never applied.
            // The matrix is identity at 1.0 and stays in the graph for the
            // whole session, so later changes are a pure uniform update.
            exoEffectInstalled = false;
            exoEffectProbePending = false;
            if (!glEffectsDisabledForDevice) {
                try {
                    liveBrightness.setBrightness(lastBrightness);
                    exoPlayer.setVideoEffects(java.util.Collections.singletonList(
                            (androidx.media3.common.Effect) liveBrightness));
                    exoEffectInstalled = true;
                    // Verify the GL path actually renders on this device.
                    exoEffectProbePending = true;
                } catch (Throwable t) {
                    Log.e(TAG, "Could not install live brightness matrix", t);
                    glEffectsDisabledForDevice = true;
                }
            }

            exoPlayer.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    if (disposed || gen != generation) return;
                    if (state == Player.STATE_READY) {
                        actualState = desiredPlaying
                                ? (exoPlayer != null && exoPlayer.isPlaying() ? "playing" : "surface-wait")
                                : "paused";
                        if (listener != null) listener.onReady();
                    } else if (state == Player.STATE_BUFFERING) {
                        actualState = "buffering";
                        if (listener != null) listener.onBuffering(0);
                    } else if (state == Player.STATE_ENDED) {
                        ended = true;
                        desiredPlaying = false;
                        actualState = "ended";
                        if (listener != null) listener.onEnded();
                    }
                }

                @Override
                public void onIsPlayingChanged(boolean playing) {
                    if (disposed || gen != generation) return;
                    if (playing) {
                        actualState = "playing";
                        if (listener != null) listener.onPlaying();
                    } else if (!desiredPlaying) {
                        actualState = ended ? "ended" : "paused";
                        // Only an explicit room/user pause changes control
                        // intent. Buffering and surface rotation also make
                        // Exo isPlaying=false, but are not pauses.
                        if (listener != null) listener.onPaused();
                    } else if (!"buffering".equals(actualState)) {
                        actualState = "surface-wait";
                    }
                }

                @Override
                public void onRenderedFirstFrame() {
                    if (disposed || gen != generation) return;
                    lastVideoFrameRealtimeMs = android.os.SystemClock.elapsedRealtime();
                    awaitingFirstFrame = false;
                    if (desiredPlaying) actualState = "playing";
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

            // Black-screen guard for the always-on GL effect pipeline. Some
            // devices/decoders render nothing through the frame processor. If
            // the timeline advances with zero video frames, drop effects for
            // the rest of the process and restart this media effect-free.
            if (exoEffectProbePending) {
                final long probeGen = generation;
                mainHandler.postDelayed(() -> verifyGlEffectPipeline(probeGen), 4000L);
            }
        } catch (Exception e) {
            Log.e(TAG, "Could not start ExoPlayer; falling back to LibVLC", e);
            if (!disposed) startVlcPlayer("Switching engines…", url, title, referer, startMs);
        }
    }

    /**
     * One-shot check that the always-on GL effect pipeline actually produces
     * frames on this device. Runs ~4s after prepare(). If audio/timeline moved
     * but no video frame was ever rendered, the effect graph is the prime
     * suspect (a known Media3 failure mode on some hardware) — disable it
     * process-wide and restart the SAME media at the SAME position without
     * effects. Brightness then falls back to dim-overlay-only behaviour.
     */
    private void verifyGlEffectPipeline(long probeGeneration) {
        if (disposed || probeGeneration != generation) return;
        if (!exoEffectProbePending || exoPlayer == null) return;
        exoEffectProbePending = false;
        if (glEffectsDisabledForDevice) return;
        // A frame was rendered → the pipeline is healthy, nothing to do.
        if (lastVideoFrameRealtimeMs > 0L) return;
        // No frame yet. Only act if playback is genuinely progressing; a
        // stalled network / still-buffering stream is not an effects problem.
        long pos = getPositionMs();
        if (!desiredPlaying || pos < 1000L) return;

        Log.w(TAG, "No video frame with GL effects after 4s — disabling effects for this device");
        glEffectsDisabledForDevice = true;
        try {
            exoPlayer.setVideoEffects(java.util.Collections.emptyList());
            exoEffectInstalled = false;
        } catch (Throwable t) {
            Log.w(TAG, "Could not clear video effects", t);
        }
        // Removing effects post-prepare does not reliably rebuild the graph,
        // so restart the media effect-free from the current position.
        if (lastUrl != null) {
            startExoPlayer(lastUrl, lastTitle, lastReferer, Math.max(0L, pos));
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
                    if (event.getBuffering() < 100f) {
                        actualState = "buffering";
                        if (listener != null) listener.onBuffering(Math.round(event.getBuffering()));
                    }
                } else if (event.type == MediaPlayer.Event.Playing) {
                    actualState = "playing";
                    if (pendingSeekMs >= 0) {
                        try { vlcPlayer.setTime(pendingSeekMs); } catch (Exception ignored) { }
                        pendingSeekMs = -1;
                    }
                    finishVlcEffectsRebuild();
                    if (listener != null) {
                        listener.onReady();
                        listener.onPlaying();
                    }
                } else if (event.type == MediaPlayer.Event.Paused) {
                    if (!desiredPlaying) {
                        actualState = "paused";
                        if (listener != null) listener.onPaused();
                    } else {
                        actualState = "surface-wait";
                    }
                } else if (event.type == MediaPlayer.Event.EndReached) {
                    ended = true;
                    desiredPlaying = false;
                    actualState = "ended";
                    if (listener != null) listener.onEnded();
                } else if (event.type == MediaPlayer.Event.EncounteredError) {
                    finishVlcEffectsRebuild();
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
            vlcAppliedEffectsGeneration = effectsRequestGeneration;
            vlcEffectsRebuildInFlight = false;
            vlcEffectsRebuildStartedMs = 0L;
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
        surfaceHealthGeneration += 1;
        awaitingFirstFrame = false;
        lastVideoFrameRealtimeMs = 0L;
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
        vlcEffectsRebuildInFlight = false;
        vlcEffectsRebuildStartedMs = 0L;
        vlcApplyingEffectsGeneration = 0;
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
            if (vlcEffectsRebuildInFlight) {
                // Complete the one in-flight committed brightness rebuild
                // before touching VLC's output surface. The inverse ordering is
                // enforced in applyEffectsNow via surfaceTransitionUntilMs.
                long age = android.os.SystemClock.elapsedRealtime() - vlcEffectsRebuildStartedMs;
                if (age < 1500L) {
                    mainHandler.postDelayed(() -> refreshSurface(targetWidth, targetHeight), 250L);
                    return;
                }
                // Do not let a slow/dead media-open permanently block rotation.
                // Reconcile through finishVlcEffectsRebuild() rather than just
                // clearing the flag: the bare clear left vlcAppliedEffects-
                // Generation permanently behind the requested generation, so
                // the abandoned brightness value was never re-applied (a real
                // lost update — the slider kept its value, the video did not).
                finishVlcEffectsRebuild();
            }

            long transitionNow = android.os.SystemClock.elapsedRealtime();
            surfaceTransitionUntilMs = Math.max(surfaceTransitionUntilMs, transitionNow + 2200L);
            if (effectsQueued) {
                mainHandler.removeCallbacks(effectsDebounce);
                mainHandler.postDelayed(effectsDebounce, 2300L);
            }

            final int healthGeneration = ++surfaceHealthGeneration;
            final long positionAtRefresh = getPositionMs();
            final long frameAtRefresh = lastVideoFrameRealtimeMs;
            if (exoPlayer != null && desiredPlaying) {
                awaitingFirstFrame = true;
                actualState = "surface-wait";
            }

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

            if (exoPlayer != null && desiredPlaying) {
                mainHandler.postDelayed(() -> verifyExoFramesAfterSurfaceChange(
                        healthGeneration, positionAtRefresh, frameAtRefresh), 1600L);
            } else if (vlcPlayer != null && desiredPlaying) {
                // VLC exposes surface attachment but no reliable per-frame
                // callback. Re-run its supported resize once after layout
                // settles; this does not stop/rebuild media or seek.
                mainHandler.postDelayed(() -> {
                    if (disposed || healthGeneration != surfaceHealthGeneration
                            || vlcPlayer == null || !desiredPlaying) return;
                    try {
                        if (targetWidth > 0 && targetHeight > 0) {
                            vlcPlayer.getVLCVout().setWindowSize(targetWidth, targetHeight);
                        }
                        vlcPlayer.updateVideoSurfaces();
                        actualState = vlcPlayer.isPlaying() ? "playing" : "surface-wait";
                    } catch (Throwable t) {
                        Log.w(TAG, "VLC post-rotation surface check failed", t);
                    }
                }, 500L);
            }
        });
    }

    private void verifyExoFramesAfterSurfaceChange(int healthGeneration,
                                                    long positionAtRefresh,
                                                    long frameAtRefresh) {
        if (disposed || healthGeneration != surfaceHealthGeneration
                || exoPlayer == null || !desiredPlaying || ended) return;
        long now = android.os.SystemClock.elapsedRealtime();
        long positionNow = getPositionMs();
        boolean timelineAdvanced = positionNow - positionAtRefresh >= 500L;
        boolean frameAdvanced = lastVideoFrameRealtimeMs > frameAtRefresh
                && now - lastVideoFrameRealtimeMs < 1400L;
        if (!timelineAdvanced || frameAdvanced || !awaitingFirstFrame) {
            if (frameAdvanced) actualState = "playing";
            return;
        }

        // One targeted surface recovery, only after proving that the timeline
        // advanced without video frames. Ordinary rotations never detach.
        if (now - lastTargetedSurfaceRecoveryMs < 3000L) return;
        lastTargetedSurfaceRecoveryMs = now;
        surfaceTransitionUntilMs = Math.max(surfaceTransitionUntilMs, now + 1800L);
        if (effectsQueued) {
            mainHandler.removeCallbacks(effectsDebounce);
            mainHandler.postDelayed(effectsDebounce, 1900L);
        }
        actualState = "surface-wait";
        final long recoveryFrameMarker = lastVideoFrameRealtimeMs;
        try {
            if (exoView != null) {
                exoView.setPlayer(null);
                exoView.setPlayer(exoPlayer);
                exoView.requestLayout();
                android.view.View surface = exoView.getVideoSurfaceView();
                if (surface != null) {
                    surface.requestLayout();
                    surface.invalidate();
                }
            }
            if (desiredPlaying) exoPlayer.play();
        } catch (Throwable t) {
            Log.w(TAG, "Targeted Exo surface recovery failed", t);
        }

        // A same-position seek is the final, one-shot fallback because device
        // testing showed it flushes a decoder still targeting the old surface.
        mainHandler.postDelayed(() -> {
            if (disposed || healthGeneration != surfaceHealthGeneration
                    || exoPlayer == null || !desiredPlaying || ended) return;
            long checkNow = android.os.SystemClock.elapsedRealtime();
            boolean recovered = lastVideoFrameRealtimeMs > recoveryFrameMarker
                    && checkNow - lastVideoFrameRealtimeMs < 900L;
            if (recovered || !awaitingFirstFrame) {
                actualState = "playing";
                return;
            }
            try {
                exoPlayer.seekTo(Math.max(0L, getPositionMs()));
                exoPlayer.play();
            } catch (Throwable t) {
                Log.w(TAG, "Final Exo same-position recovery failed", t);
            }
        }, 1000L);
    }
}

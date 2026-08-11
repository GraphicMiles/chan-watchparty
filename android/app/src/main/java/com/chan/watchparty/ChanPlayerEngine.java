package com.chan.watchparty;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

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

    private ExoPlayer exoPlayer;
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

    public void release() {
        disposed = true;
        releaseExo();
        releaseVlc();
    }

    // ── Error classification ─────────────────────────────────────────────

    /** Map a PlaybackException to a recovery kind: expired | network | decode | other. */
    private String classifyExoError(PlaybackException error) {
        String codeName = String.valueOf(error.errorCodeName);
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

            exoPlayer = new ExoPlayer.Builder(context)
                    .setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory))
                    .build();

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
            vlcPlayer.setEventListener(event -> {
                if (disposed) return;
                if (event.type == MediaPlayer.Event.Buffering) {
                    if (event.getBuffering() < 100f && listener != null) {
                        listener.onBuffering(Math.round(event.getBuffering()));
                    }
                } else if (event.type == MediaPlayer.Event.Playing) {
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
            });

            Media media = new Media(libVLC, Uri.parse(url));
            media.setHWDecoderEnabled(true, false);
            media.addOption(":network-caching=2500");
            media.addOption(":http-reconnect");
            media.addOption(":http-user-agent=Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
            String ref = (referer != null && !referer.trim().isEmpty()) ? referer
                    : (url.toLowerCase().contains("downloadwella") ? "https://downloadwella.com/" : null);
            if (ref != null) media.addOption(":http-referrer=" + ref);

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

    /** True if ExoPlayer is the active engine. */
    public boolean isExoActive() { return exoPlayer != null; }
}

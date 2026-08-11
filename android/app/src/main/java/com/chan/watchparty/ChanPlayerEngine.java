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
        void onError(String friendlyMessage);
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

    public boolean shouldPreferVlc(String url) {
        String lower = String.valueOf(url).toLowerCase();
        return lower.contains(".mkv")
                || lower.contains("downloadwella")
                || lower.contains("fsmc")
                || lower.contains("hevc")
                || lower.contains("x265")
                || lower.contains("h265");
    }

    public void prepare(String playbackUrl, String title, String referer, long startMs) {
        if (disposed) return;
        ended = false;
        if (shouldPreferVlc(playbackUrl)) {
            startVlcPlayer("Using VLC engine…", playbackUrl, title, referer, startMs);
        } else {
            startExoPlayer(playbackUrl, title, referer, startMs);
        }
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

    // ── Engine implementations ───────────────────────────────────────────

    private Map<String, String> headersFor(String referer, String url) {
        Map<String, String> headers = new HashMap<>();
        headers.put("User-Agent", "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
        if (referer != null && !referer.trim().isEmpty()) {
            headers.put("Referer", referer.trim());
        } else if (url != null && url.toLowerCase().contains("downloadwella")) {
            headers.put("Referer", "https://downloadwella.com/");
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
                    Log.e(TAG, "ExoPlayer error; falling back to LibVLC", error);
                    if (!disposed) {
                        startVlcPlayer("Switching engines…", url, title, referer, startMs);
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
                        listener.onError("Couldn't play this video. It may be unavailable or expired.");
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
                listener.onError("Couldn't play this video. It may be unavailable or expired.");
            }
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

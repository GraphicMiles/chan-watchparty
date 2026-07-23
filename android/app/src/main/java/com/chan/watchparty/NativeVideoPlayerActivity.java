package com.chan.watchparty;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

/**
 * In-app native player for streams Android WebView rejects.
 *
 * Strategy:
 * 1. Use LibVLC first for MKV/DownloadWella/HEVC-like streams.
 * 2. Use Media3/ExoPlayer first for MP4/HLS/simple progressive streams.
 * 3. If Media3 fails, switch in-app to LibVLC automatically.
 *
 * No external player intent is required.
 */
public class NativeVideoPlayerActivity extends Activity {
    private static final String TAG = "NativeVideoPlayer";

    private ExoPlayer exoPlayer;
    private PlayerView exoView;

    private LibVLC libVLC;
    private MediaPlayer vlcPlayer;
    private VLCVideoLayout vlcLayout;

    private TextView statusView;
    private String playbackUrl;
    private String title;
    private String referer;
    private long startMs;
    private boolean vlcStarted = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN, WindowManager.LayoutParams.FLAG_FULLSCREEN);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        hideSystemUi();

        playbackUrl = getIntent().getStringExtra("url");
        title = getIntent().getStringExtra("title");
        referer = getIntent().getStringExtra("referer");
        startMs = getIntent().getLongExtra("startMs", 0L);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        vlcLayout = new VLCVideoLayout(this);
        vlcLayout.setVisibility(View.GONE);
        root.addView(vlcLayout, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        exoView = new PlayerView(this);
        exoView.setUseController(true);
        exoView.setControllerAutoShow(true);
        exoView.setKeepScreenOn(true);
        root.addView(exoView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        statusView = new TextView(this);
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(15f);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(32, 32, 32, 32);
        statusView.setBackgroundColor(Color.argb(165, 0, 0, 0));
        statusView.setText("Preparing video...");
        root.addView(statusView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP
        ));

        setContentView(root);

        if (playbackUrl == null || playbackUrl.trim().isEmpty()) {
            showStatus("No video URL was provided.", true);
            return;
        }

        if (shouldPreferVlc(playbackUrl)) {
            startVlcPlayer("Using VLC engine for MKV/HEVC stream...");
        } else {
            startExoPlayer();
        }
    }

    private boolean shouldPreferVlc(String url) {
        String lower = url.toLowerCase();
        return lower.contains(".mkv")
            || lower.contains("downloadwella")
            || lower.contains("fsmc")
            || lower.contains("hevc")
            || lower.contains("x265")
            || lower.contains("h265");
    }

    private Map<String, String> defaultHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("User-Agent", "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
        if (referer != null && !referer.trim().isEmpty()) {
            headers.put("Referer", referer.trim());
        } else if (playbackUrl != null && playbackUrl.toLowerCase().contains("downloadwella")) {
            headers.put("Referer", "https://downloadwella.com/");
        }
        return headers;
    }

    private void startExoPlayer() {
        try {
            releaseVlc();
            vlcLayout.setVisibility(View.GONE);
            exoView.setVisibility(View.VISIBLE);
            showStatus("Loading video...", false);

            DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000)
                .setDefaultRequestProperties(defaultHeaders());

            exoPlayer = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(httpFactory))
                .build();

            exoView.setPlayer(exoPlayer);
            exoPlayer.addListener(new Player.Listener() {
                @Override
                public void onPlaybackStateChanged(int state) {
                    if (state == Player.STATE_READY) hideStatus();
                    if (state == Player.STATE_BUFFERING) showStatus("Buffering...", false);
                }

                @Override
                public void onPlayerError(PlaybackException error) {
                    Log.e(TAG, "Media3 playback error; falling back to LibVLC", error);
                    startVlcPlayer("Switching to VLC engine for this stream...");
                }
            });

            MediaItem mediaItem = new MediaItem.Builder()
                .setUri(Uri.parse(playbackUrl))
                .setMediaId(title != null ? title : playbackUrl)
                .build();
            exoPlayer.setMediaItem(mediaItem);
            exoPlayer.prepare();
            if (startMs > 0) exoPlayer.seekTo(startMs);
            exoPlayer.play();
        } catch (Exception e) {
            Log.e(TAG, "Could not start Media3; falling back to LibVLC", e);
            startVlcPlayer("Switching to VLC engine...");
        }
    }

    private void startVlcPlayer(String message) {
        if (vlcStarted) return;
        vlcStarted = true;
        runOnUiThread(() -> {
            try {
                releaseExo();
                exoView.setVisibility(View.GONE);
                vlcLayout.setVisibility(View.VISIBLE);
                showStatus(message, false);

                ArrayList<String> args = new ArrayList<>();
                args.add("--network-caching=2500");
                args.add("--file-caching=1500");
                args.add("--http-reconnect");
                args.add("--avcodec-hw=any");
                args.add("--no-drop-late-frames");
                args.add("--no-skip-frames");

                libVLC = new LibVLC(this, args);
                vlcPlayer = new MediaPlayer(libVLC);
                vlcPlayer.attachViews(vlcLayout, null, false, false);
                vlcPlayer.setEventListener(event -> {
                    if (event.type == MediaPlayer.Event.Opening) {
                        showStatus("Opening stream with VLC engine...", false);
                    } else if (event.type == MediaPlayer.Event.Buffering) {
                        if (event.getBuffering() < 100f) {
                            showStatus("Buffering " + Math.round(event.getBuffering()) + "%", false);
                        }
                    } else if (event.type == MediaPlayer.Event.Playing) {
                        hideStatus();
                    } else if (event.type == MediaPlayer.Event.EncounteredError) {
                        showStatus("VLC playback failed. This stream may be expired or blocked by the host.", true);
                    }
                });

                Media media = new Media(libVLC, Uri.parse(playbackUrl));
                media.setHWDecoderEnabled(true, false);
                media.addOption(":network-caching=2500");
                media.addOption(":http-reconnect");
                media.addOption(":http-user-agent=Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
                if (referer != null && !referer.trim().isEmpty()) {
                    media.addOption(":http-referrer=" + referer.trim());
                } else if (playbackUrl.toLowerCase().contains("downloadwella")) {
                    media.addOption(":http-referrer=https://downloadwella.com/");
                }

                vlcPlayer.setMedia(media);
                media.release();
                vlcPlayer.play();
                if (startMs > 0) vlcPlayer.setTime(startMs);
            } catch (Exception e) {
                Log.e(TAG, "Could not start LibVLC", e);
                showStatus("Could not start VLC engine: " + e.getMessage(), true);
            }
        });
    }

    private void showStatus(String message, boolean sticky) {
        if (statusView != null) {
            statusView.setText(message);
            statusView.setVisibility(View.VISIBLE);
            if (!sticky) {
                statusView.removeCallbacks(null);
            }
        }
    }

    private void hideStatus() {
        if (statusView != null) statusView.setVisibility(View.GONE);
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    private void releaseExo() {
        if (exoPlayer != null) {
            exoPlayer.release();
            exoPlayer = null;
        }
        if (exoView != null) exoView.setPlayer(null);
    }

    private void releaseVlc() {
        if (vlcPlayer != null) {
            try { vlcPlayer.stop(); } catch (Exception ignored) {}
            try { vlcPlayer.detachViews(); } catch (Exception ignored) {}
            vlcPlayer.release();
            vlcPlayer = null;
        }
        if (libVLC != null) {
            libVLC.release();
            libVLC = null;
        }
        vlcStarted = false;
    }

    @Override
    protected void onDestroy() {
        releaseExo();
        releaseVlc();
        super.onDestroy();
    }
}

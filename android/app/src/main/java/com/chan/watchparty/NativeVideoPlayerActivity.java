package com.chan.watchparty;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Icon;
import android.graphics.PorterDuff;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.Rational;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.SeekBar;
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
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * In-app native player for streams Android WebView rejects.
 *
 * Strategy:
 * 1. Use LibVLC first for MKV/DownloadWella/HEVC-like streams.
 * 2. Use Media3/ExoPlayer first for MP4/HLS/simple progressive streams.
 * 3. If Media3 fails, switch in-app to LibVLC automatically.
 *
 * P0 (2026-08-11) — the player is now a room-aware surface instead of a
 * fullscreen takeover:
 *  - Custom control overlay (back, title, PiP, play/pause, seek bar, times)
 *    for BOTH the VLC and ExoPlayer paths — VLC no longer has zero controls.
 *  - Orientation follows the sensor (no forced landscape).
 *  - Picture-in-Picture on API 26+ (home button auto-PiPs while playing),
 *    so users can return to the room while video keeps playing.
 *  - On close, the activity returns { positionMs, durationMs, ended,
 *    wasPlaying } via setResult so the web layer can resync the room and
 *    continue the queue.
 *
 * No external player intent is required.
 */
public class NativeVideoPlayerActivity extends Activity {
    private static final String TAG = "NativeVideoPlayer";
    private static final String ACTION_TOGGLE_PLAY = "com.chan.watchparty.TOGGLE_PLAY";
    private static final long CONTROLS_HIDE_DELAY_MS = 3500L;
    private static final long PROGRESS_POLL_MS = 300L;

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
    private boolean isEnded = false;
    private boolean inPip = false;
    private boolean seeking = false;
    private boolean resultDelivered = false;

    // Custom control overlay
    private FrameLayout controlsOverlay;
    private LinearLayout topBar;
    private LinearLayout bottomBar;
    private TextView btnBack;
    private TextView titleView;
    private TextView btnPip;
    private ImageButton btnPlayPause;
    private SeekBar seekBar;
    private TextView timeCurrent;
    private TextView timeTotal;

    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    private final Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || isDestroyed()) return;
            updateProgressUi();
            uiHandler.postDelayed(this, PROGRESS_POLL_MS);
        }
    };

    private final Runnable hideControlsRunnable = new Runnable() {
        @Override
        public void run() {
            if (!seeking && isPlaying()) setControlsVisible(false);
        }
    };

    private BroadcastReceiver piPReceiver;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        // P0: no forced landscape — follow the sensor so users can hold the phone
        // any way they like (PiP also manages its own aspect).
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR);
        hideSystemUi();

        playbackUrl = getIntent().getStringExtra("url");
        title = getIntent().getStringExtra("title");
        referer = getIntent().getStringExtra("referer");
        startMs = getIntent().getLongExtra("startMs", 0L);

        buildUi();

        if (playbackUrl == null || playbackUrl.trim().isEmpty()) {
            showStatus("No video URL was provided.", true);
            return;
        }

        registerPiPReceiver();

        if (shouldPreferVlc(playbackUrl)) {
            startVlcPlayer("Using VLC engine for MKV/HEVC stream...");
        } else {
            startExoPlayer();
        }

        uiHandler.post(progressRunnable);
        resetControlsTimer();
    }

    // ─────────────────────────── UI BUILD ───────────────────────────

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        vlcLayout = new VLCVideoLayout(this);
        vlcLayout.setVisibility(View.GONE);
        root.addView(vlcLayout, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        exoView = new PlayerView(this);
        // P0: our custom overlay provides the controls — disable Exo's default
        // controller so there is exactly one consistent UI.
        exoView.setUseController(false);
        exoView.setKeepScreenOn(true);
        root.addView(exoView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        statusView = new TextView(this);
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(15f);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(dp(32), dp(32), dp(32), dp(32));
        statusView.setBackgroundColor(Color.argb(165, 0, 0, 0));
        statusView.setText("Preparing video...");
        root.addView(statusView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        ));

        // ── Control overlay ──
        controlsOverlay = new FrameLayout(this);
        controlsOverlay.setClickable(true);
        controlsOverlay.setOnClickListener(v -> toggleControls());

        topBar = buildTopBar();
        bottomBar = buildBottomBar();

        controlsOverlay.addView(topBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
        ));
        controlsOverlay.addView(bottomBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
        ));

        root.addView(controlsOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        setContentView(root);
    }

    private LinearLayout buildTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.argb(215, 10, 10, 12));
        bar.setPadding(dp(10), dp(6), dp(10), dp(6));
        // Swallow clicks on the bar itself so they don't toggle the overlay
        bar.setOnClickListener(v -> resetControlsTimer());

        btnBack = new TextView(this);
        btnBack.setText("\u2190");
        btnBack.setTextColor(Color.WHITE);
        btnBack.setTextSize(20f);
        btnBack.setContentDescription("Back to room");
        btnBack.setPadding(dp(10), dp(4), dp(10), dp(4));
        btnBack.setOnClickListener(v -> finishWithResult());

        titleView = new TextView(this);
        titleView.setText(title != null && !title.trim().isEmpty() ? title : "Chan Video");
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(15f);
        titleView.setMaxLines(1);
        titleView.setEllipsize(android.text.TextUtils.TruncateAt.END);
        titleView.setGravity(Gravity.CENTER_VERTICAL);
        titleView.setPadding(dp(6), 0, dp(6), 0);

        btnPip = new TextView(this);
        btnPip.setText("PiP");
        btnPip.setTextColor(Color.WHITE);
        btnPip.setTextSize(14f);
        btnPip.setGravity(Gravity.CENTER);
        btnPip.setContentDescription("Picture in picture");
        btnPip.setPadding(dp(12), dp(6), dp(10), dp(6));
        btnPip.setOnClickListener(v -> enterPip());
        btnPip.setVisibility(Build.VERSION.SDK_INT >= 26 ? View.VISIBLE : View.GONE);

        bar.addView(btnBack, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        bar.addView(titleView, new LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
        ));
        bar.addView(btnPip, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        return bar;
    }

    private LinearLayout buildBottomBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.argb(215, 10, 10, 12));
        bar.setPadding(dp(8), dp(6), dp(8), dp(8));
        bar.setOnClickListener(v -> resetControlsTimer());

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        btnPlayPause = new ImageButton(this);
        btnPlayPause.setBackground(null);
        btnPlayPause.setImageResource(android.R.drawable.ic_media_play);
        btnPlayPause.setColorFilter(Color.WHITE);
        btnPlayPause.setContentDescription("Play");
        btnPlayPause.setOnClickListener(v -> togglePlayPause());

        timeCurrent = new TextView(this);
        timeCurrent.setText("0:00");
        timeCurrent.setTextColor(Color.WHITE);
        timeCurrent.setTextSize(12f);
        timeCurrent.setPadding(dp(8), 0, dp(4), 0);

        seekBar = new SeekBar(this);
        seekBar.setMax(1);
        seekBar.setPadding(dp(4), 0, dp(4), 0);
        tintSeekBar(seekBar);
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser) timeCurrent.setText(formatTime(progress));
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
                seeking = true;
                uiHandler.removeCallbacks(hideControlsRunnable);
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
                seeking = false;
                seekToMs(bar.getProgress());
                resetControlsTimer();
            }
        });

        timeTotal = new TextView(this);
        timeTotal.setText("0:00");
        timeTotal.setTextColor(Color.WHITE);
        timeTotal.setTextSize(12f);
        timeTotal.setPadding(dp(4), 0, dp(8), 0);

        row.addView(btnPlayPause, new LinearLayout.LayoutParams(dp(44), dp(44)));
        row.addView(timeCurrent, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        row.addView(seekBar, new LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
        ));
        row.addView(timeTotal, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        bar.addView(row);
        return bar;
    }

    private void tintSeekBar(SeekBar bar) {
        try {
            Drawable progress = bar.getProgressDrawable();
            if (progress != null) progress.setColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN);
            if (bar.getThumb() != null) bar.getThumb().setColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN);
        } catch (Exception ignored) { /* non-critical */ }
    }

    private void setControlsVisible(boolean visible) {
        if (controlsOverlay == null) return;
        topBar.setVisibility(visible ? View.VISIBLE : View.GONE);
        bottomBar.setVisibility(visible ? View.VISIBLE : View.GONE);
        if (visible) resetControlsTimer();
    }

    private void toggleControls() {
        boolean visible = topBar.getVisibility() == View.VISIBLE;
        setControlsVisible(!visible);
    }

    private void resetControlsTimer() {
        uiHandler.removeCallbacks(hideControlsRunnable);
        uiHandler.postDelayed(hideControlsRunnable, CONTROLS_HIDE_DELAY_MS);
    }

    // ─────────────────────────── PIP ───────────────────────────

    private void enterPip() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(16, 9))
                    .setActions(Collections.singletonList(buildTogglePlayRemoteAction()));
            if (Build.VERSION.SDK_INT >= 31) builder.setSeamlessResizeEnabled(true);
            enterPictureInPictureMode(builder.build());
        } catch (Exception e) {
            Log.w(TAG, "Could not enter PiP", e);
        }
    }

    private RemoteAction buildTogglePlayRemoteAction() {
        if (Build.VERSION.SDK_INT < 26) return null;
        boolean playing = isPlaying();
        Intent intent = new Intent(ACTION_TOGGLE_PLAY);
        android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(
                this, 1, intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE
        );
        Icon icon = Icon.createWithResource(
                this,
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play
        );
        return new RemoteAction(icon, "Play/Pause", "Toggle playback", pi);
    }

    private void registerPiPReceiver() {
        if (Build.VERSION.SDK_INT < 26) return;
        piPReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_TOGGLE_PLAY.equals(intent.getAction())) {
                    runOnUiThread(() -> togglePlayPause());
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_TOGGLE_PLAY);
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(piPReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(piPReceiver, filter);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not register PiP receiver", e);
        }
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Home button while playing → float the video over the room instead of
        // leaving the user stranded on a fullscreen activity.
        if (Build.VERSION.SDK_INT >= 26 && !inPip && isPlaying()) enterPip();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        inPip = isInPictureInPictureMode;
        // PiP window closed via the X → activity is being finished; hand the
        // position back before it goes away.
        if (!isInPictureInPictureMode && isFinishing()) {
            finishWithResult();
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Never play audio in the background. In PiP this is not called (the
        // activity stays visible), so PiP keeps playing by design.
        if (!inPip && !isFinishing()) pauseAll();
    }

    // ─────────────────────────── PLAYER LOGIC ───────────────────────────

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
                    if (state == Player.STATE_ENDED) {
                        isEnded = true;
                        showStatus("Playback finished", false);
                    }
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
                // VLC events arrive on a background thread — marshal UI updates to the main thread.
                vlcPlayer.setEventListener(event -> runOnUiThread(() -> {
                    if (event.type == MediaPlayer.Event.Opening) {
                        showStatus("Opening stream with VLC engine...", false);
                    } else if (event.type == MediaPlayer.Event.Buffering) {
                        if (event.getBuffering() < 100f) {
                            showStatus("Buffering " + Math.round(event.getBuffering()) + "%", false);
                        }
                    } else if (event.type == MediaPlayer.Event.Playing) {
                        hideStatus();
                    } else if (event.type == MediaPlayer.Event.EndReached) {
                        isEnded = true;
                        showStatus("Playback finished", false);
                    } else if (event.type == MediaPlayer.Event.EncounteredError) {
                        showStatus("VLC playback failed. This stream may be expired or blocked by the host.", true);
                    }
                }));

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

    // ─────────────────────────── CONTROLS ───────────────────────────

    private void togglePlayPause() {
        if (isPlaying()) {
            pauseAll();
        } else {
            playAll();
        }
        updateProgressUi();
        resetControlsTimer();
    }

    private void playAll() {
        if (exoPlayer != null) {
            try { exoPlayer.play(); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.play(); } catch (Exception ignored) { }
        }
    }

    private void pauseAll() {
        if (exoPlayer != null) {
            try { exoPlayer.pause(); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.pause(); } catch (Exception ignored) { }
        }
    }

    private void seekToMs(long ms) {
        if (exoPlayer != null) {
            try { exoPlayer.seekTo(Math.max(0, ms)); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { vlcPlayer.setTime(Math.max(0, ms)); } catch (Exception ignored) { }
        }
    }

    private boolean isPlaying() {
        if (exoPlayer != null) {
            try { return exoPlayer.isPlaying(); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { return vlcPlayer.isPlaying(); } catch (Exception ignored) { }
        }
        return false;
    }

    private long getPositionMs() {
        if (exoPlayer != null) {
            try { return Math.max(0, exoPlayer.getCurrentPosition()); } catch (Exception ignored) { }
        }
        if (vlcPlayer != null) {
            try { return Math.max(0, vlcPlayer.getTime()); } catch (Exception ignored) { }
        }
        return 0;
    }

    private long getDurationMs() {
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

    private void updateProgressUi() {
        long dur = getDurationMs();
        long pos = getPositionMs();
        if (dur > 0) {
            seekBar.setMax((int) Math.min(dur, Integer.MAX_VALUE));
        }
        if (!seeking) {
            seekBar.setProgress((int) pos);
            timeCurrent.setText(formatTime(pos));
        }
        timeTotal.setText(formatTime(dur));
        boolean playing = isPlaying();
        btnPlayPause.setImageResource(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
        btnPlayPause.setContentDescription(playing ? "Pause" : "Play");
    }

    // ─────────────────────────── RESULT ───────────────────────────

    private void finishWithResult() {
        if (resultDelivered) return;
        resultDelivered = true;
        Intent data = new Intent();
        data.putExtra("positionMs", getPositionMs());
        data.putExtra("durationMs", getDurationMs());
        data.putExtra("ended", isEnded);
        data.putExtra("wasPlaying", isPlaying());
        setResult(Activity.RESULT_OK, data);
        finish();
    }

    @Override
    public void onBackPressed() {
        finishWithResult();
    }

    // ─────────────────────────── MISC ───────────────────────────

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

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String formatTime(long ms) {
        long totalSec = ms / 1000;
        long h = totalSec / 3600;
        long m = (totalSec % 3600) / 60;
        long s = totalSec % 60;
        return h > 0
                ? String.format(Locale.US, "%d:%02d:%02d", h, m, s)
                : String.format(Locale.US, "%d:%02d", m, s);
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

    @Override
    protected void onDestroy() {
        uiHandler.removeCallbacks(progressRunnable);
        uiHandler.removeCallbacks(hideControlsRunnable);
        if (piPReceiver != null) {
            try { unregisterReceiver(piPReceiver); } catch (Exception ignored) { }
            piPReceiver = null;
        }
        releaseExo();
        releaseVlc();
        super.onDestroy();
    }
}

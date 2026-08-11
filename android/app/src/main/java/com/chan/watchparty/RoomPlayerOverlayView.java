package com.chan.watchparty;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.util.AttributeSet;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.Locale;

/**
 * RoomPlayerOverlayView — the inline native video surface (Phase 2).
 *
 * A FrameLayout that hosts the native engines (ExoPlayer PlayerView + VLC
 * surface) plus a minimal, native-drawn control bar (play/pause, seek, time,
 * fullscreen, PiP) and friendly status text. It is positioned over the room's
 * stage rect by the JS layer via VideoPlayerPlugin.setRect().
 */
public class RoomPlayerOverlayView extends FrameLayout {
    private static final long CONTROLS_HIDE_DELAY_MS = 3500L;
    private static final long PROGRESS_POLL_MS = 300L;

    private PlayerView exoView;
    private VLCVideoLayout vlcLayout;
    private TextView statusView;

    private LinearLayout controlsBar;
    private ImageButton btnPlayPause;
    private SeekBar seekBar;
    private TextView timeCurrent;
    private TextView timeTotal;
    private TextView btnFullscreen;
    private TextView btnPip;

    private ChanPlayerEngine engine;
    private boolean seeking = false;
    private boolean controlsVisible = true;
    private boolean isFullscreen = false;
    private boolean interactive = true;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable hideControlsRunnable = () -> {
        if (!seeking && engine != null && engine.isPlaying()) setControlsVisible(false);
    };
    private Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            if (getWindowToken() == null) return;
            updateProgress();
            handler.postDelayed(this, PROGRESS_POLL_MS);
        }
    };

    public RoomPlayerOverlayView(Context context) {
        super(context);
        init(context);
    }

    public RoomPlayerOverlayView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init(context);
    }

    private void init(Context context) {
        setBackgroundColor(Color.BLACK);
        setClickable(true);
        setOnClickListener(v -> {
            if (interactive) {
                toggleControls();
            } else if (tapListener != null) {
                tapListener.onTap();
            }
        });

        // VLC surface (hidden until VLC engine is used)
        vlcLayout = new VLCVideoLayout(context);
        vlcLayout.setVisibility(GONE);
        addView(vlcLayout, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
                Gravity.CENTER
        ));

        // Exo surface (controls handled by our bar, not Exo's)
        exoView = new PlayerView(context);
        exoView.setUseController(false);
        exoView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        exoView.setKeepScreenOn(true);
        addView(exoView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
                Gravity.CENTER
        ));

        // Friendly status text (fetching / buffering / finished / errors)
        statusView = new TextView(context);
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(14f);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(dp(20), dp(10), dp(20), dp(10));
        statusView.setBackgroundColor(Color.argb(140, 0, 0, 0));
        statusView.setVisibility(GONE);
        addView(statusView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        ));

        controlsBar = buildControls(context);
        addView(controlsBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM
        ));
        setControlsVisible(true);
    }

    // ── Engine wiring ────────────────────────────────────────────────────

    public void setEngine(ChanPlayerEngine engine) {
        this.engine = engine;
        engine.attachVlcLayout(vlcLayout);
        engine.attachExoView(exoView);
        handler.post(progressRunnable);
    }

    public ChanPlayerEngine getEngine() { return engine; }

    public void showExo() {
        // Engine owns its exoView; we just make sure the right surface shows.
        vlcLayout.setVisibility(GONE);
        exoView.setVisibility(VISIBLE);
    }

    public void showVlc() {
        exoView.setVisibility(GONE);
        vlcLayout.setVisibility(VISIBLE);
    }

    // ── Status ───────────────────────────────────────────────────────────

    public void showStatus(String text, boolean sticky) {
        if (statusView == null) return;
        statusView.setText(text);
        statusView.setVisibility(VISIBLE);
        // Don't remove the progress poller — status is cleared by the next
        // ready/playing event (or stays visible when sticky).
    }

    public void hideStatus() {
        if (statusView != null) statusView.setVisibility(GONE);
    }

    // ── Controls bar ─────────────────────────────────────────────────────

    private LinearLayout buildControls(Context context) {
        LinearLayout bar = new LinearLayout(context);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.argb(200, 8, 8, 10));
        bar.setPadding(dp(8), dp(4), dp(8), dp(4));
        bar.setOnClickListener(v -> resetControlsTimer());

        btnPlayPause = new ImageButton(context);
        btnPlayPause.setBackground(null);
        btnPlayPause.setImageResource(android.R.drawable.ic_media_play);
        btnPlayPause.setColorFilter(Color.WHITE);
        btnPlayPause.setContentDescription("Play");
        btnPlayPause.setOnClickListener(v -> {
            if (engine == null) return;
            if (engine.isPlaying()) engine.pause();
            else engine.play();
            updateProgress();
            resetControlsTimer();
        });

        timeCurrent = new TextView(context);
        timeCurrent.setText("0:00");
        timeCurrent.setTextColor(Color.WHITE);
        timeCurrent.setTextSize(12f);
        timeCurrent.setPadding(dp(8), 0, dp(4), 0);

        seekBar = new SeekBar(context);
        seekBar.setMax(1);
        seekBar.setPadding(dp(4), 0, dp(4), 0);
        tint(seekBar);
        seekBar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser) timeCurrent.setText(formatTime(progress));
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {
                seeking = true;
                handler.removeCallbacks(hideControlsRunnable);
            }

            @Override
            public void onStopTrackingTouch(SeekBar bar) {
                seeking = false;
                if (engine != null) engine.seekTo(bar.getProgress());
                resetControlsTimer();
            }
        });

        timeTotal = new TextView(context);
        timeTotal.setText("0:00");
        timeTotal.setTextColor(Color.WHITE);
        timeTotal.setTextSize(12f);
        timeTotal.setPadding(dp(4), 0, dp(8), 0);

        btnFullscreen = new TextView(context);
        btnFullscreen.setText("⛶");
        btnFullscreen.setTextColor(Color.WHITE);
        btnFullscreen.setTextSize(16f);
        btnFullscreen.setPadding(dp(8), dp(2), dp(6), dp(2));
        btnFullscreen.setContentDescription("Fullscreen");
        btnFullscreen.setOnClickListener(v -> {
            if (fullscreenListener != null) fullscreenListener.onToggleFullscreen();
            resetControlsTimer();
        });

        btnPip = new TextView(context);
        btnPip.setText("PiP");
        btnPip.setTextColor(Color.WHITE);
        btnPip.setTextSize(12f);
        btnPip.setGravity(Gravity.CENTER);
        btnPip.setPadding(dp(8), dp(2), dp(6), dp(2));
        btnPip.setContentDescription("Picture in picture");
        btnPip.setOnClickListener(v -> {
            if (pipListener != null) pipListener.onEnterPip();
            resetControlsTimer();
        });

        bar.addView(btnPlayPause, new LinearLayout.LayoutParams(dp(40), dp(40)));
        bar.addView(timeCurrent, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        bar.addView(seekBar, new LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
        ));
        bar.addView(timeTotal, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        bar.addView(btnFullscreen, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        bar.addView(btnPip, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        return bar;
    }

    private void tint(SeekBar bar) {
        try {
            Drawable p = bar.getProgressDrawable();
            if (p != null) p.setColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN);
            if (bar.getThumb() != null) bar.getThumb().setColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN);
        } catch (Exception ignored) { }
    }

    private void setControlsVisible(boolean visible) {
        controlsVisible = visible;
        controlsBar.setVisibility(visible ? VISIBLE : GONE);
        if (visible) resetControlsTimer();
    }

    private void toggleControls() {
        setControlsVisible(!controlsVisible);
    }

    private void resetControlsTimer() {
        handler.removeCallbacks(hideControlsRunnable);
        handler.postDelayed(hideControlsRunnable, CONTROLS_HIDE_DELAY_MS);
    }

    private void updateProgress() {
        if (engine == null) return;
        long dur = engine.getDurationMs();
        long pos = engine.getPositionMs();
        if (dur > 0) seekBar.setMax((int) Math.min(dur, Integer.MAX_VALUE));
        if (!seeking) {
            seekBar.setProgress((int) pos);
            timeCurrent.setText(formatTime(pos));
        }
        timeTotal.setText(formatTime(dur));
        boolean playing = engine.isPlaying();
        btnPlayPause.setImageResource(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
        btnPlayPause.setContentDescription(playing ? "Pause" : "Play");
    }

    // ── External hooks (from the plugin) ─────────────────────────────────

    public void setInteractive(boolean interactive) {
        this.interactive = interactive;
        // Requirement: NO native chrome when the app's own control bar drives
        // playback. Controls bar fully hidden, never toggled back by taps.
        controlsBar.setVisibility(interactive ? (controlsVisible ? VISIBLE : GONE) : GONE);
    }

    public boolean isInteractive() { return interactive; }

    public interface TapListener { void onTap(); }
    private TapListener tapListener;
    public void setTapListener(TapListener l) { tapListener = l; }

    public interface FullscreenListener { void onToggleFullscreen(); }
    public interface PipListener { void onEnterPip(); }
    private FullscreenListener fullscreenListener;
    private PipListener pipListener;
    public void setFullscreenListener(FullscreenListener l) { fullscreenListener = l; }
    public void setPipListener(PipListener l) { pipListener = l; }

    public void setFullscreenUi(boolean fullscreen) {
        isFullscreen = fullscreen;
        // Letterbox stays centered; plugin resizes this view itself.
    }

    // ── Teardown ─────────────────────────────────────────────────────────

    public void teardown() {
        handler.removeCallbacksAndMessages(null);
        if (engine != null) {
            engine.release();
            engine = null;
        }
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

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}

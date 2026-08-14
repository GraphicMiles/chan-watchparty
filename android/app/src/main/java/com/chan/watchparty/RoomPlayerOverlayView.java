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
import android.view.ViewGroup;
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
    private TextView subtitleText;
    private View dimView; // 0–100% black multiply — real darkening, never touches the engine

    // Brightness popup — a native-drawn panel rendered OVER the video surface
    // (the only layer that can actually sit above it). Real brightness is
    // applied to the engine (Exo live effect / VLC adjust via JNI); the dim
    // layer only handles the <=100% (true multiply) path.
    private View brightnessScrim;
    private LinearLayout brightnessPopup;
    private SeekBar brightnessSeek;
    private TextView brightnessValue;
    private float lastBrightness = 1f;

    /** Callbacks from the brightness popup to the plugin (applies + syncs JS). */
    public interface BrightnessPopupListener {
        void onBrightnessChanged(float brightness);
        void onBrightnessPopupClosed();
    }
    private BrightnessPopupListener brightnessPopupListener;

    // Volume popover — rendered in the native layer (above the video surface),
    // so the video keeps playing while the user adjusts volume. Mirrors the
    // brightness popover's layout/centering.
    private View volumeScrim;
    private LinearLayout volumePopup;
    private SeekBar volumeSeek;
    private TextView volumeValue;
    private TextView volumeMuteBtn;
    private float lastVolume = 1f;
    private boolean lastMuted = false;

    /** Callbacks from the volume popover to the plugin (applies + syncs JS). */
    public interface VolumePopupListener {
        void onVolumeChanged(float volume, boolean muted);
        void onVolumePopupClosed();
    }
    private VolumePopupListener volumePopupListener;

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
        // Touch handling: when interactive (native chrome on) a tap toggles the
        // native bar. When NOT interactive (the app drives controls), every
        // touch is forwarded to JS with its x/y fraction so the web layer can
        // do single-tap toggle, double-tap side seek (-10s/+10s) itself.
        setOnTouchListener((v, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_DOWN) {
                if (interactive) {
                    toggleControls();
                    return true;
                }
                if (tapListener != null) {
                    float fx = (float) event.getX() / Math.max(1, getWidth());
                    float fy = (float) event.getY() / Math.max(1, getHeight());
                    tapListener.onTap(fx, fy);
                    return true;
                }
            }
            return false;
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
        // Inflate from XML: surface_type="texture_view" gives a GL-backed
        // surface so Media3 video effects (Brightness/Contrast/HslAdjustment)
        // actually render — a plain SurfaceView silently ignores them.
        exoView = (PlayerView) android.view.LayoutInflater.from(context)
                .inflate(R.layout.chan_player_view, this, false);
        exoView.setKeepScreenOn(true);
        addView(exoView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
                Gravity.CENTER
        ));

        // Brightness dim layer — a translucent black view over the video.
        // alpha = 1 - b is an exact multiply (out = video * b) — REAL
        // brightness for the <=100% path. Pure UI — never touches the engine.
        dimView = new View(context);
        dimView.setBackgroundColor(Color.BLACK);
        dimView.setAlpha(0f);
        dimView.setClickable(false);
        addView(dimView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        // Popup must be able to overflow the video box (it's often shorter
        // than the panel). We reparent to the window decor when showing.
        setClipChildren(false);
        setClipToPadding(false);

        buildBrightnessPopup(context);
        buildVolumePopup(context);

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

        // Closed captions — anchored at the BOTTOM of the video (margin-bottom
        // 1rem ≈ 16dp). Driven from the parsed VTT cues in ChanPlayerEngine;
        // this view is updated by the progress poller in updateProgress().
        subtitleText = new TextView(context);
        subtitleText.setTextColor(Color.WHITE);
        subtitleText.setTextSize(15f);
        subtitleText.setGravity(Gravity.CENTER);
        subtitleText.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        subtitleText.setPadding(dp(14), dp(8), dp(14), dp(8));
        subtitleText.setBackgroundColor(Color.argb(150, 0, 0, 0));
        subtitleText.setVisibility(GONE);
        FrameLayout.LayoutParams ccParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
        );
        ccParams.bottomMargin = dp(16); // ~1rem
        ccParams.leftMargin = dp(24);
        ccParams.rightMargin = dp(24);
        addView(subtitleText, ccParams);

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
            if (engine.isPlaybackDesired()) engine.pause();
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

        // No fullscreen icon on the native chrome — the app bar / FS
        // controls WebView already have one. A second ⛶ here is the
        // "duplicate top fullscreen icon" the user sees on the surface.
        btnFullscreen = null;

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
        // btnFullscreen is intentionally null (no native fullscreen icon —
        // the app bar / FS controls WebView own that). DO NOT addView it:
        // adding a null child throws "Cannot add a null child view to a
        // ViewGroup" and crashed every native playback before it started.
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
        boolean playing = engine.isPlaybackDesired();
        btnPlayPause.setImageResource(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play);
        btnPlayPause.setContentDescription(playing ? "Pause" : "Play");

        // Closed captions: show the active cue at the TOP of the video.
        String cue = engine.getActiveSubtitleCue(pos);
        if (cue != null && !cue.isEmpty()) {
            subtitleText.setText(cue);
            if (subtitleText.getVisibility() != VISIBLE) subtitleText.setVisibility(VISIBLE);
        } else if (subtitleText.getVisibility() != GONE) {
            subtitleText.setVisibility(GONE);
        }
    }

    // ── External hooks (from the plugin) ─────────────────────────────────

    public void setInteractive(boolean interactive) {
        this.interactive = interactive;
        // Requirement: NO native chrome when the app's own control bar drives
        // playback. Controls bar fully hidden, never toggled back by taps.
        controlsBar.setVisibility(interactive ? (controlsVisible ? VISIBLE : GONE) : GONE);
    }

    public boolean isInteractive() { return interactive; }

    public interface TapListener { void onTap(float fx, float fy); }
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
        // The SAME ⛶ icon toggles both ways: maximize ⇄ minimize.
        if (btnFullscreen != null) {
            btnFullscreen.setText(fullscreen ? "⤡" : "⛶");
            btnFullscreen.setContentDescription(fullscreen ? "Minimize" : "Fullscreen");
        }
        // ALWAYS hide the native chrome bar — the app's in-app controls
        // overlay (React) is the one true control surface in fullscreen too.
        // Showing the native bar here was the "native controls in fullscreen"
        // bug. The web layer renders its own fullscreen overlay on top.
        controlsBar.setVisibility(GONE);
        setControlsVisible(false);
    }

    /** Hide/show the whole native surface (panels must render above it). */
    public void setVisible(boolean visible) {
        setVisibility(visible ? VISIBLE : GONE);
    }

    /**
     * Dim layer for the <=100% brightness path. alpha = 1 - b is an exact
     * multiply (out = video * b) — REAL brightness. Pure UI, never touches
     * the engine. Brightening (>100%) is handled by the engine itself
     * (Exo live Brightness effect / VLC adjust via JNI).
     */
    /**
     * Visual-only brightness 0..2 (0%..200%). Never touches Exo/VLC.
     *   0–1: black multiply (alpha = 1-b)
     *   1–2: white SCREEN layer (alpha scales with extra)
     */
    public void setBrightnessDim(float brightness) {
        // <=100% only: an exact multiply dim (out = video * b). >100% is the
        // engine's real Brightness effect — never a white wash.
        float b = Math.max(0f, Math.min(1f, brightness));
        if (dimView != null) dimView.setAlpha(b < 1f ? (1f - b) : 0f);
    }

    /** Build the centered brightness popup (scrim + panel + slider). */
    private void buildBrightnessPopup(Context context) {
        int dp = (int) (context.getResources().getDisplayMetrics().density + 0.5f);

        // Scrim behind the panel — tap to close. LIGHT (10%) so the
        // brightness change is visible on the video while the popup is open.
        brightnessScrim = new View(context);
        brightnessScrim.setBackgroundColor(0x1A000000);
        brightnessScrim.setVisibility(GONE);
        brightnessScrim.setOnClickListener(v -> hideBrightnessPopup());
        addView(brightnessScrim, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        brightnessPopup = new LinearLayout(context);
        brightnessPopup.setOrientation(LinearLayout.VERTICAL);
        brightnessPopup.setPadding(18 * dp, 16 * dp, 18 * dp, 14 * dp);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(0xFF18191D);
        bg.setCornerRadius(16 * dp);
        bg.setStroke(dp, 0x29FFFFFF);
        brightnessPopup.setBackground(bg);
        brightnessPopup.setVisibility(GONE);

        // Title row (title + close X on the right)
        LinearLayout titleRow = new LinearLayout(context);
        titleRow.setOrientation(LinearLayout.HORIZONTAL);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        titleRow.setPadding(0, 0, 0, 10 * dp);

        TextView title = new TextView(context);
        title.setText("Brightness");
        title.setTextColor(Color.WHITE);
        title.setTextSize(13f);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        titleRow.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView closeBtn = new TextView(context);
        closeBtn.setText("✕");
        closeBtn.setTextColor(0xFFA6A6B0);
        closeBtn.setTextSize(14f);
        closeBtn.setGravity(Gravity.CENTER);
        closeBtn.setPadding(8 * dp, 0, 0, 0);
        closeBtn.setOnClickListener(v -> hideBrightnessPopup());
        titleRow.addView(closeBtn, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        brightnessPopup.addView(titleRow, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        // Slider row: seekbar + live % value
        LinearLayout sliderRow = new LinearLayout(context);
        sliderRow.setOrientation(LinearLayout.HORIZONTAL);
        sliderRow.setGravity(Gravity.CENTER_VERTICAL);

        brightnessSeek = new SeekBar(context);
        brightnessSeek.setMax(200); // 0..200
        brightnessSeek.setProgress(100);
        brightnessValue = new TextView(context);
        brightnessValue.setText("100%");
        brightnessValue.setTextColor(0xFFF5F5F7);
        brightnessValue.setTextSize(12f);
        brightnessValue.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        brightnessValue.setPadding(10 * dp, 0, 0, 0);
        brightnessValue.setMinWidth(46 * dp);
        brightnessValue.setGravity(Gravity.CENTER_VERTICAL);

        sliderRow.addView(brightnessSeek, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        sliderRow.addView(brightnessValue);
        brightnessPopup.addView(sliderRow, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        // Hint
        TextView hint = new TextView(context);
        hint.setText("0% – 200%");
        hint.setTextColor(0xFFA6A6B0);
        hint.setTextSize(10.5f);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 8 * dp, 0, 0);
        brightnessPopup.addView(hint, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        brightnessSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (!fromUser) return;
                // 0..200 → 0%..200%. The old (50+progress)/100 mapping made a
                // centered slider jump to 150% and clamped the top half of the
                // track — the slider position must equal the value.
                float b = Math.max(0f, Math.min(2f, progress / 100f));
                lastBrightness = b;
                if (brightnessValue != null) brightnessValue.setText(Math.round(b * 100f) + "%");
                if (brightnessPopupListener != null) brightnessPopupListener.onBrightnessChanged(b);
            }
            @Override public void onStartTrackingTouch(SeekBar sb) { }
            @Override public void onStopTrackingTouch(SeekBar sb) { }
        });

        FrameLayout.LayoutParams popupLp = new FrameLayout.LayoutParams(
                (int) (290 * dp),
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        );
        addView(brightnessPopup, popupLp);
    }

    /** Show/hide the brightness popup (video keeps playing — it's just an overlay). */
    public void showBrightnessPopup(boolean visible, float brightness) {
        if (visible) {
            lastBrightness = Math.max(0f, Math.min(2f, brightness));
            if (brightnessSeek != null) brightnessSeek.setProgress(Math.round(lastBrightness * 100f));
            if (brightnessValue != null) brightnessValue.setText(Math.round(lastBrightness * 100f) + "%");
            // Reparent onto the window so the panel is not clipped to the
            // (often short) video rect — that was "tap does nothing".
            attachPopupToWindow(brightnessScrim, brightnessPopup);
        } else {
            detachPopupFromWindow(brightnessScrim, brightnessPopup);
        }
        if (brightnessScrim != null) brightnessScrim.setVisibility(visible ? VISIBLE : GONE);
        if (brightnessPopup != null) brightnessPopup.setVisibility(visible ? VISIBLE : GONE);
        if (visible) {
            if (brightnessScrim != null) brightnessScrim.bringToFront();
            if (brightnessPopup != null) brightnessPopup.bringToFront();
        }
        if (!visible && brightnessPopupListener != null) brightnessPopupListener.onBrightnessPopupClosed();
    }

    private void attachPopupToWindow(View scrim, View popup) {
        View root = getRootView();
        if (!(root instanceof ViewGroup) || scrim == null || popup == null) return;
        ViewGroup decor = (ViewGroup) root;
        reparent(scrim, decor, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
        FrameLayout.LayoutParams popupLp = new FrameLayout.LayoutParams(
                dp(290),
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        );
        reparent(popup, decor, popupLp);
        scrim.setElevation(40f);
        popup.setElevation(41f);
    }

    private void detachPopupFromWindow(View scrim, View popup) {
        if (scrim == null || popup == null) return;
        reparent(scrim, this, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));
        reparent(popup, this, new FrameLayout.LayoutParams(
                dp(290),
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        ));
    }

    private void reparent(View child, ViewGroup newParent, ViewGroup.LayoutParams lp) {
        if (child == null || newParent == null) return;
        ViewGroup old = child.getParent() instanceof ViewGroup ? (ViewGroup) child.getParent() : null;
        if (old == newParent) {
            child.setLayoutParams(lp);
            return;
        }
        if (old != null) old.removeView(child);
        newParent.addView(child, lp);
    }

    /** Hide the popup programmatically (used by the scrim tap). */
    private void hideBrightnessPopup() {
        showBrightnessPopup(false, lastBrightness);
    }

    public void setBrightnessPopupListener(BrightnessPopupListener listener) {
        brightnessPopupListener = listener;
    }

    /** Build the centered volume popover (scrim + panel + mute + slider + %). */
    private void buildVolumePopup(Context context) {
        int dp = (int) (context.getResources().getDisplayMetrics().density + 0.5f);

        volumeScrim = new View(context);
        volumeScrim.setBackgroundColor(0x1A000000);
        volumeScrim.setVisibility(GONE);
        volumeScrim.setOnClickListener(v -> hideVolumePopup());
        addView(volumeScrim, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        ));

        volumePopup = new LinearLayout(context);
        volumePopup.setOrientation(LinearLayout.VERTICAL);
        volumePopup.setPadding(18 * dp, 16 * dp, 18 * dp, 14 * dp);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setColor(0xFF18191D);
        bg.setCornerRadius(16 * dp);
        bg.setStroke(dp, 0x29FFFFFF);
        volumePopup.setBackground(bg);
        volumePopup.setVisibility(GONE);

        // Title row (title on the left)
        LinearLayout titleRow = new LinearLayout(context);
        titleRow.setOrientation(LinearLayout.HORIZONTAL);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        titleRow.setPadding(0, 0, 0, 10 * dp);

        TextView title = new TextView(context);
        title.setText("Volume");
        title.setTextColor(Color.WHITE);
        title.setTextSize(13f);
        title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        titleRow.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        volumePopup.addView(titleRow, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        // Slider row: mute toggle + slider + live % value
        LinearLayout sliderRow = new LinearLayout(context);
        sliderRow.setOrientation(LinearLayout.HORIZONTAL);
        sliderRow.setGravity(Gravity.CENTER_VERTICAL);

        volumeMuteBtn = new TextView(context);
        volumeMuteBtn.setText("Mute");
        volumeMuteBtn.setTextColor(0xFFF5F5F7);
        volumeMuteBtn.setTextSize(12f);
        volumeMuteBtn.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        volumeMuteBtn.setGravity(Gravity.CENTER);
        volumeMuteBtn.setPadding(10 * dp, 6 * dp, 10 * dp, 6 * dp);
        volumeMuteBtn.setBackgroundColor(0x22FFFFFF);
        volumeMuteBtn.setOnClickListener(v -> {
            lastMuted = !lastMuted;
            float show = lastMuted ? 0f : Math.max(0f, lastVolume);
            if (volumeMuteBtn != null) volumeMuteBtn.setText(lastMuted ? "Unmute" : "Mute");
            if (volumeSeek != null) volumeSeek.setProgress(Math.round(show * 100f));
            if (volumeValue != null) volumeValue.setText(Math.round(show * 100f) + "%");
            if (volumePopupListener != null) volumePopupListener.onVolumeChanged(show, lastMuted);
        });

        volumeSeek = new SeekBar(context);
        volumeSeek.setMax(100);
        volumeSeek.setProgress(100);
        volumeValue = new TextView(context);
        volumeValue.setText("100%");
        volumeValue.setTextColor(0xFFF5F5F7);
        volumeValue.setTextSize(12f);
        volumeValue.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        volumeValue.setPadding(10 * dp, 0, 0, 0);
        volumeValue.setMinWidth(46 * dp);
        volumeValue.setGravity(Gravity.CENTER_VERTICAL);

        sliderRow.addView(volumeMuteBtn, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        sliderRow.addView(volumeSeek, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        sliderRow.addView(volumeValue);
        volumePopup.addView(sliderRow, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        // Hint
        TextView hint = new TextView(context);
        hint.setText("0% – 100%");
        hint.setTextColor(0xFFA6A6B0);
        hint.setTextSize(10.5f);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, 8 * dp, 0, 0);
        volumePopup.addView(hint, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        volumeSeek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (!fromUser) return;
                float v = Math.max(0f, Math.min(1f, progress / 100f));
                if (v > 0f) lastVolume = v;
                boolean muted = v <= 0f;
                lastMuted = muted;
                if (volumeMuteBtn != null) volumeMuteBtn.setText(muted ? "Unmute" : "Mute");
                if (volumeValue != null) volumeValue.setText(Math.round(v * 100f) + "%");
                if (volumePopupListener != null) volumePopupListener.onVolumeChanged(v, muted);
            }
            @Override public void onStartTrackingTouch(SeekBar sb) { }
            @Override public void onStopTrackingTouch(SeekBar sb) { }
        });

        FrameLayout.LayoutParams popupLp = new FrameLayout.LayoutParams(
                (int) (290 * dp),
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        );
        addView(volumePopup, popupLp);
    }

    /** Show/hide the volume popover (video keeps playing — it's just an overlay). */
    public void showVolumePopup(boolean visible, float volume, boolean muted) {
        lastVolume = Math.max(0f, Math.min(1f, volume));
        lastMuted = muted;
        float show = muted ? 0f : lastVolume;
        if (volumeSeek != null) volumeSeek.setProgress(Math.round(show * 100f));
        if (volumeValue != null) volumeValue.setText(Math.round(show * 100f) + "%");
        if (volumeMuteBtn != null) volumeMuteBtn.setText(muted ? "Unmute" : "Mute");
        if (visible) {
            attachPopupToWindow(volumeScrim, volumePopup);
        } else {
            detachPopupFromWindow(volumeScrim, volumePopup);
        }
        if (volumeScrim != null) volumeScrim.setVisibility(visible ? VISIBLE : GONE);
        if (volumePopup != null) volumePopup.setVisibility(visible ? VISIBLE : GONE);
        if (visible) {
            if (volumeScrim != null) volumeScrim.bringToFront();
            if (volumePopup != null) volumePopup.bringToFront();
        }
        if (!visible && volumePopupListener != null) volumePopupListener.onVolumePopupClosed();
    }

    /** Hide the volume popover programmatically (used by the scrim tap). */
    private void hideVolumePopup() {
        showVolumePopup(false, lastVolume, lastMuted);
    }

    public void setVolumePopupListener(VolumePopupListener listener) {
        volumePopupListener = listener;
    }

    // ── Teardown ─────────────────────────────────────────────────────────

    public void teardown() {
        handler.removeCallbacksAndMessages(null);
        try { detachPopupFromWindow(brightnessScrim, brightnessPopup); } catch (Exception ignored) { }
        try { detachPopupFromWindow(volumeScrim, volumePopup); } catch (Exception ignored) { }
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

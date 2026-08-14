package com.chan.watchparty;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.res.Configuration;
import android.os.Handler;
import android.os.Looper;
import androidx.core.graphics.drawable.IconCompat;
import android.util.Log;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * VideoPlayerPlugin — the ONE embedded native player (Phases 2–4).
 *
 * Instead of launching a fullscreen activity, the plugin hosts a
 * RoomPlayerOverlayView inside the activity's decor, positioned over the
 * room's stage rect (measured by the JS layer). The rest of the room UI
 * (chat, queue, controls) stays visible around it.
 *
 * API:
 *   showEmbedded({url,title,startSeconds,referer})
 *   setRect({x,y,w,h})            // px on screen
 *   play() / pause() / seekTo({positionMs}) / setVolume({volume})
 *   getPosition() → {positionMs,durationMs,isPlaying}
 *   setFullscreen({fullscreen})
 *   closeEmbedded() → {positionMs,durationMs,ended,wasPlaying}
 *
 * Events (notifyListeners 'playbackState'):
 *   {state:'ready'} {state:'buffering',percent} {state:'playing'}
 *   {state:'paused'} {state:'ended'} {state:'error',message}
 *   {state:'engine',engine:'vlc'}
 */
@CapacitorPlugin(name = "VideoPlayerPlugin")
public class VideoPlayerPlugin extends Plugin {
    private static final String TAG = "VideoPlayer";
    private static final String ACTION_TOGGLE_PLAY = "com.chan.watchparty.TOGGLE_PLAY";

    /**
     * Capacitor invokes @PluginMethod calls on its "CapacitorPlugins" worker
     * thread. Both native players are created by showEmbedded() on Android's
     * main thread, so every player access and every View mutation must be
     * marshalled back to that same thread. Fullscreen already did this; the
     * embedded controls did not, which made commands silently no-op and made
     * getPosition() report zero when ExoPlayer rejected wrong-thread access.
     */
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private void runOnMainThread(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
        } else {
            mainHandler.post(action);
        }
    }

    // Incrementing generation cancels stale retries from the previous
    // orientation/fullscreen layout without removing unrelated main-thread
    // callbacks (position updates, popovers, teardown, etc.).
    private int surfaceRefreshGeneration = 0;
    private static final int SURFACE_REFRESH_MAX_ATTEMPTS = 12;

    /**
     * Wait until the overlay reports stable dimensions for the requested
     * orientation, then resize the engine output. onConfigurationChanged is
     * delivered before Android finishes the decor/layout transition, so a
     * single fixed delay can still capture the old dimensions on slower ROMs.
     */
    private void scheduleSurfaceRefresh(boolean expectFullscreen, int expectedOrientation) {
        runOnMainThread(() -> {
            final int generation = ++surfaceRefreshGeneration;
            if (overlay == null || engine == null || overlay.getParent() == null) return;
            if (expectFullscreen) {
                try { hideSystemUi(); } catch (Throwable ignored) { }
            }
            overlay.requestLayout();
            overlay.invalidate();
            if (fsControlsView != null && expectFullscreen) {
                fsControlsView.requestLayout();
                fsControlsView.invalidate();
            }
            mainHandler.post(() -> refreshSurfaceWhenReady(
                    generation, expectFullscreen, expectedOrientation, 0, -1, -1));
        });
    }

    private void refreshSurfaceWhenReady(int generation, boolean expectFullscreen,
                                         int expectedOrientation, int attempt,
                                         int previousWidth, int previousHeight) {
        if (generation != surfaceRefreshGeneration || fullscreen != expectFullscreen
                || overlay == null || engine == null || overlay.getParent() == null) return;

        final int width = overlay.getWidth();
        final int height = overlay.getHeight();
        final boolean hasSize = width > 1 && height > 1;
        final boolean orientationReady = expectedOrientation == Configuration.ORIENTATION_UNDEFINED
                || (expectedOrientation == Configuration.ORIENTATION_LANDSCAPE && width > height)
                || (expectedOrientation == Configuration.ORIENTATION_PORTRAIT && height >= width);
        final boolean stable = width == previousWidth && height == previousHeight;

        boolean targetSizeReady = hasSize;
        if (hasSize && expectFullscreen) {
            View decor = getActivity().getWindow().getDecorView();
            int decorWidth = decor.getWidth();
            int decorHeight = decor.getHeight();
            targetSizeReady = decorWidth > 1 && decorHeight > 1
                    && Math.abs(width - decorWidth) <= 2
                    && Math.abs(height - decorHeight) <= 2;
        } else if (hasSize && !expectFullscreen && lastRect != null) {
            targetSizeReady = Math.abs(width - lastRect.width) <= 2
                    && Math.abs(height - lastRect.height) <= 2;
        }

        if (hasSize && orientationReady && targetSizeReady && stable) {
            completeSurfaceRefresh(expectFullscreen, width, height);
            return;
        }

        if (attempt >= SURFACE_REFRESH_MAX_ATTEMPTS) {
            // Last-resort resize is still non-destructive. This handles vendor
            // window managers whose decor differs by a persistent one-off
            // inset while avoiding the old detach/rebind black-screen path.
            if (hasSize) completeSurfaceRefresh(expectFullscreen, width, height);
            return;
        }

        long delayMs = Math.min(180L, 60L + (attempt * 20L));
        mainHandler.postDelayed(() -> refreshSurfaceWhenReady(
                generation, expectFullscreen, expectedOrientation, attempt + 1,
                width, height), delayMs);
    }

    private void completeSurfaceRefresh(boolean expectFullscreen, int width, int height) {
        if (overlay == null || engine == null || fullscreen != expectFullscreen) return;
        try {
            overlay.setVisible(true);
            if (engine.isExoActive()) overlay.showExo();
            else overlay.showVlc();
            overlay.requestLayout();
            overlay.invalidate();
            if (fsControlsView != null && expectFullscreen) {
                fsControlsView.requestLayout();
                fsControlsView.invalidate();
            }
            if (expectFullscreen) hideSystemUi();
            engine.refreshSurface(width, height);
        } catch (Throwable t) {
            Log.w(TAG, "Could not refresh rotated video surface", t);
        }
    }

    private RoomPlayerOverlayView overlay;
    private ChanPlayerEngine engine;
    private FrameLayout.LayoutParams lastRect;   // px
    private boolean fullscreen = false;
    private int orientationBeforeFullscreen = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private boolean ownsFullscreenOrientation = false;
    private boolean attached = false;
    private boolean wasPlayingBeforePip = false;
    private boolean chromeEnabled = true; // from showEmbedded controls flag

    // ── Fullscreen controls (in-app styled, layered ABOVE the native surface) ──
    // The native surface sits above the WebView, so React controls can't be
    // seen in fullscreen. A transparent WebView loads the bundled
    // fullscreen-controls page (same design tokens) and drives the engine via
    // the ChanNative JS bridge; state is pushed back every 500ms.
    private android.webkit.WebView fsControlsView;
    private boolean fsControlsLoaded = false;
    private final android.os.Handler fsPushHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private String lastTitle = "Chan Video";
    private String lastVtt = "";
    private boolean lastIsLive = false;
    private boolean lastBuffering = false;
    private int lastBufferingPercent = 0;

    private final Runnable fsPushRunnable = new Runnable() {
        @Override
        public void run() {
            if (!fullscreen || fsControlsView == null || !fsControlsLoaded || engine == null) return;
            try {
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("playing", engine.isPlaybackDesired());
                o.put("actuallyPlaying", engine.isPlaying());
                o.put("actualState", engine.getActualState());
                o.put("positionMs", engine.getPositionMs());
                o.put("durationMs", engine.getDurationMs());
                o.put("title", lastTitle == null ? "Chan Video" : lastTitle);
                o.put("live", lastIsLive);
                o.put("buffering", lastBuffering);
                o.put("bufferingPercent", lastBufferingPercent);
                final String js = "window.chanState && window.chanState(" + o.toString() + ");";
                fsControlsView.post(() -> {
                    try { fsControlsView.evaluateJavascript(js, null); } catch (Exception ignored) { }
                });
            } catch (Exception ignored) { }
            fsPushHandler.postDelayed(this, 500);
        }
    };

    private void keepFullscreenControlsTransparent() {
        if (fsControlsView == null) return;
        fsControlsView.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        fsControlsView.setBackgroundResource(android.R.color.transparent);
    }

    private void ensureFsControls() {
        if (fsControlsView != null) {
            keepFullscreenControlsTransparent();
            return;
        }
        fsControlsView = new android.webkit.WebView(getActivity());
        keepFullscreenControlsTransparent();
        fsControlsView.setVerticalScrollBarEnabled(false);
        fsControlsView.setHorizontalScrollBarEnabled(false);
        fsControlsView.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
        // Enable JS + file access + DOM storage so the controls page actually
        // runs its script and can load from the bundled asset.
        android.webkit.WebSettings s = fsControlsView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setAllowFileAccess(true);
        s.setDomStorageEnabled(true);
        fsControlsView.setWebViewClient(new android.webkit.WebViewClient() {
            @Override
            public void onPageFinished(android.webkit.WebView view, String url) {
                keepFullscreenControlsTransparent();
                fsControlsLoaded = true;
                if (fullscreen) {
                    view.setVisibility(android.view.View.VISIBLE);
                    fsPushHandler.removeCallbacks(fsPushRunnable);
                    fsPushHandler.post(fsPushRunnable);
                }
                // Pass the title once the page is ready.
                final String t = lastTitle == null ? "Chan Video" : lastTitle.replace("'", "\\'");
                view.post(() -> {
                    try { view.evaluateJavascript("window.chanTitle && window.chanTitle('" + t + "');", null); } catch (Exception ignored) { }
                });
            }

            @Override
            public void onReceivedError(android.webkit.WebView view, int errorCode, String description, String failingUrl) {
                // A failed load must NOT be treated as ready (no blank page).
                fsControlsLoaded = false;
                android.util.Log.w(TAG, "fullscreen controls load error: " + errorCode + " " + description + " " + failingUrl);
            }

            @Override
            public void onReceivedError(android.webkit.WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    fsControlsLoaded = false;
                    android.util.Log.w(TAG, "fullscreen controls main-frame error: " + error.getErrorCode());
                }
            }
        });
        fsControlsView.addJavascriptInterface(new FsBridge(), "ChanNative");
        // Attach to the window ABOVE the native video overlay. GONE until
        // fullscreen; harmless while hidden, and it guarantees the page is
        // rendered (a view with no parent can never show).
        ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView();
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        );
        decor.addView(fsControlsView, params);
        fsControlsView.setVisibility(android.view.View.GONE);
        try {
            fsControlsView.loadUrl("file:///android_asset/public/fullscreen-controls/index.html");
        } catch (Exception e) {
            android.util.Log.w(TAG, "fullscreen controls load failed", e);
            fsControlsLoaded = false;
        }
    }

    /** JS bridge for the fullscreen controls page. All commands → main thread. */
    private class FsBridge {
        @android.webkit.JavascriptInterface
        public void command(final String action, final double value) {
            getActivity().runOnUiThread(() -> {
                if (engine == null) return;
                try {
                    switch (action) {
                        case "toggle": if (engine.isPlaybackDesired()) engine.pause(); else engine.play(); break;
                        case "play": engine.play(); break;
                        case "pause": engine.pause(); break;
                        case "seek": engine.seekTo((long) value); break;
                        case "skip": engine.seekTo(engine.getPositionMs() + (long) value); break;
                        case "rate": engine.setPlaybackRate((float) value); break;
                        case "volume": engine.setVolume((float) value); break;
                        case "brightness": applyBrightness((float) value); break;
                        case "cc": engine.setSubtitles(value > 0.5 ? lastVtt : ""); break;
                        case "pip": enterPip(); break;
                        case "rotate": rotateOrientation(); break;
                        case "minimize": if (fullscreen) setFullscreenUi(false); break;
                        default: break;
                    }
                } catch (Exception ignored) { }
            });
        }
    }

    /**
     * Brightness 0..2 (50%..200%).
     *  - <= 1.0 (dim): pure overlay dim layer — never touches the engine, so
     *    playability is untouched on both ExoPlayer and libVLC.
     *  - >  1.0 (brighten): needs the engine's Brightness effect (Exo applies
     *    live; VLC uses the debounced re-prepare + resume). Only the >100%
     *    path touches the engine, and it's debounced so it can't hiccup.
     */
    /**
     * REAL brightness, 0.5..2 (50%..200%).
     *   <= 1.0 → black dim overlay (alpha = 1-b is an exact multiply:
     *            out = video * b) — pure UI, zero playback impact.
     *   >  1.0 → engine Brightness effect: Exo applies it live via
     *            setVideoEffects; VLC gets libvlc_video_set_adjust_float
     *            through the JNI bridge (real-time, no media re-prepare).
     * The white-wash overlay is gone — brightening is real, not a blend.
     */
    private float lastEngineBrightness = 1f;

    private void applyBrightness(float brightness) {
        try {
            float b = Math.max(0f, Math.min(2f, brightness));
            lastEngineBrightness = b;
            // REAL brightness: <=100% is a true multiply dim overlay; >100% is
            // the engine's actual Brightness effect (Exo effect / VLC adjust
            // filter). Never a fake white wash — the video pixels themselves
            // brighten/darken.
            // The engine call must NOT be nested inside the overlay null-check:
            // a null overlay would silently swallow every brightness change.
            if (overlay != null) overlay.setBrightnessDim(b <= 1f ? b : 1f);
            if (engine != null) engine.setVideoEffects(b <= 1f ? 1f : b, 1f, 1f, 0f);
        } catch (Throwable t) {
            Log.e(TAG, "applyBrightness failed", t);
        }
    }

    @PluginMethod
    public void setBrightnessDim(PluginCall call) {
        Double value = call.getDouble("brightness", 1.0);
        final float brightness = value == null ? 1f : value.floatValue();
        runOnMainThread(() -> {
            try {
                applyBrightness(brightness);
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "setBrightnessDim failed", t);
                call.reject("Could not change brightness: " + String.valueOf(t.getMessage()));
            }
        });
    }

    private boolean brightnessPopupWired = false;

    /** Show the native brightness popup OVER the video (video keeps playing). */
    @PluginMethod
    public void showBrightnessPopup(PluginCall call) {
        Boolean visible = call.getBoolean("visible", true);
        Double brightness = call.getDouble("brightness", 1.0);
        final boolean shouldShow = visible == null || visible;
        final float currentBrightness = brightness == null ? 1f : brightness.floatValue();
        runOnMainThread(() -> {
            try {
                ensureOverlay();
                // Listener and popup are both Android Views/native callbacks.
                // Wire and mutate them on the UI thread; doing this directly
                // on CapacitorPlugins was why tapping the button showed nothing.
                wireBrightnessPopupListener();
                overlay.showBrightnessPopup(shouldShow, currentBrightness);
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "showBrightnessPopup failed", t);
                call.reject("Brightness popup failed: " + String.valueOf(t.getMessage()));
            }
        });
    }

    private void wireBrightnessPopupListener() {
        if (brightnessPopupWired || overlay == null) return;
        brightnessPopupWired = true;
        overlay.setBrightnessPopupListener(new RoomPlayerOverlayView.BrightnessPopupListener() {
            @Override
            public void onBrightnessChanged(float brightness) {
                applyBrightness(brightness);
                notifyListeners("brightnessChanged", new JSObject().put("brightness", (double) brightness));
            }
            @Override
            public void onBrightnessPopupClosed() {
                notifyListeners("brightnessPopupClosed", new JSObject());
            }
        });
    }

    private boolean volumePopupWired = false;

    /** Show the native volume popover OVER the video (video keeps playing). */
    @PluginMethod
    public void showVolumePopup(PluginCall call) {
        Boolean visible = call.getBoolean("visible", true);
        Double volume = call.getDouble("volume", 1.0);
        Boolean muted = call.getBoolean("muted", false);
        final boolean shouldShow = visible == null || visible;
        final float currentVolume = volume == null ? 1f : volume.floatValue();
        final boolean isMuted = Boolean.TRUE.equals(muted);
        runOnMainThread(() -> {
            try {
                ensureOverlay();
                wireVolumePopupListener();
                overlay.showVolumePopup(shouldShow, currentVolume, isMuted);
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "showVolumePopup failed", t);
                call.reject("Volume popup failed: " + String.valueOf(t.getMessage()));
            }
        });
    }

    private void wireVolumePopupListener() {
        if (volumePopupWired || overlay == null) return;
        volumePopupWired = true;
        overlay.setVolumePopupListener(new RoomPlayerOverlayView.VolumePopupListener() {
            @Override
            public void onVolumeChanged(float volume, boolean muted) {
                // Drive the real engine volume immediately (no re-prepare).
                if (engine != null) engine.setVolume(muted ? 0f : volume);
                notifyListeners("volumeChanged", new JSObject()
                        .put("volume", (double) volume)
                        .put("muted", muted));
            }
            @Override
            public void onVolumePopupClosed() {
                notifyListeners("volumePopupClosed", new JSObject());
            }
        });
    }

    private void takeFullscreenOrientationOwnership() {
        if (!ownsFullscreenOrientation) {
            try {
                orientationBeforeFullscreen = getActivity().getRequestedOrientation();
            } catch (Throwable ignored) {
                orientationBeforeFullscreen = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
            }
            ownsFullscreenOrientation = true;
        }
        try {
            getActivity().setRequestedOrientation(
                    android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        } catch (Throwable t) {
            Log.w(TAG, "Could not request fullscreen landscape", t);
        }
    }

    private void restoreOrientationAfterFullscreen() {
        if (!ownsFullscreenOrientation) return;
        int restore = orientationBeforeFullscreen;
        // The app intentionally starts portrait-locked. If Android reported
        // UNSPECIFIED while bootstrapping, restore portrait rather than leaving
        // the room stranded in the last fullscreen orientation.
        if (restore == android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                || restore == android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR
                || restore == android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR) {
            restore = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        }
        try {
            getActivity().setRequestedOrientation(restore);
        } catch (Throwable t) {
            Log.w(TAG, "Could not restore app orientation", t);
        }
        ownsFullscreenOrientation = false;
        orientationBeforeFullscreen = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    }

    private void rotateOrientation() {
        try {
            int cur = getActivity().getResources().getConfiguration().orientation;
            getActivity().setRequestedOrientation(
                    cur == Configuration.ORIENTATION_LANDSCAPE
                            ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                            : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
        } catch (Throwable t) {
            Log.w(TAG, "Could not rotate fullscreen player", t);
        }
    }

    private BroadcastReceiver piPReceiver;

    // ── Lifecycle of the overlay ─────────────────────────────────────────

    private void ensureOverlay() {
        if (overlay != null) return;
        Activity activity = getActivity();
        overlay = new RoomPlayerOverlayView(activity);
        engine = new ChanPlayerEngine(activity, engineListener);
        overlay.setEngine(engine);
        overlay.setFullscreenListener(() -> setFullscreenUi(!fullscreen));
        overlay.setPipListener(this::enterPip);
    }

    private void attachOverlay() {
        if (attached || overlay == null) return;
        ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView();
        // Attach at 0x0, NOT MATCH_PARENT: the JS layer positions the surface
        // over the room's video box via setRect within a frame. A MATCH_PARENT
        // attach would flash a full-screen black layer over the whole app UI
        // (the overlay has an opaque black background) until the first rect.
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(0, 0);
        decor.addView(overlay, params);
        attached = true;
    }

    private void detachOverlay() {
        if (!attached || overlay == null) return;
        try {
            ((ViewGroup) getActivity().getWindow().getDecorView()).removeView(overlay);
        } catch (Exception ignored) { }
        attached = false;
    }

    // ── Engine → JS events ───────────────────────────────────────────────

    private final ChanPlayerEngine.Listener engineListener = new ChanPlayerEngine.Listener() {
        @Override
        public void onReady() {
            lastBuffering = false;
            if (overlay != null) overlay.hideStatus();
            emitPlaybackState("ready", null);
        }

        @Override
        public void onBuffering(int percent) {
            // Requirement: buffering UI reflects live native state, shown by the
            // app's own control bar — never native chrome. Clamp 1–99%.
            int clamped = Math.max(1, Math.min(99, percent));
            lastBuffering = true;
            lastBufferingPercent = clamped;
            emitPlaybackState("buffering", new JSObject().put("percent", clamped));
        }

        @Override
        public void onPlaying() {
            lastBuffering = false;
            if (overlay != null) overlay.hideStatus();
            emitPlaybackState("playing", null);
        }

        @Override
        public void onPaused() {
            lastBuffering = false;
            if (overlay != null) overlay.hideStatus(); // never 'buffering' while paused
            emitPlaybackState("paused", null);
        }

        @Override
        public void onEnded() {
            if (overlay != null) overlay.showStatus("Playback finished", false);
            emitPlaybackState("ended", null);
        }

        @Override
        public void onError(String friendlyMessage, String kind, String detail) {
            if (overlay != null) overlay.showStatus(friendlyMessage, true);
            emitPlaybackState("error", new JSObject()
                    .put("message", friendlyMessage)
                    .put("kind", kind == null ? "other" : kind)
                    .put("detail", detail == null ? "" : detail));
        }

        @Override
        public void onEngineSwitch(String engineName) {
            if (overlay != null) overlay.showVlc();
            emitPlaybackState("engine", new JSObject().put("engine", engineName));
        }
    };

    private void emitPlaybackState(String state, JSObject extra) {
        JSObject data = new JSObject().put("state", state);
        if (engine != null) {
            data.put("desiredPlaying", engine.isPlaybackDesired());
            data.put("actualState", engine.getActualState());
        }
        if (extra != null) {
            java.util.Iterator<String> keys = extra.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                // opt() avoids the checked JSONException from get()
                data.put(key, extra.opt(key));
            }
        }
        try {
            notifyListeners("playbackState", data);
        } catch (Exception e) {
            Log.w(TAG, "notifyListeners failed", e);
        }
    }

    // ── Plugin methods ───────────────────────────────────────────────────

    /** Exact identity of the installed APK, generated by Gradle/CI. */
    @PluginMethod
    public void getBuildInfo(PluginCall call) {
        JSObject result = new JSObject()
                .put("commit", BuildConfig.GIT_COMMIT_SHA)
                .put("version", BuildConfig.VERSION_NAME)
                .put("builtAt", BuildConfig.BUILD_TIMESTAMP_UTC);
        call.resolve(result);
    }

    @PluginMethod
    public void showEmbedded(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("URL is required");
            return;
        }
        // Never attach a surface to a dying Activity — change-video can land
        // here right as the app backgrounds/exits. Reject cleanly instead of
        // letting ensureOverlay()/attachOverlay() NPE the process.
        final Activity activity = getActivity();
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            call.reject("Activity is not ready");
            return;
        }
        String title = call.getString("title", "Chan Video");
        Double startSeconds = call.getDouble("startSeconds");
        String referer = call.getString("referer", "");
        String container = call.getString("container", "");
        String codec = call.getString("codec", "");
        Boolean controls = call.getBoolean("controls", true);
        Boolean isLive = call.getBoolean("isLive", false);
        lastTitle = title;
        lastIsLive = Boolean.TRUE.equals(isLive);
        // Extra headers from the descriptor (merged over UA/Referer in the engine)
        java.util.Map<String, String> headers = new java.util.HashMap<>();
        JSObject h = call.getObject("headers");
        if (h != null) {
            java.util.Iterator<String> it = h.keys();
            while (it.hasNext()) {
                String key = it.next();
                Object v = h.opt(key);
                if (v != null) headers.put(key, String.valueOf(v));
            }
        }

        try {
            getActivity().runOnUiThread(() -> {
                try {
                    ensureOverlay();
                    // Requirement: native chrome hidden — the app's own control
                    // bar drives playback. Taps on the video surface notify JS
                    // (controlsEvent) so the web bar can toggle instead.
                    overlay.setTapListener((fx, fy) -> {
                        JSObject tap = new JSObject()
                                .put("type", "tap")
                                .put("x", (double) fx)
                                .put("y", (double) fy);
                        try { notifyListeners("controlsEvent", tap); } catch (Exception ignored) { }
                    });
                    chromeEnabled = controls == null || controls;
                    overlay.setInteractive(chromeEnabled);
                    overlay.showStatus("Fetching media…", false);
                    attachOverlay();
                    overlay.showExo();
                    engine.prepare(url, title, referer,
                            (long) Math.max(0, startSeconds == null ? 0 : startSeconds * 1000),
                            headers, container, codec);
                    call.resolve();
                } catch (Exception e) {
                    Log.e(TAG, "showEmbedded failed", e);
                    call.reject("Could not start the player: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "showEmbedded dispatch failed", e);
            call.reject("Could not start the player: " + e.getMessage());
        }
    }

    /** Update the native overlay status text (used during JS-driven recovery). */
    @PluginMethod
    public void showStatus(PluginCall call) {
        String text = call.getString("text", "");
        runOnMainThread(() -> {
            try {
                if (overlay != null && !text.isEmpty()) overlay.showStatus(text, false);
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "showStatus failed", t);
                call.reject("Could not update player status: " + String.valueOf(t.getMessage()));
            }
        });
    }

    /** Quick range probe of a media URL — lets JS classify failures precisely. */
    @PluginMethod
    public void probeStatus(PluginCall call) {
        String url = call.getString("url");
        String referer = call.getString("referer", "");
        JSObject result = new JSObject().put("ok", false);
        if (url == null || url.trim().isEmpty()) {
            call.resolve(result);
            return;
        }
        new Thread(() -> {
            java.net.HttpURLConnection conn = null;
            try {
                java.net.URL u = new java.net.URL(url);
                conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36");
                if (referer != null && !referer.isEmpty()) conn.setRequestProperty("Referer", referer);
                conn.setRequestProperty("Range", "bytes=0-1");
                conn.setInstanceFollowRedirects(true);
                int status = conn.getResponseCode();
                String ct = conn.getContentType();
                result.put("status", status);
                result.put("contentType", ct == null ? "" : ct);
                result.put("ok", (status == 200 || status == 206) && ct != null
                        && !ct.toLowerCase().contains("text/html")
                        && !ct.toLowerCase().contains("application/json"));
                result.put("ranged", status == 206);
                try { conn.getInputStream().close(); } catch (Exception ignored) { }
            } catch (Exception e) {
                result.put("error", String.valueOf(e.getMessage()));
            } finally {
                if (conn != null) conn.disconnect();
                getActivity().runOnUiThread(() -> call.resolve(result));
            }
        }).start();
    }

    @PluginMethod
    public void setRect(PluginCall call) {
        final int x = call.getInt("x", 0);
        final int y = call.getInt("y", 0);
        final int w = call.getInt("w", 0);
        final int h = call.getInt("h", 0);
        runOnMainThread(() -> {
            try {
                if (overlay == null || fullscreen) {
                    call.resolve();
                    return;
                }
                // Invalid / off-screen rect (video box collapsed or scrolled out):
                // HIDE the overlay instead of leaving it at its previous size —
                // a stale rect (or the 0x0 attach) must never cover app UI.
                if (w <= 0 || h <= 0) {
                    overlay.setVisible(false);
                    call.resolve();
                    return;
                }
                lastRect = new FrameLayout.LayoutParams(w, h);
                lastRect.leftMargin = x;
                lastRect.topMargin = y;
                ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView();
                if (attached && overlay.getParent() == decor) {
                    overlay.setLayoutParams(lastRect);
                    overlay.setVisible(true);
                }
                call.resolve();
            } catch (Throwable t) {
                // Rect updates are best-effort; a transient layout race must
                // never interrupt playback or reject the animation-frame loop.
                Log.w(TAG, "setRect ignored a transient layout failure", t);
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void play(PluginCall call) {
        runOnMainThread(() -> {
            try {
                if (engine != null) engine.play();
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "play failed", t);
                call.reject("Could not play video: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        runOnMainThread(() -> {
            try {
                if (engine != null) engine.pause();
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "pause failed", t);
                call.reject("Could not pause video: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        Integer positionMs = call.getInt("positionMs");
        runOnMainThread(() -> {
            try {
                if (positionMs != null && engine != null) engine.seekTo(positionMs);
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "seekTo failed", t);
                call.reject("Could not seek video: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume", 1.0);
        final float requestedVolume = volume == null ? 1.0f : volume.floatValue();
        runOnMainThread(() -> {
            try {
                if (engine != null) engine.setVolume(requestedVolume);
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "setVolume failed", t);
                call.reject("Could not change volume: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void getPosition(PluginCall call) {
        // ExoPlayer state getters have the same thread requirement as commands.
        // Build one coherent snapshot on the player thread, then resolve it.
        runOnMainThread(() -> {
            JSObject result = new JSObject();
            try {
                if (engine != null) {
                    result.put("positionMs", engine.getPositionMs());
                    result.put("durationMs", engine.getDurationMs());
                    // Stable user/room intent drives the control icon. Actual
                    // rendering may temporarily stop for buffering/rotation.
                    result.put("isPlaying", engine.isPlaybackDesired());
                    result.put("isActuallyPlaying", engine.isPlaying());
                    result.put("actualState", engine.getActualState());
                    result.put("ended", engine.isEnded());
                    result.put("ready", true);
                    result.put("engine", engine.isExoActive() ? "exo" : "vlc");
                } else {
                    result.put("positionMs", 0);
                    result.put("durationMs", 0);
                    result.put("isPlaying", false);
                    result.put("isActuallyPlaying", false);
                    result.put("actualState", "paused");
                    result.put("ended", false);
                    result.put("ready", false);
                    result.put("engine", "none");
                }
                call.resolve(result);
            } catch (Throwable t) {
                Log.e(TAG, "getPosition failed", t);
                call.reject("Could not read player state: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void setFullscreen(PluginCall call) {
        Boolean value = call.getBoolean("fullscreen", false);
        runOnMainThread(() -> {
            try {
                setFullscreenUi(Boolean.TRUE.equals(value));
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "setFullscreen failed", t);
                call.reject("Could not change fullscreen mode: " + String.valueOf(t.getMessage()));
            }
        });
    }

    private void setFullscreenUi(boolean value) {
        if (overlay == null || overlay.getParent() == null) return;
        final boolean wasFullscreen = fullscreen;
        fullscreen = value;
        getActivity().runOnUiThread(() -> {
            ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView();
            if (fullscreen) {
                if (!wasFullscreen) takeFullscreenOrientationOwnership();
                FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                );
                overlay.setLayoutParams(params);
                // NO native chrome in fullscreen — the app's in-app controls
                // (the layered fullscreen-controls WebView) drive everything.
                overlay.setInteractive(false);
                overlay.setVisible(true);
                try { overlay.showBrightnessPopup(false, lastEngineBrightness); } catch (Exception ignored) { }
                hideSystemUi();
                // Show the in-app styled controls above the surface.
                ensureFsControls();
                if (fsControlsLoaded) {
                    fsControlsView.setVisibility(View.VISIBLE);
                    fsPushHandler.removeCallbacks(fsPushRunnable);
                    fsPushHandler.post(fsPushRunnable);
                    final int pct = Math.round(lastEngineBrightness * 100f);
                    fsControlsView.post(() -> {
                        try {
                            fsControlsView.evaluateJavascript(
                                    "window.chanBrightness && window.chanBrightness(" + pct + ");", null);
                        } catch (Exception ignored) { }
                    });
                }
            } else {
                // Restore the embedded stage rect (re-anchors the surface back
                // into the room bounds, NOT just a boolean flip), restore the
                // chrome preference, restore system UI, and return the app to
                // PORTRAIT (the rotate button may have left the activity
                // landscape — leaving fullscreen must not leave the whole app
                // rotated).
                if (lastRect != null) {
                    overlay.setLayoutParams(lastRect);
                    overlay.setVisible(true);
                }
                overlay.setInteractive(chromeEnabled);
                showSystemUi();
                if (wasFullscreen) restoreOrientationAfterFullscreen();
                // Hide the fullscreen controls layer.
                fsPushHandler.removeCallbacks(fsPushRunnable);
                if (fsControlsView != null) fsControlsView.setVisibility(View.GONE);
            }
            overlay.setFullscreenUi(fullscreen);
            // Do not detach either player surface here. Wait for MATCH_PARENT
            // (or lastRect) to settle, then perform a non-destructive resize.
            scheduleSurfaceRefresh(
                    fullscreen,
                    getActivity().getResources().getConfiguration().orientation);
            // Keep JS in sync both directions
            JSObject evt = new JSObject().put("type", "fullscreenchange").put("fullscreen", fullscreen);
            try { notifyListeners("controlsEvent", evt); } catch (Exception ignored) { }
        });
    }

    /** Called by MainActivity on back press — exit fullscreen first. */
    public boolean consumeBackIfFullscreen() {
        if (fullscreen) {
            setFullscreenUi(false);
            return true;
        }
        return false;
    }

    @PluginMethod
    public void setVideoEffects(PluginCall call) {
        Double brightness = call.getDouble("brightness", 1.0);
        Double contrast = call.getDouble("contrast", 1.0);
        Double saturation = call.getDouble("saturation", 1.0);
        Double hue = call.getDouble("hue", 0.0);
        runOnMainThread(() -> {
            try {
                if (engine != null) {
                    engine.setVideoEffects(
                            brightness == null ? 1f : brightness.floatValue(),
                            contrast == null ? 1f : contrast.floatValue(),
                            saturation == null ? 1f : saturation.floatValue(),
                            hue == null ? 0f : hue.floatValue());
                }
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "setVideoEffects failed", t);
                call.reject("Could not change video effects: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void setSubtitles(PluginCall call) {
        String vttText = call.getString("vttText", "");
        lastVtt = vttText == null ? "" : vttText;
        runOnMainThread(() -> {
            try {
                if (engine != null) engine.setSubtitles(vttText);
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "setSubtitles failed", t);
                call.reject("Could not update subtitles: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void getVideoTracks(PluginCall call) {
        runOnMainThread(() -> {
            JSObject result = new JSObject();
            try {
                if (engine != null) {
                    java.util.List<java.util.Map<String, Object>> tracks = engine.getVideoTracks();
                    org.json.JSONArray arr = new org.json.JSONArray();
                    for (java.util.Map<String, Object> t : tracks) {
                        JSObject o = new JSObject();
                        o.put("id", t.get("id") == null ? -1 : ((Number) t.get("id")).intValue());
                        o.put("height", t.get("height") == null ? 0 : ((Number) t.get("height")).intValue());
                        o.put("width", t.get("width") == null ? 0 : ((Number) t.get("width")).intValue());
                        o.put("bitrate", t.get("bitrate") == null ? 0 : ((Number) t.get("bitrate")).intValue());
                        o.put("description", String.valueOf(t.get("description") == null ? "" : t.get("description")));
                        arr.put(o);
                    }
                    result.put("tracks", arr);
                } else {
                    result.put("tracks", new org.json.JSONArray());
                }
                call.resolve(result);
            } catch (Throwable t) {
                Log.e(TAG, "getVideoTracks failed", t);
                call.reject("Could not read video tracks: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void setVideoQuality(PluginCall call) {
        Boolean auto = call.getBoolean("auto", true);
        Integer trackId = call.getInt("trackId", -1);
        Integer height = call.getInt("height", 0);
        runOnMainThread(() -> {
            try {
                if (engine != null) {
                    engine.setVideoQuality(auto == null || auto, trackId == null ? -1 : trackId, height == null ? 0 : height);
                }
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "setVideoQuality failed", t);
                call.reject("Could not change video quality: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        Boolean visible = call.getBoolean("visible", true);
        runOnMainThread(() -> {
            try {
                if (overlay != null) {
                    // Fullscreen visibility is a native invariant. The WebView
                    // continues measuring its inline placeholder during some
                    // transitions and may report it offscreen; that must not
                    // hide the MATCH_PARENT video while audio keeps playing.
                    overlay.setVisible(fullscreen || visible == null || visible);
                }
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "setVisible failed", t);
                call.reject("Could not change player visibility: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void enterPip(PluginCall call) {
        runOnMainThread(() -> {
            try {
                enterPip();
                call.resolve();
            } catch (Throwable t) {
                Log.e(TAG, "enterPip failed", t);
                call.reject("Could not enter picture in picture: " + String.valueOf(t.getMessage()));
            }
        });
    }

    @PluginMethod
    public void closeEmbedded(PluginCall call) {
        // Capture the final state, release both engines, and remove the native
        // overlay on the same thread that owns them. The old worker-thread
        // teardown could leave audio playing behind a stale black surface.
        runOnMainThread(() -> {
            JSObject result = new JSObject();
            try {
                if (engine != null) {
                    result.put("positionMs", engine.getPositionMs());
                    result.put("durationMs", engine.getDurationMs());
                    result.put("ended", engine.isEnded());
                    result.put("wasPlaying", engine.isPlaybackDesired());
                }
                teardown();
                call.resolve(result);
            } catch (Throwable t) {
                Log.e(TAG, "closeEmbedded failed", t);
                // Teardown is best-effort, but the caller must not hang during
                // route exit even if a vendor player release throws.
                try { teardown(); } catch (Throwable ignored) { }
                call.resolve(result);
            }
        });
    }

    private void teardown() {
        // Cancel pending orientation/layout retries for the surface being
        // removed. Generation-based cancellation leaves unrelated callbacks.
        surfaceRefreshGeneration += 1;
        try { fsPushHandler.removeCallbacks(fsPushRunnable); } catch (Exception ignored) { }
        if (fsControlsView != null) {
            try {
                ((ViewGroup) getActivity().getWindow().getDecorView()).removeView(fsControlsView);
            } catch (Exception ignored) { }
            try { fsControlsView.destroy(); } catch (Exception ignored) { }
            fsControlsView = null;
        }
        fsControlsLoaded = false;
        if (overlay != null) {
            try { overlay.teardown(); } catch (Throwable t) { Log.e(TAG, "overlay teardown failed", t); }
            try { detachOverlay(); } catch (Throwable t) { Log.e(TAG, "detachOverlay failed", t); }
            overlay = null;
        }
        if (engine != null) {
            try { engine.release(); } catch (Throwable t) { Log.e(TAG, "engine release failed", t); }
            engine = null;
        }
        brightnessPopupWired = false; // next showBrightnessPopup re-wires listeners
        volumePopupWired = false; // next showVolumePopup re-wires listeners
        if (fullscreen || ownsFullscreenOrientation) restoreOrientationAfterFullscreen();
        fullscreen = false;
        try { showSystemUi(); } catch (Exception ignored) { }
    }

    // ── PiP (Android 8+) ─────────────────────────────────────────────────

    private void enterPip() {
        if (android.os.Build.VERSION.SDK_INT < 26 || overlay == null) return;
        try {
            WebView webView = getBridge().getWebView();
            if (webView != null) webView.setVisibility(View.INVISIBLE);
            wasPlayingBeforePip = engine != null && engine.isPlaybackDesired();
            PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(16, 9))
                    .setActions(java.util.Collections.singletonList(buildTogglePlayRemoteAction()));
            if (android.os.Build.VERSION.SDK_INT >= 31) builder.setSeamlessResizeEnabled(true);
            getActivity().enterPictureInPictureMode(builder.build());
        } catch (Exception e) {
            Log.w(TAG, "Could not enter PiP", e);
            WebView webView = getBridge().getWebView();
            if (webView != null) webView.setVisibility(View.VISIBLE);
        }
    }

    private RemoteAction buildTogglePlayRemoteAction() {
        boolean playing = engine != null && engine.isPlaybackDesired();
        Intent intent = new Intent(ACTION_TOGGLE_PLAY);
        PendingIntent pi = PendingIntent.getBroadcast(
                getActivity(), 1, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        IconCompat icon = IconCompat.createWithResource(
                getActivity(),
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play
        );
        return new RemoteAction(icon.toIcon(), "Play/Pause", "Toggle playback", pi);
    }

    private void registerPiPReceiver() {
        if (android.os.Build.VERSION.SDK_INT < 26 || piPReceiver != null) return;
        piPReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_TOGGLE_PLAY.equals(intent.getAction()) && engine != null) {
                    getActivity().runOnUiThread(() -> {
                        if (engine.isPlaybackDesired()) engine.pause();
                        else engine.play();
                    });
                }
            }
        };
        try {
            IntentFilter filter = new IntentFilter(ACTION_TOGGLE_PLAY);
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                getActivity().registerReceiver(piPReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                getActivity().registerReceiver(piPReceiver, filter);
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not register PiP receiver", e);
        }
    }

    @Override
    public void handleOnResume() {
        super.handleOnResume();
        registerPiPReceiver();
    }

    @Override
    public void handleOnPause() {
        super.handleOnPause();
        // Never play audio in the background outside PiP
        if (overlay != null && engine != null && !isInPip()) {
            engine.pause();
        }
    }

    @Override
    public void handleOnDestroy() {
        super.handleOnDestroy();
        if (piPReceiver != null) {
            try { getActivity().unregisterReceiver(piPReceiver); } catch (Exception ignored) { }
            piPReceiver = null;
        }
        teardown();
    }

    @Override
    public void handleOnConfigurationChanged(Configuration newConfig) {
        super.handleOnConfigurationChanged(newConfig);
        runOnMainThread(() -> {
            if (overlay == null || engine == null || overlay.getParent() == null) return;

            // MainActivity handles orientation as a config change, so the same
            // overlay survives the rotation. Reassert MATCH_PARENT immediately,
            // but do not touch the decoder/surface until the decor reports the
            // new orientation dimensions.
            if (fullscreen) {
                overlay.setLayoutParams(new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT));
                overlay.setVisible(true);
                overlay.setInteractive(false);
                overlay.requestLayout();
                if (fsControlsView != null) {
                    keepFullscreenControlsTransparent();
                    fsControlsView.setLayoutParams(new FrameLayout.LayoutParams(
                            FrameLayout.LayoutParams.MATCH_PARENT,
                            FrameLayout.LayoutParams.MATCH_PARENT));
                    fsControlsView.requestLayout();
                }
            }

            scheduleSurfaceRefresh(fullscreen, newConfig.orientation);
        });
    }

    private boolean isInPip() {
        return android.os.Build.VERSION.SDK_INT >= 26 && getActivity().isInPictureInPictureMode();
    }

    // ── System UI ────────────────────────────────────────────────────────

    private void hideSystemUi() {
        try {
            getActivity().getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        } catch (Exception ignored) { }
    }

    private void showSystemUi() {
        try {
            getActivity().getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        } catch (Exception ignored) { }
    }
}

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

    private RoomPlayerOverlayView overlay;
    private ChanPlayerEngine engine;
    private FrameLayout.LayoutParams lastRect;   // px
    private boolean fullscreen = false;
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
    // Live progress pusher: the room's control bar needs position/duration/
    // play-state. We push it over the SAME notifyListeners channel that is
    // already proven to reach JS (error/ready/playing events) instead of
    // depending on JS→Java getPosition() round-trips. This is what keeps the
    // room clock/seek/play-pause in sync.
    private final android.os.Handler progressPushHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable progressPushRunnable = new Runnable() {
        @Override
        public void run() {
            if (engine == null) return;
            try {
                JSObject o = new JSObject()
                        .put("positionMs", engine.getPositionMs())
                        .put("durationMs", engine.getDurationMs())
                        .put("isPlaying", engine.isPlaying());
                notifyListeners("playbackProgress", o);
            } catch (Exception ignored) { }
            progressPushHandler.postDelayed(this, 500);
        }
    };
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
                o.put("playing", engine.isPlaying());
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

    private void ensureFsControls() {
        if (fsControlsView != null) return;
        fsControlsView = new android.webkit.WebView(getActivity());
        fsControlsView.setBackgroundColor(android.graphics.Color.TRANSPARENT);
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
                        case "toggle": if (engine.isPlaying()) engine.pause(); else engine.play(); break;
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
            if (overlay != null) {
                if (b <= 1f) {
                    overlay.setBrightnessDim(b);
                    if (engine != null) engine.setVideoEffects(1f, 1f, 1f, 0f); // neutral
                } else {
                    overlay.setBrightnessDim(1f); // no dim
                    if (engine != null) engine.setVideoEffects(b, 1f, 1f, 0f);
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "applyBrightness failed", t);
        }
    }

    @PluginMethod
    public void setBrightnessDim(PluginCall call) {
        Double value = call.getDouble("brightness", 1.0);
        applyBrightness(value == null ? 1f : value.floatValue());
        call.resolve();
    }

    private boolean brightnessPopupWired = false;

    /** Show the native brightness popup OVER the video (video keeps playing). */
    @PluginMethod
    public void showBrightnessPopup(PluginCall call) {
        try {
            Boolean visible = call.getBoolean("visible", true);
            Double brightness = call.getDouble("brightness", 1.0);
            ensureOverlay();
            overlay.showBrightnessPopup(visible == null || visible, brightness == null ? 1f : brightness.floatValue());
            wireBrightnessPopupListener();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "showBrightnessPopup failed", e);
            try { call.reject("Brightness popup failed: " + e.getMessage()); } catch (Exception ignored) { }
        }
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
        try {
            Boolean visible = call.getBoolean("visible", true);
            Double volume = call.getDouble("volume", 1.0);
            Boolean muted = call.getBoolean("muted", false);
            ensureOverlay();
            overlay.showVolumePopup(visible == null || visible,
                    volume == null ? 1f : volume.floatValue(),
                    Boolean.TRUE.equals(muted));
            wireVolumePopupListener();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "showVolumePopup failed", e);
            try { call.reject("Volume popup failed: " + e.getMessage()); } catch (Exception ignored) { }
        }
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

    private void rotateOrientation() {
        try {
            int cur = getActivity().getResources().getConfiguration().orientation;
            if (cur == android.content.res.Configuration.ORIENTATION_LANDSCAPE) {
                getActivity().setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            } else {
                getActivity().setRequestedOrientation(android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
            }
        } catch (Exception ignored) { }
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
                    // Start pushing live progress to the room's control bar.
                    progressPushHandler.removeCallbacks(progressPushRunnable);
                    progressPushHandler.post(progressPushRunnable);
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
        if (overlay != null && !text.isEmpty()) overlay.showStatus(text, false);
        call.resolve();
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
        try {
            int x = call.getInt("x", 0);
            int y = call.getInt("y", 0);
            int w = call.getInt("w", 0);
            int h = call.getInt("h", 0);
            if (overlay == null) {
                call.resolve();
                return;
            }
            if (fullscreen) {
                call.resolve();
                return;
            }
            // Invalid / off-screen rect (video box collapsed or scrolled out):
            // HIDE the overlay instead of leaving it at its previous size —
            // a stale rect (or the 0x0 attach) must never cover app UI.
            if (w <= 0 || h <= 0) {
                getActivity().runOnUiThread(() -> overlay.setVisible(false));
                call.resolve();
                return;
            }
            lastRect = new FrameLayout.LayoutParams(w, h);
            lastRect.leftMargin = x;
            lastRect.topMargin = y;
            getActivity().runOnUiThread(() -> {
                ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView();
                if (attached && overlay.getParent() == decor) {
                    overlay.setLayoutParams(lastRect);
                    overlay.setVisible(true);
                }
            });
            call.resolve();
        } catch (Exception e) {
            call.resolve(); // non-fatal
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        if (engine != null) engine.play();
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        if (engine != null) engine.pause();
        call.resolve();
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        Integer positionMs = call.getInt("positionMs");
        if (positionMs != null && engine != null) engine.seekTo(positionMs);
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        Double volume = call.getDouble("volume", 1.0);
        if (engine != null) engine.setVolume(volume == null ? 1.0f : volume.floatValue());
        call.resolve();
    }

    @PluginMethod
    public void getPosition(PluginCall call) {
        JSObject result = new JSObject();
        if (engine != null) {
            result.put("positionMs", engine.getPositionMs());
            result.put("durationMs", engine.getDurationMs());
            result.put("isPlaying", engine.isPlaying());
        }
        call.resolve(result);
    }

    @PluginMethod
    public void setFullscreen(PluginCall call) {
        Boolean value = call.getBoolean("fullscreen", false);
        setFullscreenUi(Boolean.TRUE.equals(value));
        call.resolve();
    }

    private void setFullscreenUi(boolean value) {
        if (overlay == null || overlay.getParent() == null) return;
        fullscreen = value;
        getActivity().runOnUiThread(() -> {
            ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView();
            if (fullscreen) {
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
                // chrome preference, and restore system UI.
                if (lastRect != null) {
                    overlay.setLayoutParams(lastRect);
                    overlay.setVisible(true);
                }
                overlay.setInteractive(chromeEnabled);
                showSystemUi();
                // Hide the fullscreen controls layer.
                fsPushHandler.removeCallbacks(fsPushRunnable);
                if (fsControlsView != null) fsControlsView.setVisibility(View.GONE);
            }
            overlay.setFullscreenUi(fullscreen);
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
        if (engine != null) {
            engine.setVideoEffects(
                    brightness == null ? 1f : brightness.floatValue(),
                    contrast == null ? 1f : contrast.floatValue(),
                    saturation == null ? 1f : saturation.floatValue(),
                    hue == null ? 0f : hue.floatValue());
        }
        call.resolve();
    }

    @PluginMethod
    public void setSubtitles(PluginCall call) {
        String vttText = call.getString("vttText", "");
        lastVtt = vttText == null ? "" : vttText;
        if (engine != null) engine.setSubtitles(vttText);
        call.resolve();
    }

    @PluginMethod
    public void getVideoTracks(PluginCall call) {
        JSObject result = new JSObject();
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
    }

    @PluginMethod
    public void setVideoQuality(PluginCall call) {
        Boolean auto = call.getBoolean("auto", true);
        Integer trackId = call.getInt("trackId", -1);
        Integer height = call.getInt("height", 0);
        if (engine != null) {
            engine.setVideoQuality(auto == null || auto, trackId == null ? -1 : trackId, height == null ? 0 : height);
        }
        call.resolve();
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        Boolean visible = call.getBoolean("visible", true);
        if (overlay != null) {
            getActivity().runOnUiThread(() -> overlay.setVisible(visible == null || visible));
        }
        call.resolve();
    }

    @PluginMethod
    public void enterPip(PluginCall call) {
        enterPip();
        call.resolve();
    }

    @PluginMethod
    public void closeEmbedded(PluginCall call) {
        JSObject result = new JSObject();
        try {
            if (engine != null) {
                result.put("positionMs", engine.getPositionMs());
                result.put("durationMs", engine.getDurationMs());
                result.put("ended", engine.isEnded());
                result.put("wasPlaying", engine.isPlaying());
            }
            teardown();
        } catch (Throwable t) {
            Log.e(TAG, "closeEmbedded failed", t);
            // Never let a teardown exception take the app down.
        }
        call.resolve(result);
    }

    private void teardown() {
        try { fsPushHandler.removeCallbacks(fsPushRunnable); } catch (Exception ignored) { }
        try { progressPushHandler.removeCallbacks(progressPushRunnable); } catch (Exception ignored) { }
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
        fullscreen = false;
        try { showSystemUi(); } catch (Exception ignored) { }
    }

    // ── PiP (Android 8+) ─────────────────────────────────────────────────

    private void enterPip() {
        if (android.os.Build.VERSION.SDK_INT < 26 || overlay == null) return;
        try {
            WebView webView = getBridge().getWebView();
            if (webView != null) webView.setVisibility(View.INVISIBLE);
            wasPlayingBeforePip = engine != null && engine.isPlaying();
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
        boolean playing = engine != null && engine.isPlaying();
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
                        if (engine.isPlaying()) engine.pause();
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
        // JS re-measures the stage on orientation change and calls setRect.
        // In fullscreen the surface is MATCH_PARENT (setRect early-returns),
        // so re-apply the fullscreen layout on rotate.
        if (fullscreen && overlay != null) {
            getActivity().runOnUiThread(() -> {
                try {
                    ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView();
                    overlay.setLayoutParams(new FrameLayout.LayoutParams(
                            FrameLayout.LayoutParams.MATCH_PARENT,
                            FrameLayout.LayoutParams.MATCH_PARENT));
                    overlay.setFullscreenUi(true);
                    overlay.requestLayout();
                } catch (Exception ignored) { }
            });
            // libVLC does not re-size its video output after a rotate without a
            // detach/attach, and the new layout has NOT settled when this
            // callback fires — refreshing immediately attaches at the OLD size
            // (black screen). Wait for the relayout, then re-hide system UI and
            // refresh the engine surface at the new dimensions.
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (!fullscreen) return;
                try { hideSystemUi(); } catch (Exception ignored) { }
                if (engine != null) engine.refreshSurface();
            }, 300);
        }
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

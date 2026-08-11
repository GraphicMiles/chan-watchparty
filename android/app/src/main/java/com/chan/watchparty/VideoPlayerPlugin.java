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

    private BroadcastReceiver piPReceiver;

    // ── Lifecycle of the overlay ─────────────────────────────────────────

    private void ensureOverlay() {
        if (overlay != null) return;
        Activity activity = getActivity();
        overlay = new RoomPlayerOverlayView(activity);
        engine = new ChanPlayerEngine(activity, engineListener);
        overlay.setEngine(engine);
        overlay.setFullscreenListener(() -> setFullscreenUi(true));
        overlay.setPipListener(this::enterPip);
    }

    private void attachOverlay() {
        if (attached || overlay == null) return;
        ViewGroup decor = (ViewGroup) getActivity().getWindow().getDecorView();
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
        );
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
            if (overlay != null) overlay.hideStatus();
            emitPlaybackState("ready", null);
        }

        @Override
        public void onBuffering(int percent) {
            // Requirement: buffering UI reflects live native state, shown by the
            // app's own control bar — never native chrome. Clamp 1–99%.
            int clamped = Math.max(1, Math.min(99, percent));
            emitPlaybackState("buffering", new JSObject().put("percent", clamped));
        }

        @Override
        public void onPlaying() {
            if (overlay != null) overlay.hideStatus();
            emitPlaybackState("playing", null);
        }

        @Override
        public void onPaused() {
            if (overlay != null) overlay.hideStatus(); // never 'buffering' while paused
            emitPlaybackState("paused", null);
        }

        @Override
        public void onEnded() {
            if (overlay != null) overlay.showStatus("Playback finished", false);
            emitPlaybackState("ended", null);
        }

        @Override
        public void onError(String friendlyMessage, String kind) {
            if (overlay != null) overlay.showStatus(friendlyMessage, true);
            emitPlaybackState("error", new JSObject().put("message", friendlyMessage).put("kind", kind == null ? "other" : kind));
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
        String title = call.getString("title", "Chan Video");
        Double startSeconds = call.getDouble("startSeconds");
        String referer = call.getString("referer", "");
        String container = call.getString("container", "");
        String codec = call.getString("codec", "");
        Boolean controls = call.getBoolean("controls", true);
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
                    overlay.setTapListener(() -> {
                        JSObject tap = new JSObject().put("type", "tap");
                        try { notifyListeners("controlsEvent", tap); } catch (Exception ignored) { }
                    });
                    overlay.setInteractive(controls == null || controls);
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
            if (overlay == null || w <= 0 || h <= 0) {
                call.resolve();
                return;
            }
            if (fullscreen) {
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
                hideSystemUi();
            } else {
                if (lastRect != null) overlay.setLayoutParams(lastRect);
                showSystemUi();
            }
            overlay.setFullscreenUi(fullscreen);
        });
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
    public void enterPip(PluginCall call) {
        enterPip();
        call.resolve();
    }

    @PluginMethod
    public void closeEmbedded(PluginCall call) {
        JSObject result = new JSObject();
        if (engine != null) {
            result.put("positionMs", engine.getPositionMs());
            result.put("durationMs", engine.getDurationMs());
            result.put("ended", engine.isEnded());
            result.put("wasPlaying", engine.isPlaying());
        }
        teardown();
        call.resolve(result);
    }

    private void teardown() {
        if (overlay != null) {
            overlay.teardown();
            detachOverlay();
            overlay = null;
        }
        engine = null;
        fullscreen = false;
        showSystemUi();
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

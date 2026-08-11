package com.chan.watchparty;

import android.app.Activity;
import android.content.Intent;
import android.util.Log;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native Video Player Plugin
 *
 * Launches NativeVideoPlayerActivity for MKV/HEVC/DownloadWella streams and
 * resolves the call when the player closes, returning the playback result so
 * the room can resync and continue the queue.
 *
 * Result payload (P0):
 *   { positionMs, durationMs, ended, wasPlaying }
 *
 * Uses Capacitor 8's modern activity-result flow: startActivityForResult with
 * a callback NAME, and an @ActivityCallback method that receives the result.
 */
@CapacitorPlugin(name = "VideoPlayerPlugin")
public class VideoPlayerPlugin extends Plugin {
    private static final String TAG = "VideoPlayer";

    @PluginMethod
    public void openNative(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("URL is required");
            return;
        }

        String title = call.getString("title", "Chan Video");
        Double startSeconds = call.getDouble("startSeconds");
        String referer = call.getString("referer", "");

        try {
            Intent intent = new Intent(getActivity(), NativeVideoPlayerActivity.class);
            intent.putExtra("url", url);
            intent.putExtra("title", title);
            intent.putExtra("startMs", (long) Math.max(0, startSeconds == null ? 0 : startSeconds * 1000));
            intent.putExtra("referer", referer);
            startActivityForResult(call, intent, "onNativePlayerResult");
        } catch (Exception e) {
            Log.e(TAG, "Native player launch failed", e);
            call.reject("Native player launch failed: " + e.getMessage());
        }
    }

    /**
     * Invoked by Capacitor when NativeVideoPlayerActivity finishes.
     * Resolves the original openNative call with the playback result.
     */
    @ActivityCallback
    private void onNativePlayerResult(PluginCall call, ActivityResult result) {
        JSObject payload = new JSObject();
        if (result != null && result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Intent data = result.getData();
            payload.put("positionMs", data.getLongExtra("positionMs", 0L));
            payload.put("durationMs", data.getLongExtra("durationMs", 0L));
            payload.put("ended", data.getBooleanExtra("ended", false));
            payload.put("wasPlaying", data.getBooleanExtra("wasPlaying", false));
        }
        call.resolve(payload);
    }
}

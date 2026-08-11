package com.chan.watchparty;

import android.app.Activity;
import android.content.Intent;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
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
 */
@CapacitorPlugin(name = "VideoPlayerPlugin")
public class VideoPlayerPlugin extends Plugin {
    private static final String TAG = "VideoPlayer";
    private static final int NATIVE_PLAYER_REQUEST = 7001;

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
            startActivityForResult(call, intent, NATIVE_PLAYER_REQUEST);
        } catch (Exception e) {
            Log.e(TAG, "Native player launch failed", e);
            call.reject("Native player launch failed: " + e.getMessage());
        }
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        super.handleOnActivityResult(requestCode, resultCode, data);
        if (requestCode != NATIVE_PLAYER_REQUEST) return;

        PluginCall call = getSavedCall(requestCode);
        if (call == null) return;

        JSObject result = new JSObject();
        if (resultCode == Activity.RESULT_OK && data != null) {
            result.put("positionMs", data.getLongExtra("positionMs", 0L));
            result.put("durationMs", data.getLongExtra("durationMs", 0L));
            result.put("ended", data.getBooleanExtra("ended", false));
            result.put("wasPlaying", data.getBooleanExtra("wasPlaying", false));
        }
        call.resolve(result);
    }
}

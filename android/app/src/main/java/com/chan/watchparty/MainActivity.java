package com.chan.watchparty;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom Capacitor plugins before BridgeActivity initializes
        // the bridge. Registering after super.onCreate can make JS see
        // "plugin is not implemented on android".
        registerPlugin(O2TvPlugin.class);
        registerPlugin(VideoPlayerPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Back button while the native player is fullscreen → exit fullscreen
    // first (restores the embedded surface), otherwise default behavior.
    @Override
    public void onBackPressed() {
        try {
            VideoPlayerPlugin plugin = (VideoPlayerPlugin) getBridge()
                    .getPlugin("VideoPlayerPlugin").getInstance();
            if (plugin != null && plugin.consumeBackIfFullscreen()) return;
        } catch (Exception ignored) { }
        super.onBackPressed();
    }
}

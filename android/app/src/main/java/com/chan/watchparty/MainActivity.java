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

        // Hide the WebView's native scrollbars entirely (the app is a native
        // app — scrollbars look out of place; CSS ::-webkit-scrollbar rules
        // don't always kill Android WebView's own scrollbar drawing).
        try {
            android.webkit.WebView wv = getBridge().getWebView();
            wv.setVerticalScrollBarEnabled(false);
            wv.setHorizontalScrollBarEnabled(false);
            wv.setOverScrollMode(android.view.View.OVER_SCROLL_NEVER);
        } catch (Exception ignored) { }
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

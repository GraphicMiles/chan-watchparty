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
}

package com.chan.watchparty;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(O2TvPlugin.class);
        registerPlugin(VideoPlayerPlugin.class);
    }
}

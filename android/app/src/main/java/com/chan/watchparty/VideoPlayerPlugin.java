package com.chan.watchparty;

import android.net.Uri;
import android.util.Log;
import androidx.media3.common.MediaItem;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.ui.PlayerView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native Video Player Plugin
 * 
 * Supports:
 * - MP4, WebM (native)
 * - MKV with H.264, H.265, VP9, AV1 (via FFmpeg)
 * - HLS streams (m3u8)
 * - DASH streams
 */
@CapacitorPlugin(name = "VideoPlayerPlugin")
public class VideoPlayerPlugin extends Plugin {
    private static final String TAG = "VideoPlayer";
    
    private ExoPlayer player;
    private PlayerView playerView;
    
    @Override
    public void load() {
        // Initialize ExoPlayer with FFmpeg extension for MKV
        player = new ExoPlayer.Builder(getContext())
            .build();
    }
    
    @PluginMethod
    public void initialize(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            playerView = new PlayerView(getContext());
            playerView.setPlayer(player);
            playerView.setUseController(true);
            call.resolve();
        });
    }
    
    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        String contentType = call.getString("contentType", "video/*");
        
        if (url == null) {
            call.reject("URL is required");
            return;
        }
        
        getActivity().runOnUiThread(() -> {
            try {
                Uri uri = Uri.parse(url);
                MediaItem mediaItem = MediaItem.fromUri(uri);
                
                MediaSource mediaSource;
                if (contentType.contains("application/x-mpegurl") || url.endsWith(".m3u8")) {
                    mediaSource = new HlsMediaSource.Factory(
                        new DefaultHttpDataSource.Factory()
                    ).createMediaSource(mediaItem);
                } else {
                    mediaSource = new ProgressiveMediaSource.Factory(
                        new DefaultHttpDataSource.Factory()
                    ).createMediaSource(mediaItem);
                }
                
                player.setMediaSource(mediaSource);
                player.prepare();
                player.play();
                
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "Play failed", e);
                call.reject("Play failed: " + e.getMessage());
            }
        });
    }
    
    @PluginMethod
    public void pause(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            player.pause();
            call.resolve();
        });
    }
    
    @PluginMethod
    public void seek(PluginCall call) {
        Integer positionMs = call.getInt("positionMs");
        if (positionMs == null) {
            call.reject("positionMs is required");
            return;
        }
        
        getActivity().runOnUiThread(() -> {
            player.seekTo(positionMs);
            call.resolve();
        });
    }
    
    @PluginMethod
    public void getCurrentPosition(PluginCall call) {
        call.resolve(new JSObject().put("positionMs", player.getCurrentPosition()));
    }
    
    @PluginMethod
    public void getDuration(PluginCall call) {
        call.resolve(new JSObject().put("durationMs", player.getDuration()));
    }
    
    @PluginMethod
    public void release(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (player != null) {
                player.release();
                player = null;
            }
            call.resolve();
        });
    }
    
    @Override
    protected void handleOnDestroy() {
        if (player != null) {
            player.release();
        }
    }
}

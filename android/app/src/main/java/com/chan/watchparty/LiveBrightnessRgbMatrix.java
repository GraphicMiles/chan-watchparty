package com.chan.watchparty;

import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.RgbMatrix;

import java.util.concurrent.atomic.AtomicInteger;

/**
 * Real Exo/Media3 brightness: a 4×4 RGB scale matrix sampled every frame.
 *
 * Why this exists: {@code exoPlayer.setVideoEffects(new Brightness(...))}
 * rebuilds the video graph on every call, which seeks/rebuffers. This matrix
 * stays in the pipeline from prepare() and only the uniform changes, so
 * playback is untouched while the picture actually brightens/dims.
 *
 * Scale 0..2 (0%..200%), 1 = identity. Stored as milli-units for atomic CAS.
 */
@UnstableApi
public final class LiveBrightnessRgbMatrix implements RgbMatrix {
    private final AtomicInteger milli = new AtomicInteger(1000);

    public void setBrightness(float brightness) {
        float b = Math.max(0f, Math.min(2f, brightness));
        milli.set(Math.round(b * 1000f));
    }

    public float getBrightness() {
        return milli.get() / 1000f;
    }

    @Override
    public float[] getMatrix(long presentationTimeUs, boolean useHdr) {
        float b = milli.get() / 1000f;
        return new float[] {
                b, 0f, 0f, 0f,
                0f, b, 0f, 0f,
                0f, 0f, b, 0f,
                0f, 0f, 0f, 1f,
        };
    }

    @Override
    public boolean isNoOp(int inputWidth, int inputHeight) {
        // Stay in the graph even at 1.0 so the first non-neutral tick
        // does not insert a new effect (that would rebuild the renderer).
        return false;
    }
}

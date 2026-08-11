package com.chan.watchparty.nativeplayer.player

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout

private const val TAG = "NativePlayer"
private const val UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"
private const val POSITION_POLL_MS = 500L

/**
 * ManagedPlayer — the ONE playback engine for the native room screen.
 *
 * Strategy (mirrors the web-embedded engine):
 *   1. Media3/ExoPlayer for MP4 / HLS / WebM / progressive streams.
 *   2. LibVLC for MKV / HEVC / x265 / odd containers (Chrome's WebView cannot
 *      play these; VLC brings its own demuxers + software decode fallback).
 *   3. If ExoPlayer fails at runtime, switch to VLC automatically.
 *
 * The video surface is attached by the Compose layer via [attachSurface];
 * every playback event is marshalled to the main thread and pushed through
 * [state] so the UI stays a pure function of state.
 */
class ManagedPlayer(
    private val context: Context,
    private val url: String,
    private val title: String,
    private val referer: String?,
    private val headers: Map<String, String>,
    private val container: String?,
    private val codec: String?,
    startMs: Long,
    val isLive: Boolean,
) {
    private val main = Handler(Looper.getMainLooper())

    private val _state = MutableStateFlow(PlayerState())
    val state: StateFlow<PlayerState> = _state

    // ── ExoPlayer side ──
    private var exoPlayer: ExoPlayer? = null
    private var exoView: PlayerView? = null

    // ── libVLC side ──
    private var libVLC: LibVLC? = null
    private var vlcPlayer: MediaPlayer? = null
    private var vlcLayout: VLCVideoLayout? = null

    // ── Surface plumbing ──
    private var surfaceContainer: FrameLayout? = null
    private var attachedView: View? = null

    private var started = false
    private var engineIsVlc = false
    private var pendingSeekMs = startMs.coerceAtLeast(0L)
    private var playbackRate = 1f
    private var volume = 1f

    // ── Position poller (progress bar + room sync; NOT per-frame) ──
    private val positionPoller = object : Runnable {
        override fun run() {
            if (!started) return
            val pos = currentPositionMs()
            val dur = currentDurationMs()
            val s = _state.value
            if (pos != s.positionMs || dur != s.durationMs) {
                _state.value = s.copy(positionMs = pos, durationMs = dur)
            }
            main.postDelayed(this, POSITION_POLL_MS)
        }
    }

    init {
        main.post(positionPoller)
    }

    // ── Surface ─────────────────────────────────────────────────────────

    /** Called by the Compose AndroidView on creation and on every recomposition. */
    fun attachSurface(container: FrameLayout) {
        surfaceContainer = container
        if (attachedView == null) {
            startPrimary()
        } else if (attachedView?.parent !== container) {
            container.addView(
                attachedView,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                ),
            )
        }
    }

    private fun startPrimary() {
        if (started) return
        started = true
        if (shouldPreferVlc()) startVlc() else startExo()
    }

    private fun swapSurface(view: View) {
        val container = surfaceContainer ?: return
        attachedView?.let { container.removeView(it) }
        container.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        attachedView = view
    }

    // ── Engine selection ────────────────────────────────────────────────

    private fun shouldPreferVlc(): Boolean {
        val c = (container ?: "").lowercase()
        val codecL = (codec ?: "").lowercase()
        val urlL = url.lowercase()
        return c.contains("mkv")
            || urlL.contains(".mkv")
            || codecL.contains("hevc")
            || codecL.contains("h265")
            || codecL.contains("x265")
    }

    // ── ExoPlayer path ──────────────────────────────────────────────────

    private fun startExo() {
        if (exoPlayer != null) return
        try {
            val dataSourceFactory = DefaultHttpDataSource.Factory()
                .setUserAgent(UA)
                .setAllowCrossProtocolRedirects(true)
            val requestProps = HashMap<String, String>()
            headers.forEach { (k, v) -> requestProps[k] = v }
            referer?.let { requestProps["Referer"] = it }
            if (requestProps.isNotEmpty()) dataSourceFactory.setDefaultRequestProperties(requestProps)

            val exo = ExoPlayer.Builder(context)
                .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
                .build()
            exo.setPlaybackSpeed(playbackRate)
            exo.volume = volume
            exoPlayer = exo

            val view = PlayerView(context).apply {
                setPlayer(exo)
                useController = false
                setKeepScreenOn(true)
                // media3 1.2 removed PlayerView.RESIZE_MODE_* — use the
                // AspectRatioFrameLayout constant (FIT is the default anyway).
                resizeMode = androidx.media3.ui.AspectRatioFrameLayout.RESIZE_MODE_FIT
            }
            exoView = view
            swapSurface(view)

            exo.addListener(object : Player.Listener {
                override fun onPlaybackStateChanged(state: Int) {
                    when (state) {
                        Player.STATE_READY -> main.post {
                            applyPendingSeek()
                            _state.value = _state.value.copy(
                                isBuffering = false,
                                durationMs = exo.duration.coerceAtLeast(0L),
                                errorMessage = null,
                            )
                        }
                        Player.STATE_BUFFERING -> main.post {
                            _state.value = _state.value.copy(isBuffering = true)
                        }
                        Player.STATE_ENDED -> main.post {
                            _state.value = _state.value.copy(
                                isPlaying = false,
                                isEnded = true,
                                isBuffering = false,
                            )
                        }
                    }
                }

                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    main.post {
                        _state.value = _state.value.copy(
                            isPlaying = isPlaying,
                            isEnded = if (isPlaying) false else _state.value.isEnded,
                        )
                    }
                }

                override fun onPlayerError(error: PlaybackException) {
                    main.post {
                        _state.value = _state.value.copy(isPlaying = false, isBuffering = false)
                        Log.w(TAG, "ExoPlayer error: ${error.errorCodeName} ${error.message}")
                        switchToVlc(error.errorCodeName ?: "ExoPlayer playback failed")
                    }
                }
            })

            exo.setMediaItem(MediaItem.Builder().setUri(Uri.parse(url)).setMediaId(title).build())
            exo.prepare()
            exo.play()

            engineIsVlc = false
            _state.value = _state.value.copy(engineName = "exo", errorMessage = null)
        } catch (t: Throwable) {
            Log.e(TAG, "ExoPlayer start failed", t)
            main.post { switchToVlc(t.message ?: "ExoPlayer could not start") }
        }
    }

    // ── libVLC path ─────────────────────────────────────────────────────

    private fun startVlc() {
        if (vlcPlayer != null) return
        try {
            val args = arrayListOf(
                "--network-caching=2500",
                "--file-caching=1500",
                "--http-reconnect",
                "--avcodec-hw=any",
                "--no-drop-late-frames",
                "--no-skip-frames",
            )
            val vlc = LibVLC(context, args)
            val mp = MediaPlayer(vlc)
            val layout = VLCVideoLayout(context)
            libVLC = vlc
            vlcPlayer = mp
            vlcLayout = layout

            mp.attachViews(layout, null, false, false)
            swapSurface(layout)

            // VLC events may arrive on background threads — marshal to main.
            mp.setEventListener { event ->
                main.post {
                    when (event.type) {
                        MediaPlayer.Event.Playing -> {
                            applyPendingSeek()
                            _state.value = _state.value.copy(
                                isBuffering = false,
                                isEnded = false,
                                errorMessage = null,
                                durationMs = mp.length.coerceAtLeast(0L),
                            )
                            try { mp.setRate(playbackRate) } catch (_: Exception) {}
                        }
                        MediaPlayer.Event.Buffering -> {
                            val pct = event.buffering.toInt().coerceIn(0, 100)
                            _state.value = _state.value.copy(
                                isBuffering = pct < 100,
                                bufferingPercent = pct,
                            )
                        }
                        MediaPlayer.Event.EndReached -> {
                            _state.value = _state.value.copy(
                                isPlaying = false,
                                isEnded = true,
                                isBuffering = false,
                            )
                        }
                        MediaPlayer.Event.EncounteredError -> {
                            _state.value = _state.value.copy(
                                isPlaying = false,
                                isBuffering = false,
                                errorMessage = "This stream could not be played on this device. Try another source or episode.",
                                errorKind = "decode",
                            )
                        }
                    }
                }
            }

            val media = Media(vlc, Uri.parse(url))
            media.setHWDecoderEnabled(true, false)
            media.addOption(":network-caching=2500")
            media.addOption(":http-reconnect")
            media.addOption(":http-user-agent=$UA")
            referer?.let { media.addOption(":http-referrer=$it") }
            mp.setMedia(media)
            media.release()

            mp.setVolume((volume * 100).toInt().coerceIn(0, 100))
            mp.play()

            engineIsVlc = true
            _state.value = _state.value.copy(engineName = "vlc", errorMessage = null)
        } catch (t: Throwable) {
            Log.e(TAG, "libVLC start failed", t)
            _state.value = _state.value.copy(
                errorMessage = "Could not start the video engine: ${t.message}",
                errorKind = "other",
            )
        }
    }

    /** ExoPlayer runtime failure → tear down Exo and retry with VLC once. */
    private fun switchToVlc(reason: String) {
        if (engineIsVlc) return
        Log.w(TAG, "Switching to VLC: $reason")
        releaseExo()
        startVlc()
    }

    // ── Controls ────────────────────────────────────────────────────────

    fun play() {
        val s = _state.value
        if (s.isEnded) {
            seekTo(0L)
        }
        exoPlayer?.play()
        vlcPlayer?.play()
        main.post { _state.value = _state.value.copy(isPlaying = true, isEnded = false) }
    }

    fun pause() {
        exoPlayer?.pause()
        vlcPlayer?.pause()
        main.post { _state.value = _state.value.copy(isPlaying = false) }
    }

    fun playOrPause() {
        if (isPlayingNow()) pause() else play()
    }

    fun seekTo(ms: Long) {
        val dur = currentDurationMs()
        val target = if (dur > 0L) ms.coerceIn(0L, dur) else ms.coerceAtLeast(0L)
        pendingSeekMs = target
        exoPlayer?.seekTo(target)
        vlcPlayer?.setTime(target)
        main.post { _state.value = _state.value.copy(positionMs = target) }
    }

    fun setRate(rate: Float) {
        playbackRate = rate
        exoPlayer?.setPlaybackSpeed(rate)
        if (engineIsVlc) {
            try { vlcPlayer?.setRate(rate) } catch (_: Exception) {}
        }
    }

    fun setVolume(value: Float) {
        volume = value.coerceIn(0f, 1f)
        exoPlayer?.volume = volume
        try { vlcPlayer?.setVolume((volume * 100).toInt()) } catch (_: Exception) {}
    }

    fun retry() {
        main.post {
            releaseExo()
            releaseVlc()
            attachedView = null
            started = false
            _state.value = _state.value.copy(
                errorMessage = null,
                errorKind = "other",
                isEnded = false,
                isBuffering = false,
            )
            surfaceContainer?.let { attachSurface(it) }
        }
    }

    // ── Read state (used by the Activity for results / PiP) ─────────────

    fun positionMs(): Long = currentPositionMs()

    fun durationMs(): Long = currentDurationMs()

    fun isPlayingNow(): Boolean =
        (exoPlayer?.isPlaying == true) || (vlcPlayer?.isPlaying == true)

    fun isEndedNow(): Boolean = _state.value.isEnded

    private fun currentPositionMs(): Long =
        (exoPlayer?.currentPosition ?: vlcPlayer?.time ?: 0L).coerceAtLeast(0L)

    private fun currentDurationMs(): Long =
        (exoPlayer?.duration ?: vlcPlayer?.length ?: 0L).coerceAtLeast(0L)

    private fun applyPendingSeek() {
        if (pendingSeekMs > 0L) {
            exoPlayer?.seekTo(pendingSeekMs)
            try { vlcPlayer?.setTime(pendingSeekMs) } catch (_: Exception) {}
            _state.value = _state.value.copy(positionMs = pendingSeekMs)
            pendingSeekMs = 0L
        }
    }

    // ── Teardown ────────────────────────────────────────────────────────

    fun release() {
        main.removeCallbacks(positionPoller)
        releaseExo()
        releaseVlc()
        surfaceContainer = null
        attachedView = null
        started = false
    }

    private fun releaseExo() {
        exoPlayer?.release()
        exoPlayer = null
        exoView = null
    }

    private fun releaseVlc() {
        try { vlcPlayer?.stop() } catch (_: Exception) {}
        try { vlcPlayer?.detachViews() } catch (_: Exception) {}
        vlcPlayer?.release()
        vlcPlayer = null
        libVLC?.release()
        libVLC = null
        vlcLayout = null
    }
}

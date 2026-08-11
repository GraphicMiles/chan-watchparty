package com.chan.watchparty.nativeplayer

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.chan.watchparty.nativeplayer.player.ManagedPlayer
import com.chan.watchparty.nativeplayer.ui.ChanNativeTheme
import com.chan.watchparty.nativeplayer.ui.RoomPlayerScreen

/**
 * NativeRoomActivity — Option B: the watch-room playback surface, fully native.
 *
 * Launched from the web layer (VideoPlayerPlugin.openNativeRoom) with the
 * stream descriptor; renders the video edge-to-edge with a Compose control
 * surface that is inset-aware (status bar, gesture bar, display cutout) and
 * responsive across portrait/landscape and small screens.
 *
 * On close it returns { positionMs, durationMs, ended, wasPlaying } so the
 * web room can freeze playerState and resume where the viewer left off.
 *
 * PiP: home-button auto-PiP while playing + a PiP button in the top bar
 * (Android 8+). While in PiP only the video surface is drawn.
 */
class NativeRoomActivity : ComponentActivity() {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_TITLE = "title"
        const val EXTRA_REFERER = "referer"
        const val EXTRA_HEADERS = "headers"
        const val EXTRA_CONTAINER = "container"
        const val EXTRA_CODEC = "codec"
        const val EXTRA_START_MS = "startMs"
        const val EXTRA_IS_LIVE = "isLive"

        const val RESULT_POSITION_MS = "positionMs"
        const val RESULT_DURATION_MS = "durationMs"
        const val RESULT_ENDED = "ended"
        const val RESULT_WAS_PLAYING = "wasPlaying"

        private const val ACTION_TOGGLE_PLAY = "com.chan.watchparty.NATIVE_ROOM_TOGGLE"
    }

    private lateinit var player: ManagedPlayer
    // Compose state (not a plain field) so the UI recomposes when PiP changes.
    private val pipMode = mutableStateOf(false)
    private var resultDelivered = false
    private var pipReceiver: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Edge-to-edge: the video surface draws behind system bars; the
        // control bars apply their own insets (safeDrawingPadding).
        enableEdgeToEdge()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val url = intent.getStringExtra(EXTRA_URL)
        if (url.isNullOrBlank()) {
            setResult(Activity.RESULT_CANCELED)
            finish()
            return
        }

        val title = intent.getStringExtra(EXTRA_TITLE) ?: "Chan Video"
        val referer = intent.getStringExtra(EXTRA_REFERER)
        val container = intent.getStringExtra(EXTRA_CONTAINER)
        val codec = intent.getStringExtra(EXTRA_CODEC)
        val startMs = intent.getLongExtra(EXTRA_START_MS, 0L)
        val isLive = intent.getBooleanExtra(EXTRA_IS_LIVE, false)
        val headers = readHeaders(intent)

        player = ManagedPlayer(
            context = this,
            url = url,
            title = title,
            referer = referer,
            headers = headers,
            container = container,
            codec = codec,
            startMs = startMs,
            isLive = isLive,
        )

        setContent {
            ChanNativeTheme {
                val state by player.state.collectAsStateWithLifecycle()

                // Keep the screen on only while actually playing.
                LaunchedEffect(state.isPlaying) {
                    if (state.isPlaying) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                }

                RoomPlayerScreen(
                    player = player,
                    title = title,
                    isLive = isLive,
                    pipMode = pipMode.value,
                    onBack = { finishWithResult() },
                    onTogglePip = { enterPip() },
                    onToggleFullscreen = { toggleImmersive() },
                )
            }
        }

        registerPipReceiver()
    }

    private fun readHeaders(intent: Intent): Map<String, String> {
        val bundle = intent.getBundleExtra(EXTRA_HEADERS) ?: return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (key in bundle.keySet()) {
            bundle.getString(key)?.let { out[key] = it }
        }
        return out
    }

    // ── Immersive (fullscreen) toggle ───────────────────────────────────

    private var immersive = false

    private fun toggleImmersive() {
        immersive = !immersive
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (immersive) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
            controller.systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    // ── Picture-in-Picture (Android 8+) ─────────────────────────────────

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (player.isPlayingNow() && Build.VERSION.SDK_INT >= 26) enterPip()
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration?,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        pipMode.value = isInPictureInPictureMode
    }

    private fun enterPip() {
        if (Build.VERSION.SDK_INT < 26) return
        try {
            val toggleIntent = Intent(ACTION_TOGGLE_PLAY)
            val pending = PendingIntent.getBroadcast(
                this,
                2,
                toggleIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val icon = IconCompat.createWithResource(this, android.R.drawable.ic_media_play)
            val action = RemoteAction(icon.toIcon(), "Play/Pause", "Toggle playback", pending)
            val params = PictureInPictureParams.Builder()
                .setAspectRatio(Rational(16, 9))
                .setActions(listOf(action))
                .build()
            enterPictureInPictureMode(params)
        } catch (_: Exception) {
            // PiP unsupported — ignore
        }
    }

    private fun registerPipReceiver() {
        if (Build.VERSION.SDK_INT < 26) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action == ACTION_TOGGLE_PLAY) {
                    if (player.isPlayingNow()) player.pause() else player.play()
                }
            }
        }
        val filter = IntentFilter(ACTION_TOGGLE_PLAY)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(receiver, filter)
        }
        pipReceiver = receiver
    }

    // ── Result ──────────────────────────────────────────────────────────

    override fun onBackPressed() {
        finishWithResult()
    }

    private fun finishWithResult() {
        if (resultDelivered) return
        resultDelivered = true
        val data = Intent().apply {
            putExtra(RESULT_POSITION_MS, player.positionMs())
            putExtra(RESULT_DURATION_MS, player.durationMs())
            putExtra(RESULT_ENDED, player.isEndedNow())
            putExtra(RESULT_WAS_PLAYING, player.isPlayingNow())
        }
        setResult(Activity.RESULT_OK, data)
        finish()
    }

    override fun onDestroy() {
        pipReceiver?.let { runCatching { unregisterReceiver(it) } }
        pipReceiver = null
        player.release()
        super.onDestroy()
    }
}

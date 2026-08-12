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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.graphics.drawable.IconCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.chan.watchparty.nativeplayer.data.FirestoreClient
import com.chan.watchparty.nativeplayer.data.RoomRepository
import com.chan.watchparty.nativeplayer.player.ManagedPlayer
import com.chan.watchparty.nativeplayer.ui.ChanNativeTheme
import com.chan.watchparty.nativeplayer.ui.NativeRoomScreen

/**
 * NativeRoomActivity — the ONE watch room for the mobile app.
 *
 * Everything except YouTube plays here: the room renders inline (room
 * details → tabs → video box → controls → participants) with chat/queue/share
 * panels layered ON TOP of the video. Data comes straight from Firestore REST
 * (and /api/room) using the user's Firebase ID token.
 *
 * The web shell stays mounted underneath purely as the launch pad; on close
 * this activity returns { positionMs, durationMs, ended, wasPlaying } so the
 * web layer can freeze playerState and let the next entry resume.
 */
class NativeRoomActivity : ComponentActivity() {

    companion object {
        const val EXTRA_ROOM_ID = "roomId"
        const val EXTRA_UID = "uid"
        const val EXTRA_DISPLAY_NAME = "displayName"
        const val EXTRA_ID_TOKEN = "idToken"
        const val EXTRA_PROJECT_ID = "projectId"
        const val EXTRA_API_KEY = "apiKey"
        const val EXTRA_API_BASE = "apiBase"
        const val EXTRA_START_MS = "startMs"

        const val RESULT_POSITION_MS = "positionMs"
        const val RESULT_DURATION_MS = "durationMs"
        const val RESULT_ENDED = "ended"
        const val RESULT_WAS_PLAYING = "wasPlaying"

        private const val ACTION_TOGGLE_PLAY = "com.chan.watchparty.NATIVE_ROOM_TOGGLE"
    }

    private lateinit var repo: RoomRepository
    private var player: ManagedPlayer? by mutableStateOf(null)
    private val pipMode = mutableStateOf(false)
    private var resultDelivered = false
    private var pipReceiver: BroadcastReceiver? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val roomId = intent.getStringExtra(EXTRA_ROOM_ID)
        val uid = intent.getStringExtra(EXTRA_UID)
        val token = intent.getStringExtra(EXTRA_ID_TOKEN)
        val projectId = intent.getStringExtra(EXTRA_PROJECT_ID)
        val apiKey = intent.getStringExtra(EXTRA_API_KEY)
        val apiBase = intent.getStringExtra(EXTRA_API_BASE)
        val displayName = intent.getStringExtra(EXTRA_DISPLAY_NAME) ?: "Viewer"
        val startMs = intent.getLongExtra(EXTRA_START_MS, 0L)

        if (roomId.isNullOrBlank() || uid.isNullOrBlank() || token.isNullOrBlank() || projectId.isNullOrBlank()) {
            setResult(Activity.RESULT_CANCELED)
            finish()
            return
        }

        val fs = FirestoreClient(projectId, apiKey ?: "", idToken = { token })
        repo = RoomRepository(
            context = this,
            fs = fs,
            apiBase = apiBase ?: "",
            roomId = roomId,
            uid = uid,
            displayName = displayName,
            idToken = { token },
            myRole = {
                val r = repo.room.value
                when {
                    r == null -> "viewer"
                    r.hostId == uid -> "host"
                    r.coHosts.contains(uid) -> "co-host"
                    else -> "viewer"
                }
            },
        )
        repo.start()

        setContent {
            ChanNativeTheme {
                val room by repo.room.collectAsState()
                val sync by repo.playerSync.collectAsState()

                // Create the player once the room (and its stream) is known;
                // if the room switches video (queue play-next), load the new
                // stream on the existing player.
                LaunchedEffect(room?.videoUrl) {
                    val r = room ?: return@LaunchedEffect
                    val url = r.videoUrl ?: return@LaunchedEffect
                    val m = r.media
                    val isLive = r.isLive || r.videoType == "iptv" || r.videoType == "sports"
                    if (player == null) {
                        player = ManagedPlayer(
                            context = this@NativeRoomActivity,
                            url = url,
                            title = r.title,
                            referer = m["referer"] as? String,
                            headers = stringMap(m["headers"]),
                            container = m["container"] as? String,
                            codec = m["codec"] as? String,
                            startMs = if (sync.currentTime > 0) (sync.currentTime * 1000).toLong() else startMs,
                            isLive = isLive,
                        )
                    } else if (url != player?.currentUrl()) {
                        player?.loadNew(
                            url, r.title,
                            m["referer"] as? String,
                            stringMap(m["headers"]),
                            m["container"] as? String,
                            m["codec"] as? String,
                            0L,
                        )
                    }
                }

                NativeRoomScreen(
                    roomTitle = room?.title ?: "Loading room…",
                    roomSubtitle = when {
                        room == null -> "Connecting…"
                        room.status != "live" -> "This room has ended"
                        room.videoType == "iptv" || room.videoType == "sports" -> "Live stream"
                        else -> "Watch party"
                    },
                    isLive = room?.isLive == true || room?.videoType == "iptv" || room?.videoType == "sports",
                    player = player,
                    repo = repo,
                    uid = uid,
                    onBack = { finishWithResult() },
                    onEndRoom = {
                        repo.endRoom()
                        finishWithResult()
                    },
                    onTogglePip = { enterPip() },
                    onBrightness = { v ->
                        val lp = window.attributes
                        lp.screenBrightness = v
                        window.attributes = lp
                    },
                    onFullscreenChange = { immersive ->
                        val controller = WindowCompat.getInsetsController(window, window.decorView)
                        if (immersive) {
                            controller.hide(WindowInsetsCompat.Type.systemBars())
                            controller.systemBarsBehavior =
                                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                        } else {
                            controller.show(WindowInsetsCompat.Type.systemBars())
                        }
                    },
                )
            }
        }

        registerPipReceiver()
    }

    private fun stringMap(value: Any?): Map<String, String> {
        if (value !is Map<*, *>) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for ((k, v) in value) if (k != null && v != null) out[k.toString()] = v.toString()
        return out
    }

    // ── PiP (Android 8+) ─────────────────────────────────────────────────

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (player?.isPlayingNow() == true && Build.VERSION.SDK_INT >= 26) enterPip()
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        pipMode.value = isInPictureInPictureMode
    }

    private fun enterPip() {
        if (Build.VERSION.SDK_INT < 26) return
        try {
            val toggleIntent = Intent(ACTION_TOGGLE_PLAY)
            val pending = PendingIntent.getBroadcast(
                this, 2, toggleIntent,
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
                    if (player?.isPlayingNow() == true) player?.pause() else player?.play()
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
        // Freeze the position so the web layer / next entry resumes here.
        try { repo.freezePlayerState((player?.positionMs() ?: 0L) / 1000.0) } catch (_: Exception) {}
        val data = Intent().apply {
            putExtra(RESULT_POSITION_MS, player?.positionMs() ?: 0L)
            putExtra(RESULT_DURATION_MS, player?.durationMs() ?: 0L)
            putExtra(RESULT_ENDED, player?.isEndedNow() ?: false)
            putExtra(RESULT_WAS_PLAYING, player?.isPlayingNow() ?: false)
        }
        setResult(Activity.RESULT_OK, data)
        finish()
    }

    override fun onDestroy() {
        pipReceiver?.let { runCatching { unregisterReceiver(it) } }
        pipReceiver = null
        repo.stop()
        player?.release()
        super.onDestroy()
    }
}

package com.chan.watchparty.nativeplayer.ui

import android.graphics.Color as AndroidColor
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.chan.watchparty.nativeplayer.data.ChatMessage
import com.chan.watchparty.nativeplayer.data.Participant
import com.chan.watchparty.nativeplayer.data.QueueItem
import com.chan.watchparty.nativeplayer.data.RoomRepository
import com.chan.watchparty.nativeplayer.player.ManagedPlayer
import com.chan.watchparty.nativeplayer.player.PlayerState
import com.chan.watchparty.nativeplayer.util.formatTime
import kotlinx.coroutines.delay

private const val CONTROLS_HIDE_MS = 3500L
private val SPEEDS = floatArrayOf(1f, 1.25f, 1.5f, 2f)
private val BRIGHTNESS_LEVELS = floatArrayOf(1f, 0.75f, 0.5f, 1f)

enum class RoomTab { SHARE, QUEUE, CHAT }

/**
 * NativeRoomScreen — the ONE watch room (mobile app, not web).
 *
 * Structure (top → bottom):
 *   1. Room details   — back · title · LIVE/locked badges · End (host)
 *   2. Room tabs      — Share · Queue (n) · Chat
 *   3. Video box      — inline 16:9 surface; tab panels render ON TOP of it
 *   4. Controls       — main (play/seek/time/fullscreen) + secondary
 *                       (volume/±10s/brightness/CC/speed/PiP)
 *   5. Participants   — collapsible list with host actions
 *
 * Fullscreen (⛶): video fills the whole screen on top of everything; the
 * icon toggles Maximize ⇄ Minimize; the SAME in-app controls overlay it.
 */
@Composable
fun NativeRoomScreen(
    roomTitle: String,
    roomSubtitle: String,
    isLive: Boolean,
    player: ManagedPlayer?,
    repo: RoomRepository,
    uid: String,
    onBack: () -> Unit,
    onEndRoom: () -> Unit,
    onTogglePip: () -> Unit,
    onBrightness: (Float) -> Unit,
    onFullscreenChange: (Boolean) -> Unit,
) {
    val room by repo.room.collectAsState()
    val messages by repo.messages.collectAsState()
    val queue by repo.queue.collectAsState()
    val participants by repo.participants.collectAsState()
    val sync by repo.playerSync.collectAsState()
    val typing by repo.typing.collectAsState()

    var activeTab by remember { mutableStateOf<RoomTab?>(null) }
    var fullscreen by remember { mutableStateOf(false) }
    var secondaryOpen by remember { mutableStateOf(true) }
    var participantsOpen by remember { mutableStateOf(true) }

    // ── Playback sync ───────────────────────────────────────────────────
    // Controller: publish position every ~1.5s. Viewer: apply remote state.
    LaunchedEffect(repo, room?.hostId, player) {
        val p = player ?: return@LaunchedEffect
        val controller = room?.hostId == uid || (room?.coHosts?.contains(uid) == true)
        while (true) {
            if (controller) {
                repo.writePlayerState(p.positionMs() / 1000.0, p.isPlayingNow())
            } else {
                val vUrl = sync.videoUrl
                if (vUrl != null && vUrl != p.currentUrl()) {
                    val m = room?.media.orEmpty()
                    p.loadNew(
                        vUrl,
                        roomTitle,
                        m["referer"] as? String,
                        stringMap(m["headers"]),
                        m["container"] as? String,
                        m["codec"] as? String,
                        (sync.currentTime * 1000).toLong(),
                    )
                } else {
                    val target = (sync.currentTime * 1000).toLong()
                    if (kotlin.math.abs(p.positionMs() - target) > 600) p.seekTo(target)
                    if (sync.isPlaying && !p.isPlayingNow()) p.play()
                    if (!sync.isPlaying && p.isPlayingNow() && sync.updatedBy != uid) p.pause()
                }
            }
            delay(1500)
        }
    }

    LaunchedEffect(fullscreen) { onFullscreenChange(fullscreen) }

    if (fullscreen && player != null) {
        FullscreenLayout(
            player = player,
            title = roomTitle,
            isLive = isLive,
            onMinimize = { fullscreen = false },
            onTogglePlay = { player.playOrPause() },
            onSeek = { player.seekTo(it) },
            onBrightness = onBrightness,
        )
        return
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(ChanColors.Bg)
            .safeDrawingPadding(),
    ) {
        // 1 ── Room details ──────────────────────────────────────────────
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PillIcon(Icons.Filled.ArrowBack, "Back to home", onBack)
            Spacer(Modifier.width(6.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    roomTitle,
                    color = ChanColors.TextPrimary,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    roomSubtitle,
                    color = ChanColors.TextSecondary,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (isLive) LiveBadge()
            if (room?.locked == true) PillText("Locked")
            if (room?.hostId == uid) {
                Spacer(Modifier.width(6.dp))
                PillText("End", tint = ChanColors.Danger, onClick = onEndRoom)
            }
        }

        // 2 ── Room tabs ─────────────────────────────────────────────────
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            TabPill("Share", active = activeTab == RoomTab.SHARE) { activeTab = if (activeTab == RoomTab.SHARE) null else RoomTab.SHARE }
            TabPill("Queue (${queue.size}/5)", active = activeTab == RoomTab.QUEUE) { activeTab = if (activeTab == RoomTab.QUEUE) null else RoomTab.QUEUE }
            TabPill("Chat", active = activeTab == RoomTab.CHAT) { activeTab = if (activeTab == RoomTab.CHAT) null else RoomTab.CHAT }
        }

        // 3 ── Video box + overlay panels ────────────────────────────────
        Box(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(12.dp),
        ) {
            VideoBox(
                player = player,
                isLive = isLive,
                onTogglePlay = { player?.playOrPause() },
                onSeek = { player?.seekTo(it) },
            )

            // Panels render ON TOP of the video (requirement).
            if (activeTab != null) {
                Box(Modifier.fillMaxSize()) {
                    when (activeTab) {
                        RoomTab.CHAT -> ChatPanel(
                            messages = messages,
                            typingNames = typing.map { it.second },
                            onSend = { repo.sendMessage(it) },
                            onClose = { activeTab = null },
                            onTypingChange = { repo.setTyping(it) },
                            onSummary = { repo.aiSummary() },
                            onCatchup = { repo.aiCatchup() },
                            onQuiz = { repo.aiQuiz() },
                            cooldownSec = repo.aiCooldownSec.collectAsState().value,
                        )
                        RoomTab.QUEUE -> QueuePanel(
                            queue = queue,
                            canControl = room?.hostId == uid || room?.coHosts?.contains(uid) == true,
                            onAddUrl = { url, title -> repo.addToQueue(title, url, null, "direct", null) },
                            onRemove = { repo.removeFromQueue(it.id) },
                            onPlayNext = { repo.playNext(it) },
                            onClose = { activeTab = null },
                        )
                        RoomTab.SHARE -> SharePanel(
                            link = repo.shareLink(),
                            onClose = { activeTab = null },
                        )
                        null -> {}
                    }
                }
            }
        }

        // 4 ── Controls ──────────────────────────────────────────────────
        ControlsSection(
            player = player,
            isLive = isLive,
            secondaryOpen = secondaryOpen,
            onToggleSecondary = { secondaryOpen = !secondaryOpen },
            fullscreen = fullscreen,
            onToggleFullscreen = { fullscreen = !fullscreen },
            onTogglePip = onTogglePip,
            onBrightness = onBrightness,
        )

        // 5 ── Participants ──────────────────────────────────────────────
        ParticipantsSection(
            participants = participants,
            capacity = room?.capacity ?: 12,
            hostId = room?.hostId ?: "",
            coHosts = room?.coHosts ?: emptyList(),
            uid = uid,
            expanded = participantsOpen,
            onToggle = { participantsOpen = !participantsOpen },
            repo = repo,
        )
    }
}

// ════════════════════════ Video box ════════════════════════

@Composable
private fun BoxScope.VideoBox(
    player: ManagedPlayer?,
    isLive: Boolean,
    onTogglePlay: () -> Unit,
    onSeek: (Long) -> Unit,
) {
    val emptyFlow = remember { kotlinx.coroutines.flow.MutableStateFlow(PlayerState()) }
    val state by (player?.state ?: emptyFlow).collectAsState()
    var controlsVisible by remember { mutableStateOf(true) }

    LaunchedEffect(controlsVisible, state.isPlaying, state.isBuffering) {
        if (controlsVisible && state.isPlaying && !state.isBuffering) {
            delay(CONTROLS_HIDE_MS)
            controlsVisible = false
        }
    }

    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(RoundedCornerShape(14.dp))
            .background(Color.Black)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { controlsVisible = !controlsVisible },
                    onDoubleTap = { offset ->
                        val delta = if (offset.x < size.width / 2f) -10_000L else 10_000L
                        onSeek(state.positionMs + delta)
                    },
                )
            },
    ) {
        // Native video surface (ExoPlayer ⇄ VLC) — inline in the layout.
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                FrameLayout(ctx).apply {
                    setBackgroundColor(AndroidColor.BLACK)
                    player?.attachSurface(this)
                }
            },
            update = { player?.attachSurface(it) },
        )

        // CC at the TOP of the video.
        val cue = player?.cueAt(state.positionMs)
        if (cue != null && !cue.isBlank()) {
            Text(
                cue,
                color = Color.White,
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(horizontal = 24.dp, vertical = 12.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color.Black.copy(alpha = 0.6f))
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }

        if (state.isBuffering && state.errorMessage == null) {
            CircularProgressIndicator(
                color = Color.White,
                strokeWidth = 3.dp,
                modifier = Modifier.align(Alignment.Center).size(48.dp),
            )
        }

        if (controlsVisible && !state.isPlaying) {
            Box(
                Modifier
                    .align(Alignment.Center)
                    .size(64.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.5f))
                    .clickable { onTogglePlay() },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.PlayArrow, "Play", tint = Color.White, modifier = Modifier.size(36.dp))
            }
        }

        if (isLive) {
            Row(
                Modifier
                    .align(Alignment.TopStart)
                    .padding(10.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(Color.Black.copy(alpha = 0.6f))
                    .padding(horizontal = 10.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(8.dp).clip(CircleShape).background(ChanColors.Live))
                Spacer(Modifier.width(6.dp))
                Text("LIVE", color = ChanColors.Live, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            }
        }

        state.errorMessage?.let { msg ->
            Column(
                Modifier
                    .align(Alignment.Center)
                    .padding(20.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(ChanColors.Surface.copy(alpha = 0.95f))
                    .padding(18.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(msg, color = ChanColors.TextPrimary, fontSize = 14.sp, textAlign = TextAlign.Center)
                Spacer(Modifier.height(10.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PillText("Retry", onClick = { player?.retry() })
                }
            }
        }
    }
}

// ════════════════════════ Controls ════════════════════════

@Composable
private fun ControlsSection(
    player: ManagedPlayer?,
    isLive: Boolean,
    secondaryOpen: Boolean,
    onToggleSecondary: () -> Unit,
    fullscreen: Boolean,
    onToggleFullscreen: () -> Unit,
    onTogglePip: () -> Unit,
    onBrightness: (Float) -> Unit,
) {
    val emptyFlow = remember { kotlinx.coroutines.flow.MutableStateFlow(PlayerState()) }
    val state by (player?.state ?: emptyFlow).collectAsState()
    var dragMs by remember { mutableStateOf<Long?>(null) }
    var volume by remember { mutableStateOf(1f) }
    var muted by remember { mutableStateOf(false) }
    var speedIdx by remember { mutableIntStateOf(0) }
    var ccEnabled by remember { mutableStateOf(false) }
    var brightnessIdx by remember { mutableIntStateOf(0) }

    val duration = state.durationMs.coerceAtLeast(1L)
    val position = (dragMs ?: state.positionMs).coerceIn(0L, duration)

    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        // Main bar
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(ChanColors.Surface)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PillText(if (state.isPlaying) "❚❚" else "▶", onClick = { player?.playOrPause() }, title = if (state.isPlaying) "Pause" else "Play")
            Text(formatTime(position), color = ChanColors.TextPrimary, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            if (!isLive) {
                Slider(
                    value = position.toFloat(),
                    onValueChange = { dragMs = it.toLong() },
                    onValueChangeFinished = { dragMs?.let { player?.seekTo(it) }; dragMs = null },
                    valueRange = 0f..duration.toFloat(),
                    modifier = Modifier.weight(1f).padding(horizontal = 6.dp),
                    colors = SliderDefaults.colors(
                        thumbColor = Color.White,
                        activeTrackColor = Color.White,
                        inactiveTrackColor = Color.White.copy(alpha = 0.3f),
                    ),
                )
            }
            Text(formatTime(duration), color = ChanColors.TextSecondary, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
            PillText(if (fullscreen) "⤡" else "⛶", onClick = onToggleFullscreen, title = if (fullscreen) "Minimize" else "Maximize")
            PillText(if (secondaryOpen) "⌄" else "⌃", onClick = onToggleSecondary, title = "Secondary controls")
        }

        // Secondary bar
        if (secondaryOpen) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(ChanColors.Surface)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PillText(if (muted || volume == 0f) "🔇" else "🔊", onClick = {
                    muted = !muted
                    player?.setVolume(if (muted) 0f else volume)
                })
                Slider(
                    value = if (muted) 0f else volume,
                    onValueChange = {
                        volume = it
                        muted = it == 0f
                        player?.setVolume(it)
                    },
                    valueRange = 0f..1f,
                    modifier = Modifier.width(90.dp),
                    colors = SliderDefaults.colors(
                        thumbColor = Color.White,
                        activeTrackColor = Color.White,
                        inactiveTrackColor = Color.White.copy(alpha = 0.3f),
                    ),
                )
                PillText("-10s", onClick = { player?.seekTo(state.positionMs - 10_000) })
                PillText("+10s", onClick = { player?.seekTo(state.positionMs + 10_000) })
                PillText(if (brightnessIdx == 0) "Bright" else "${Math.round(BRIGHTNESS_LEVELS[brightnessIdx] * 100)}%", onClick = {
                    brightnessIdx = (brightnessIdx + 1) % BRIGHTNESS_LEVELS.size
                    onBrightness(BRIGHTNESS_LEVELS[brightnessIdx])
                })
                PillText(if (ccEnabled) "CC:On" else "CC", onClick = {
                    ccEnabled = !ccEnabled
                    player?.setSubtitles(if (ccEnabled) "x" else null)
                })
                PillText(formatSpeed(SPEEDS[speedIdx]), onClick = {
                    speedIdx = (speedIdx + 1) % SPEEDS.size
                    player?.setRate(SPEEDS[speedIdx])
                })
                PillText("PiP", onClick = onTogglePip)
            }
        }
    }
}

// ════════════════════════ Participants ════════════════════════

@Composable
private fun ParticipantsSection(
    participants: List<Participant>,
    capacity: Int,
    hostId: String,
    coHosts: List<String>,
    uid: String,
    expanded: Boolean,
    onToggle: () -> Unit,
    repo: RoomRepository,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .background(ChanColors.Surface)
                .clickable { onToggle() }
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Participants (${participants.size}/$capacity)",
                color = ChanColors.TextPrimary,
                fontWeight = FontWeight.SemiBold,
                fontSize = 14.sp,
                modifier = Modifier.weight(1f),
            )
            Text(if (expanded) "⌃" else "⌄", color = ChanColors.TextSecondary, fontSize = 16.sp)
        }
        if (expanded) {
            Column(Modifier.fillMaxWidth().padding(top = 6.dp)) {
                participants.forEach { p ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(ChanColors.Surface.copy(alpha = 0.6f))
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            p.displayName,
                            color = ChanColors.TextPrimary,
                            fontSize = 14.sp,
                            fontWeight = if (p.uid == uid) FontWeight.Bold else FontWeight.Normal,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        when {
                            p.uid == hostId -> PillText("Host")
                            coHosts.contains(p.uid) -> PillText("Co-host")
                        }
                        if (p.muted) PillText("Muted")
                        if (hostId == uid && p.uid != uid) {
                            PillText("Kick") { repo.kick(p.uid) {} }
                            PillText(if (coHosts.contains(p.uid)) "Demote" else "Promote") {
                                repo.promote(p.uid, if (coHosts.contains(p.uid)) "viewer" else "co-host") {}
                            }
                            PillText(if (p.muted) "Unmute" else "Mute") { repo.mute(p.uid, !p.muted) {} }
                        }
                    }
                }
                if (participants.isEmpty()) {
                    Text(
                        "No participants yet",
                        color = ChanColors.TextSecondary,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(8.dp),
                    )
                }
            }
        }
    }
}

// ════════════════════════ Panels ════════════════════════

@Composable
private fun ChatPanel(
    messages: List<ChatMessage>,
    typingNames: List<String>,
    onSend: (String) -> Unit,
    onClose: () -> Unit,
    onTypingChange: (Boolean) -> Unit,
    onSummary: () -> Unit,
    onCatchup: () -> Unit,
    onQuiz: () -> Unit,
    cooldownSec: Int,
) {
    PanelShell("Chat", onClose) {
        var input by remember { mutableStateOf("") }
        val listState = rememberLazyListState()

        LaunchedEffect(messages.size) {
            if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
        }

        Column(Modifier.fillMaxSize().padding(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PillText(if (cooldownSec > 0) "${cooldownSec / 60}m" else "Summary", onClick = onSummary)
                PillText("Catch Up", onClick = onCatchup)
                PillText("Quiz", onClick = onQuiz)
            }
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).padding(top = 8.dp),
            ) {
                items(messages) { m ->
                    val isBot = m.type == "bot" || m.type == "system"
                    Text(
                        "${if (isBot) "" else "${m.displayName}: "}${m.text}",
                        color = if (isBot) ChanColors.Accent else ChanColors.TextPrimary,
                        fontSize = 14.sp,
                        modifier = Modifier.padding(vertical = 2.dp),
                    )
                }
            }
            if (typingNames.isNotEmpty()) {
                Text(
                    "${typingNames.joinToString(", ")} typing…",
                    color = ChanColors.TextSecondary,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(vertical = 2.dp),
                )
            }
            Row(
                Modifier.fillMaxWidth().padding(top = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(20.dp))
                        .background(ChanColors.Raised)
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                ) {
                    BasicTextField(
                        value = input,
                        onValueChange = {
                            input = it.take(500)
                            onTypingChange(it.isNotEmpty())
                        },
                        textStyle = TextStyle(color = ChanColors.TextPrimary, fontSize = 14.sp),
                        modifier = Modifier.fillMaxWidth(),
                        decorationBox = { inner ->
                            if (input.isEmpty()) Text("Message…", color = ChanColors.TextSecondary, fontSize = 14.sp)
                            inner()
                        },
                    )
                }
                Spacer(Modifier.width(8.dp))
                PillText("Send", onClick = {
                    if (input.isNotBlank()) {
                        onSend(input)
                        input = ""
                        onTypingChange(false)
                    }
                })
            }
        }
    }
}

@Composable
private fun QueuePanel(
    queue: List<QueueItem>,
    canControl: Boolean,
    onAddUrl: (String, String) -> Unit,
    onRemove: (QueueItem) -> Unit,
    onPlayNext: (QueueItem) -> Unit,
    onClose: () -> Unit,
) {
    PanelShell("Queue (${queue.size}/5)", onClose) {
        var url by remember { mutableStateOf("") }
        Column(Modifier.fillMaxSize().padding(8.dp)) {
            if (canControl) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(20.dp))
                            .background(ChanColors.Raised)
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                    ) {
                        BasicTextField(
                            value = url,
                            onValueChange = { url = it },
                            textStyle = TextStyle(color = ChanColors.TextPrimary, fontSize = 14.sp),
                            modifier = Modifier.fillMaxWidth(),
                            decorationBox = { inner ->
                                if (url.isEmpty()) Text("Paste video URL…", color = ChanColors.TextSecondary, fontSize = 14.sp)
                                inner()
                            },
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    PillText("Add", onClick = {
                        val v = url.trim()
                        val looksVideo = v.contains(".mp4") || v.contains(".mkv") || v.contains(".m3u8") || v.contains("/api/proxy")
                        if (v.isNotEmpty() && looksVideo) {
                            onAddUrl(v, "Direct video")
                            url = ""
                        }
                    })
                }
            }
            Spacer(Modifier.height(10.dp))
            if (queue.isEmpty()) {
                Text("Queue is empty — paste a video link above", color = ChanColors.TextSecondary, fontSize = 13.sp)
            } else {
                LazyColumn {
                    items(queue) { item ->
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(ChanColors.Raised)
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(item.title, color = ChanColors.TextPrimary, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("by ${item.addedByName}", color = ChanColors.TextSecondary, fontSize = 11.sp)
                            }
                            if (canControl) PillText("Play") { onPlayNext(item) }
                            PillText("✕") { onRemove(item) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SharePanel(link: String, onClose: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    PanelShell("Share Room", onClose) {
        Column(
            Modifier.fillMaxSize().padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text("Invite friends to watch together", color = ChanColors.TextSecondary, fontSize = 13.sp)
            Spacer(Modifier.height(10.dp))
            Text(
                link,
                color = ChanColors.TextPrimary,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(ChanColors.Raised)
                    .padding(12.dp),
            )
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PillText("Copy link") { clipboard.setText(AnnotatedString(link)) }
                PillText("Share") {
                    val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(android.content.Intent.EXTRA_TEXT, "Join me on Chan: $link")
                    }
                    context.startActivity(android.content.Intent.createChooser(send, "Share room"))
                }
            }
        }
    }
}

@Composable
private fun PanelShell(title: String, onClose: () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .fillMaxHeight(0.85f)
                .clip(RoundedCornerShape(16.dp))
                .background(ChanColors.Surface.copy(alpha = 0.97f))
                .padding(10.dp)
                .imePadding(),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(title, color = ChanColors.TextPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = Modifier.weight(1f))
                PillIcon(Icons.Filled.Close, "Close", onClose)
            }
            Spacer(Modifier.height(6.dp))
            content()
        }
    }
}

// ════════════════════════ Fullscreen ════════════════════════

@Composable
private fun FullscreenLayout(
    player: ManagedPlayer,
    title: String,
    isLive: Boolean,
    onMinimize: () -> Unit,
    onTogglePlay: () -> Unit,
    onSeek: (Long) -> Unit,
    onBrightness: (Float) -> Unit,
) {
    val state by player.state.collectAsState()
    var controlsVisible by remember { mutableStateOf(true) }
    var dragMs by remember { mutableStateOf<Long?>(null) }
    var secondaryOpen by remember { mutableStateOf(true) }
    var speedIdx by remember { mutableIntStateOf(0) }

    LaunchedEffect(controlsVisible, state.isPlaying, state.isBuffering) {
        if (controlsVisible && state.isPlaying && !state.isBuffering) {
            delay(CONTROLS_HIDE_MS)
            controlsVisible = false
        }
    }

    val duration = state.durationMs.coerceAtLeast(1L)
    val position = (dragMs ?: state.positionMs).coerceIn(0L, duration)

    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { controlsVisible = !controlsVisible },
                    onDoubleTap = { offset ->
                        val delta = if (offset.x < size.width / 2f) -10_000L else 10_000L
                        onSeek(state.positionMs + delta)
                    },
                )
            },
    ) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                FrameLayout(ctx).apply {
                    setBackgroundColor(AndroidColor.BLACK)
                    player.attachSurface(this)
                }
            },
            update = { player.attachSurface(it) },
        )

        val cue = player.cueAt(state.positionMs)
        if (cue != null && !cue.isBlank()) {
            Text(
                cue,
                color = Color.White,
                fontSize = 16.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .safeDrawingPadding()
                    .padding(horizontal = 24.dp, vertical = 12.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color.Black.copy(alpha = 0.6f))
                    .padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }

        if (state.isBuffering && state.errorMessage == null) {
            CircularProgressIndicator(
                color = Color.White,
                strokeWidth = 3.dp,
                modifier = Modifier.align(Alignment.Center).size(48.dp),
            )
        }

        if (controlsVisible) {
            Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.25f))) {
                Row(
                    Modifier
                        .align(Alignment.TopCenter)
                        .fillMaxWidth()
                        .safeDrawingPadding()
                        .background(Color.Black.copy(alpha = 0.55f))
                        .padding(horizontal = 6.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    PillIcon(Icons.Filled.ArrowBack, "Minimize", onMinimize)
                    Text(
                        title,
                        color = Color.White,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 15.sp,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
                    )
                    PillText("⤡", onClick = onMinimize, title = "Minimize")
                }

                if (!state.isPlaying) {
                    Box(
                        Modifier
                            .align(Alignment.Center)
                            .size(72.dp)
                            .clip(CircleShape)
                            .background(Color.Black.copy(alpha = 0.5f))
                            .clickable { onTogglePlay() },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Filled.PlayArrow, "Play", tint = Color.White, modifier = Modifier.size(40.dp))
                    }
                }

                Column(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .safeDrawingPadding()
                        .background(Color.Black.copy(alpha = 0.55f))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                ) {
                    if (isLive) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(8.dp).clip(CircleShape).background(ChanColors.Live))
                            Spacer(Modifier.width(6.dp))
                            Text("LIVE", color = ChanColors.Live, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            Spacer(Modifier.weight(1f))
                            PillText("⤡", onClick = onMinimize, title = "Minimize")
                        }
                    } else {
                        dragMs?.let {
                            Text(
                                formatTime(it),
                                color = Color.White,
                                fontWeight = FontWeight.Bold,
                                fontFamily = FontFamily.Monospace,
                                fontSize = 13.sp,
                                modifier = Modifier.align(Alignment.CenterHorizontally),
                            )
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            PillText(if (state.isPlaying) "❚❚" else "▶", onClick = onTogglePlay)
                            Text(formatTime(position), color = Color.White, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                            Slider(
                                value = position.toFloat(),
                                onValueChange = { dragMs = it.toLong() },
                                onValueChangeFinished = { dragMs?.let(onSeek); dragMs = null },
                                valueRange = 0f..duration.toFloat(),
                                modifier = Modifier.weight(1f).padding(horizontal = 6.dp),
                                colors = SliderDefaults.colors(
                                    thumbColor = Color.White,
                                    activeTrackColor = Color.White,
                                    inactiveTrackColor = Color.White.copy(alpha = 0.3f),
                                ),
                            )
                            Text(formatTime(duration), color = Color.White.copy(alpha = 0.8f), fontFamily = FontFamily.Monospace, fontSize = 12.sp)
                            PillText("⤡", onClick = onMinimize, title = "Minimize")
                        }
                        if (secondaryOpen) {
                            Row(
                                Modifier.fillMaxWidth().padding(top = 6.dp),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                PillText("-10s", onClick = { onSeek(state.positionMs - 10_000) })
                                PillText("+10s", onClick = { onSeek(state.positionMs + 10_000) })
                                PillText(formatSpeed(SPEEDS[speedIdx]), onClick = {
                                    speedIdx = (speedIdx + 1) % SPEEDS.size
                                    player.setRate(SPEEDS[speedIdx])
                                })
                                PillText("⌄", onClick = { secondaryOpen = false }, title = "Hide secondary")
                            }
                        }
                    }
                }
            }
        }
    }
}

// ════════════════════════ Shared widgets ════════════════════════

@Composable
fun PillText(text: String, onClick: (() -> Unit)? = null, tint: Color = ChanColors.TextPrimary, title: String? = null) {
    val mod = Modifier
        .clip(RoundedCornerShape(20.dp))
        .background(ChanColors.Raised)
        .padding(horizontal = 12.dp, vertical = 7.dp)
    if (onClick != null) {
        Box(mod.clickable { onClick() }, contentAlignment = Alignment.Center) {
            Text(text, color = tint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
    } else {
        Box(mod, contentAlignment = Alignment.Center) {
            Text(text, color = tint, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
fun PillIcon(icon: androidx.compose.ui.graphics.vector.ImageVector?, label: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(ChanColors.Raised)
            .clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) {
            Icon(icon, label, tint = ChanColors.TextPrimary, modifier = Modifier.size(20.dp))
        } else {
            Text(label, color = ChanColors.TextPrimary, fontSize = 12.sp)
        }
    }
}

@Composable
private fun LiveBadge() {
    Row(
        Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(ChanColors.Live.copy(alpha = 0.15f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(ChanColors.Live))
        Spacer(Modifier.width(5.dp))
        Text("LIVE", color = ChanColors.Live, fontSize = 11.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun TabPill(text: String, active: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(if (active) ChanColors.TextPrimary else ChanColors.Surface)
            .clickable { onClick() }
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Text(
            text,
            color = if (active) ChanColors.Bg else ChanColors.TextSecondary,
            fontSize = 13.sp,
            fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold,
        )
    }
}

private fun formatSpeed(rate: Float): String =
    (if (rate == rate.toLong().toFloat()) rate.toLong().toString() else rate.toString()) + "×"

/** Convert a Firestore map value (headers) to a String→String map. */
private fun stringMap(value: Any?): Map<String, String> {
    if (value !is Map<*, *>) return emptyMap()
    val out = LinkedHashMap<String, String>()
    for ((k, v) in value) if (k != null && v != null) out[k.toString()] = v.toString()
    return out
}

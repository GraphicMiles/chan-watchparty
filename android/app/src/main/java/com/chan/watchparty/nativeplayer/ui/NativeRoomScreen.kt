package com.chan.watchparty.nativeplayer.ui

import android.graphics.Bitmap
import android.graphics.Color as AndroidColor
import android.widget.FrameLayout
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
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
import com.chan.watchparty.nativeplayer.data.FloatingReaction
import com.chan.watchparty.nativeplayer.data.Participant
import com.chan.watchparty.nativeplayer.data.QueueItem
import com.chan.watchparty.nativeplayer.data.RoomRepository
import com.chan.watchparty.nativeplayer.player.ManagedPlayer
import com.chan.watchparty.nativeplayer.player.PlayerState
import com.chan.watchparty.nativeplayer.util.formatTime
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.delay
import kotlin.math.abs

private const val CONTROLS_HIDE_MS = 3500L
private val SPEEDS = floatArrayOf(1f, 1.25f, 1.5f, 2f)
private val BRIGHTNESS_LEVELS = floatArrayOf(1f, 0.75f, 0.5f, 1f)
private val REACTION_EMOJIS = listOf("❤️", "🔥", "😂", "👏", "😮", "💯")

enum class RoomTab { SHARE, QUEUE, CHAT }

/**
 * NativeRoomScreen — the ONE watch room.
 *
 * Mirrors the former web room element-for-element (dark #0A0A0C theme):
 *   1. Room header   — Chan · sync pulse · title (host-editable) · Locked/
 *                      Direct badges · Share/Queue/Chat buttons · End/Leave
 *   2. Room tabs     — Share · Queue (n/5) · Chat (panels render ON TOP of
 *                      the video)
 *   3. Video box     — inline 16:9 native surface, LIVE chip, floating
 *                      reactions, sound-fx banner, CC at top, buffering,
 *                      center play, error+Retry
 *   4. Controls      — transport (play/seek/time/⛶/secondary) + host card
 *                      (Change Video · Share Screen · Queue · Vibe Glow ·
 *                      Lock · Edit Title)
 *   5. Meta bar      — LIVE · n/cap watching · mode · queue · chevron →
 *                      participants list + room info
 *
 * Fullscreen (⛶): video fills the whole screen on top of everything; the
 * icon toggles Maximize ⇄ Minimize; the same in-app controls overlay it.
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
    onLeave: () -> Unit,
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
    val reactions by repo.floatingReactions.collectAsState()
    val soundBanner by repo.soundBanner.collectAsState()

    var activeTab by remember { mutableStateOf<RoomTab?>(null) }
    var fullscreen by remember { mutableStateOf(false) }
    var secondaryOpen by remember { mutableStateOf(true) }
    var detailsOpen by remember { mutableStateOf(false) }
    var showEndConfirm by remember { mutableStateOf(false) }
    var showLeaveConfirm by remember { mutableStateOf(false) }
    var showChangeVideo by remember { mutableStateOf(false) }
    var showEditTitle by remember { mutableStateOf(false) }
    var autoNextDismissed by remember { mutableStateOf(false) }
    var titleDraft by remember { mutableStateOf("") }

    val r = room
    val isHost = r?.hostId == uid
    val isController = isHost || (r?.coHosts?.contains(uid) == true)
    val modeLabel = when {
        r?.videoType == "iptv" || r?.videoType == "sports" -> "Live TV"
        r?.videoType == "youtube" -> "YouTube"
        else -> "Direct Video"
    }

    // ── Playback sync ───────────────────────────────────────────────────
    LaunchedEffect(repo, r?.hostId, player) {
        val p = player ?: return@LaunchedEffect
        while (true) {
            if (isController) {
                repo.writePlayerState(p.positionMs() / 1000.0, p.isPlayingNow())
            } else {
                val vUrl = room?.playableUrl
                if (vUrl != null && vUrl != p.currentUrl()) {
                    val m = room?.media.orEmpty()
                    p.loadNew(
                        vUrl, roomTitle,
                        m["referer"] as? String,
                        stringMap(m["headers"]),
                        m["container"] as? String,
                        m["codec"] as? String,
                        (sync.currentTime * 1000).toLong(),
                    )
                } else {
                    val target = (sync.currentTime * 1000).toLong()
                    if (abs(p.positionMs() - target) > 600) p.seekTo(target)
                    if (sync.isPlaying && !p.isPlayingNow()) p.play()
                    if (!sync.isPlaying && p.isPlayingNow() && sync.updatedBy != uid) p.pause()
                }
            }
            delay(1500)
        }
    }

    LaunchedEffect(fullscreen) { onFullscreenChange(fullscreen) }

    // Auto-next prompt when the video ends and the queue has an item.
    val ended = player?.state?.collectAsState()?.value?.isEnded == true
    val nextItem = queue.firstOrNull()
    val showAutoNext = ended && nextItem != null && !autoNextDismissed

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
        // ══ 1. Room header (web-room style) ══════════════════════════════
        RoomHeader(
            title = roomTitle,
            isHost = isHost,
            locked = r?.locked == true,
            isDirect = r?.videoType != null && r.videoType != "youtube",
            queueCount = queue.size,
            onEditTitle = {
                titleDraft = roomTitle
                showEditTitle = true
            },
            onShare = { activeTab = if (activeTab == RoomTab.SHARE) null else RoomTab.SHARE },
            onQueue = { activeTab = if (activeTab == RoomTab.QUEUE) null else RoomTab.QUEUE },
            onChat = { activeTab = if (activeTab == RoomTab.CHAT) null else RoomTab.CHAT },
            onEnd = { showEndConfirm = true },
            onLeave = { showLeaveConfirm = true },
        )

        // ══ 2. Room tabs ═════════════════════════════════════════════════
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            TabPill("Share", active = activeTab == RoomTab.SHARE) { activeTab = if (activeTab == RoomTab.SHARE) null else RoomTab.SHARE }
            TabPill("Queue (${queue.size}/5)", active = activeTab == RoomTab.QUEUE) { activeTab = if (activeTab == RoomTab.QUEUE) null else RoomTab.QUEUE }
            TabPill("Chat", active = activeTab == RoomTab.CHAT) { activeTab = if (activeTab == RoomTab.CHAT) null else RoomTab.CHAT }
        }

        // ══ 3. Video box + overlay panels ════════════════════════════════
        Box(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(horizontal = 12.dp),
        ) {
            VideoBox(
                player = player,
                isLive = isLive,
                vibeGlow = r?.vibeLighting == true,
                reactions = reactions,
                soundBanner = soundBanner,
                onTogglePlay = { player?.playOrPause() },
                onSeek = { player?.seekTo(it) },
            )

            if (activeTab != null) {
                Box(Modifier.fillMaxSize()) {
                    when (activeTab) {
                        RoomTab.SHARE -> SharePanel(
                            link = repo.shareLink(),
                            inviteCode = r?.inviteCode,
                            onClose = { activeTab = null },
                        )
                        RoomTab.QUEUE -> QueuePanel(
                            queue = queue,
                            canControl = isController,
                            onAddUrl = { url, title -> repo.addToQueue(title, url, null, "direct", null) },
                            onRemove = { repo.removeFromQueue(it.id) },
                            onPlayNext = { repo.playNext(it) },
                            onClose = { activeTab = null },
                        )
                        RoomTab.CHAT -> ChatPanel(
                            messages = messages,
                            typingNames = typing.map { it.second },
                            reactions = reactions,
                            onSendReaction = { emoji -> repo.sendReaction(emoji) },
                            onSend = { repo.sendMessage(it) },
                            onClose = { activeTab = null },
                            onTypingChange = { repo.setTyping(it) },
                            onSummary = { repo.aiSummary() },
                            onCatchup = { repo.aiCatchup() },
                            onQuiz = { repo.aiQuiz() },
                            cooldownSec = repo.aiCooldownSec.collectAsState().value,
                        )
                        null -> {}
                    }
                }
            }
        }

        // ══ 4. Controls ═════════════════════════════════════════════════
        TransportControls(
            player = player,
            isLive = isLive,
            secondaryOpen = secondaryOpen,
            onToggleSecondary = { secondaryOpen = !secondaryOpen },
            fullscreen = fullscreen,
            onToggleFullscreen = { fullscreen = !fullscreen },
            onTogglePip = onTogglePip,
            onBrightness = onBrightness,
        )

        if (isController) {
            HostControlsCard(
                isLive = isLive,
                vibe = r?.vibeLighting == true,
                locked = r?.locked == true,
                queueCount = queue.size,
                onToggleVibe = { repo.setVibeLighting(r?.vibeLighting != true) },
                onToggleLock = { repo.toggleLock(r?.locked != true) },
                onChangeVideo = { showChangeVideo = true },
                onEditTitle = {
                    titleDraft = roomTitle
                    showEditTitle = true
                },
                onOpenQueue = { activeTab = if (activeTab == RoomTab.QUEUE) null else RoomTab.QUEUE },
            )
        }

        // ══ 5. Meta bar + details ════════════════════════════════════════
        MetaBar(
            participantCount = participants.size,
            capacity = r?.capacity ?: 12,
            modeLabel = modeLabel,
            queueCount = queue.size,
            expanded = detailsOpen,
            onToggle = { detailsOpen = !detailsOpen },
        )
        if (detailsOpen) {
            ParticipantsSection(
                participants = participants,
                hostId = r?.hostId ?: "",
                coHosts = r?.coHosts ?: emptyList(),
                uid = uid,
                repo = repo,
            )
            RoomInfoCard(r)
        }
    }

    // ── Dialogs ─────────────────────────────────────────────────────────
    if (showEndConfirm) {
        ConfirmDialog(
            title = "End this room?",
            message = "Ending the room removes it for everyone.",
            confirm = "End Room",
            danger = true,
            onConfirm = {
                showEndConfirm = false
                onEndRoom()
            },
            onDismiss = { showEndConfirm = false },
        )
    }
    if (showLeaveConfirm) {
        ConfirmDialog(
            title = "Leave this room?",
            message = "Your position is saved — you can rejoin anytime.",
            confirm = "Leave",
            danger = true,
            onConfirm = {
                showLeaveConfirm = false
                onLeave()
            },
            onDismiss = { showLeaveConfirm = false },
        )
    }
    if (showAutoNext && nextItem != null) {
        ConfirmDialog(
            title = "Up Next",
            message = "${nextItem.title}\nAdded by ${nextItem.addedByName}",
            confirm = "Play Now",
            danger = false,
            onConfirm = {
                autoNextDismissed = true
                repo.playNext(nextItem)
            },
            onDismiss = { autoNextDismissed = true },
        )
    }
    if (showEditTitle) {
        TextFieldDialog(
            title = "Edit room title",
            value = titleDraft,
            onValueChange = { titleDraft = it },
            onSave = {
                repo.updateTitle(titleDraft)
                showEditTitle = false
            },
            onDismiss = { showEditTitle = false },
        )
    }
    if (showChangeVideo) {
        ChangeVideoDialog(
            onUse = { url, videoType, isLive ->
                repo.changeVideo(url, videoType, isLive)
                showChangeVideo = false
            },
            onDismiss = { showChangeVideo = false },
        )
    }
}

// ════════════════════════ 1. Room header ════════════════════════

@Composable
private fun RoomHeader(
    title: String,
    isHost: Boolean,
    locked: Boolean,
    isDirect: Boolean,
    queueCount: Int,
    onEditTitle: () -> Unit,
    onShare: () -> Unit,
    onQueue: () -> Unit,
    onChat: () -> Unit,
    onEnd: () -> Unit,
    onLeave: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "Chan",
            color = ChanColors.TextPrimary,
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.SansSerif,
            modifier = Modifier.clickable { onLeave() },
        )
        Spacer(Modifier.width(10.dp))
        SyncPulse()
        Spacer(Modifier.width(8.dp))
        Text(
            title,
            color = ChanColors.TextPrimary,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (locked) MiniBadge("Locked", ChanColors.TextSecondary)
        if (isDirect) MiniBadge("Direct", ChanColors.Accent)
        Spacer(Modifier.width(4.dp))
        if (isHost) {
            HeaderIconBtn("✎", "Edit title", onEditTitle)
            HeaderIconBtn("⛔", "End room", onEnd)
        } else {
            HeaderIconBtn("⏻", "Leave", onLeave)
        }
    }
}

@Composable
private fun SyncPulse() {
    var visible by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        while (true) {
            visible = !visible
            delay(900)
        }
    }
    Box(
        Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(if (visible) ChanColors.Success else ChanColors.Success.copy(alpha = 0.3f)),
    )
}

@Composable
private fun MiniBadge(text: String, tint: Color) {
    Text(
        text,
        color = tint,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier
            .padding(start = 6.dp)
            .clip(RoundedCornerShape(20.dp))
            .background(ChanColors.Raised)
            .padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
private fun HeaderIconBtn(label: String, title: String, onClick: () -> Unit) {
    Box(
        Modifier
            .padding(start = 4.dp)
            .size(34.dp)
            .clip(CircleShape)
            .background(ChanColors.Raised)
            .clickable { onClick() },
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = ChanColors.TextPrimary, fontSize = 14.sp)
    }
}

// ════════════════════════ 3. Video box ════════════════════════

@Composable
private fun BoxScope.VideoBox(
    player: ManagedPlayer?,
    isLive: Boolean,
    vibeGlow: Boolean,
    reactions: List<FloatingReaction>,
    soundBanner: String?,
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

    val shape = RoundedCornerShape(14.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(16f / 9f)
            .clip(shape)
            .background(Color.Black)
            .then(
                if (vibeGlow) Modifier.border(2.dp, ChanColors.Success.copy(alpha = 0.8f), shape)
                else Modifier
            )
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
                    player?.attachSurface(this)
                }
            },
            update = { player?.attachSurface(it) },
        )

        // LIVE chip (top-left)
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

        // CC at the top.
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

        // Sound-fx banner (bottom-center).
        if (soundBanner != null) {
            Text(
                soundBanner,
                color = Color.White,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 10.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(Color.Black.copy(alpha = 0.65f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }

        // Floating reactions.
        reactions.forEach { r ->
            val h = r.id.hashCode()
            val left = 10 + (h % 80)
            val top = 25 + (abs(h / 7) % 45)
            Text(
                r.emoji,
                fontSize = 22.sp,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(start = left.dp, top = top.dp)
                    .alpha(0.92f),
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
                PillText("Retry", onClick = { player?.retry() })
            }
        }
    }
}

// ════════════════════════ 4. Controls ════════════════════════

@Composable
private fun TransportControls(
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
        // Main transport bar
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(ChanColors.Surface)
                .border(1.dp, ChanColors.Divider, RoundedCornerShape(12.dp))
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PillText(if (state.isPlaying) "❚❚" else "▶", onClick = { player?.playOrPause() }, title = if (state.isPlaying) "Pause" else "Play")
            Text(formatTime(position), color = ChanColors.TextPrimary, fontFamily = FontFamily.Monospace, fontSize = 12.sp, modifier = Modifier.padding(start = 6.dp))
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
                    .clip(RoundedCornerShape(12.dp))
                    .background(ChanColors.Surface)
                    .border(1.dp, ChanColors.Divider, RoundedCornerShape(12.dp))
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
                    modifier = Modifier.width(80.dp),
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

/** Host/co-host action card — mirrors the web room's controls card. */
@Composable
private fun HostControlsCard(
    isLive: Boolean,
    vibe: Boolean,
    locked: Boolean,
    queueCount: Int,
    onToggleVibe: () -> Unit,
    onToggleLock: () -> Unit,
    onChangeVideo: () -> Unit,
    onEditTitle: () -> Unit,
    onOpenQueue: () -> Unit,
) {
    val context = LocalContext.current
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(ChanColors.Surface)
            .border(1.dp, ChanColors.Divider, RoundedCornerShape(12.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ActionBtn("Change Video", onClick = onChangeVideo)
        ActionBtn("Share Screen", onClick = {
            android.widget.Toast.makeText(context, "Screen share requires a desktop browser", android.widget.Toast.LENGTH_SHORT).show()
        })
        ActionBtn("Queue ($queueCount/5)", onClick = onOpenQueue)
        ActionBtn(if (vibe) "Vibe Glow: On" else "Vibe Glow: Off", onClick = onToggleVibe)
        ActionBtn(if (locked) "Unlock Room" else "Lock Room", onClick = onToggleLock)
        ActionBtn("Edit Title", onClick = onEditTitle)
    }
}

@Composable
private fun ActionBtn(text: String, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(10.dp))
            .background(ChanColors.Raised)
            .border(1.dp, ChanColors.Divider, RoundedCornerShape(10.dp))
            .clickable { onClick() }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = ChanColors.TextPrimary, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
    }
}

// ════════════════════════ 5. Meta bar + details ════════════════════════

@Composable
private fun MetaBar(
    participantCount: Int,
    capacity: Int,
    modeLabel: String,
    queueCount: Int,
    expanded: Boolean,
    onToggle: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(ChanColors.Surface)
            .border(1.dp, ChanColors.Divider, RoundedCornerShape(12.dp))
            .clickable { onToggle() }
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
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
        Spacer(Modifier.width(10.dp))
        MetaText("$participantCount/$capacity watching")
        MetaSep()
        MetaText(modeLabel)
        if (queueCount > 0) {
            MetaSep()
            MetaText("Queue: $queueCount waiting")
        }
        Spacer(Modifier.weight(1f))
        Text(if (expanded) "⌃" else "⌄", color = ChanColors.TextSecondary, fontSize = 16.sp)
    }
}

@Composable
private fun MetaText(text: String) {
    Text(text, color = ChanColors.TextSecondary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
}

@Composable
private fun MetaSep() {
    Text("·", color = ChanColors.TextSecondary, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 6.dp))
}

@Composable
private fun ParticipantsSection(
    participants: List<Participant>,
    hostId: String,
    coHosts: List<String>,
    uid: String,
    repo: RoomRepository,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(ChanColors.Surface)
            .border(1.dp, ChanColors.Divider, RoundedCornerShape(12.dp))
            .padding(8.dp),
    ) {
        participants.forEach { p ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 6.dp),
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
                    p.uid == hostId -> MiniBadge("Host", ChanColors.Accent)
                    coHosts.contains(p.uid) -> MiniBadge("Co-host", ChanColors.Accent)
                }
                if (p.muted) MiniBadge("Muted", ChanColors.TextSecondary)
                if (hostId == uid && p.uid != uid) {
                    ActionBtn("Kick") { repo.kick(p.uid) {} }
                    Spacer(Modifier.width(4.dp))
                    ActionBtn(if (coHosts.contains(p.uid)) "Demote" else "Promote") {
                        repo.promote(p.uid, if (coHosts.contains(p.uid)) "viewer" else "co-host") {}
                    }
                    Spacer(Modifier.width(4.dp))
                    ActionBtn(if (p.muted) "Unmute" else "Mute") { repo.mute(p.uid, !p.muted) {} }
                }
            }
        }
        if (participants.isEmpty()) {
            Text("No participants yet", color = ChanColors.TextSecondary, fontSize = 13.sp)
        }
    }
}

@Composable
private fun RoomInfoCard(r: com.chan.watchparty.nativeplayer.data.RoomData?) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(ChanColors.Surface)
            .border(1.dp, ChanColors.Divider, RoundedCornerShape(12.dp))
            .padding(12.dp),
    ) {
        Text("Room Info", color = ChanColors.TextPrimary, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        Spacer(Modifier.height(6.dp))
        r?.let { room ->
            InfoLine("Host", room.hostName)
            InfoLine("Capacity", "${room.participantCount}/${room.capacity}")
            InfoLine("Mode", room.videoType)
            if (room.isPrivate) InfoLine("Invite", room.inviteCode)
            if (room.locked) InfoLine("Joins", "Locked")
        }
    }
}

@Composable
private fun InfoLine(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
        Text(label, color = ChanColors.TextSecondary, fontSize = 13.sp, modifier = Modifier.width(90.dp))
        Text(value, color = ChanColors.TextPrimary, fontSize = 13.sp)
    }
}

// ════════════════════════ Panels (on top of video) ════════════════════════

@Composable
private fun ChatPanel(
    messages: List<ChatMessage>,
    typingNames: List<String>,
    reactions: List<FloatingReaction>,
    onSendReaction: (String) -> Unit,
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
            // Reaction row + sound fx
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    REACTION_EMOJIS.forEach { emoji ->
                        Box(
                            Modifier
                                .clip(RoundedCornerShape(20.dp))
                                .background(ChanColors.Raised)
                                .clickable { onSendReaction(emoji) }
                                .padding(horizontal = 8.dp, vertical = 5.dp),
                        ) { Text(emoji, fontSize = 14.sp) }
                    }
                }
                PillText("🔊", onClick = onSendReaction.let { { onSendReaction("🔊") } }, title = "Sound effects")
            }
            Spacer(Modifier.height(8.dp))
            // AI tools row
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                PillText(if (cooldownSec > 0) "${cooldownSec / 60}m" else "Summary", onClick = onSummary)
                PillText("Catch Up", onClick = onCatchup)
                PillText("Quiz", onClick = onQuiz)
            }
            Spacer(Modifier.height(8.dp))
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f),
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
                                if (url.isEmpty()) Text("Paste video URL (mp4/m3u8/mkv)…", color = ChanColors.TextSecondary, fontSize = 14.sp)
                                inner()
                            },
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    PillText("Add", onClick = {
                        val v = url.trim()
                        val looksVideo = v.contains(".mp4") || v.contains(".mkv") || v.contains(".m3u8") || v.contains(".webm") || v.startsWith("http")
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
                            Spacer(Modifier.width(6.dp))
                            PillText("✕") { onRemove(item) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SharePanel(link: String, inviteCode: String?, onClose: () -> Unit) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val qr = remember(link) { qrBitmap(link) }
    PanelShell("Share Room", onClose) {
        Column(
            Modifier.fillMaxSize().padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            if (qr != null) {
                Image(
                    bitmap = qr.asImageBitmap(),
                    contentDescription = "QR code",
                    modifier = Modifier.size(170.dp).clip(RoundedCornerShape(10.dp)),
                )
            }
            Spacer(Modifier.height(12.dp))
            Text(
                link,
                color = ChanColors.TextPrimary,
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(ChanColors.Raised)
                    .padding(10.dp),
            )
            if (!inviteCode.isNullOrBlank()) {
                Spacer(Modifier.height(8.dp))
                Text("Invite code: $inviteCode", color = ChanColors.TextSecondary, fontSize = 13.sp)
            }
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
                .background(ChanColors.Surface.copy(alpha = 0.98f))
                .border(1.dp, ChanColors.Divider, RoundedCornerShape(16.dp))
                .padding(10.dp)
                .imePadding(),
        ) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(title, color = ChanColors.TextPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = Modifier.weight(1f))
                HeaderIconBtn("✕", "Close", onClose)
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
                    HeaderIconBtn("←", "Minimize", onMinimize)
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
                        }
                    }
                }
            }
        }
    }
}

// ════════════════════════ Dialogs ════════════════════════

@Composable
private fun ConfirmDialog(
    title: String,
    message: String,
    confirm: String,
    danger: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    DialogShell(onDismiss) {
        Text(title, color = ChanColors.TextPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Spacer(Modifier.height(10.dp))
        Text(message, color = ChanColors.TextSecondary, fontSize = 14.sp, lineHeight = 20.sp)
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PillText("Cancel", onClick = onDismiss)
            Spacer(Modifier.weight(1f))
            PillText(confirm, tint = if (danger) ChanColors.Danger else ChanColors.TextPrimary, onClick = onConfirm)
        }
    }
}

@Composable
private fun TextFieldDialog(
    title: String,
    value: String,
    onValueChange: (String) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    DialogShell(onDismiss) {
        Text(title, color = ChanColors.TextPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Spacer(Modifier.height(12.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(ChanColors.Raised)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value = value,
                onValueChange = { onValueChange(it.take(80)) },
                textStyle = TextStyle(color = ChanColors.TextPrimary, fontSize = 14.sp),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PillText("Cancel", onClick = onDismiss)
            Spacer(Modifier.weight(1f))
            PillText("Save", onClick = onSave)
        }
    }
}

@Composable
private fun ChangeVideoDialog(
    onUse: (url: String, videoType: String, isLive: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    var url by remember { mutableStateOf("") }
    DialogShell(onDismiss) {
        Text("Change Video", color = ChanColors.TextPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Spacer(Modifier.height(6.dp))
        Text("Paste a direct stream link (.mp4 / .m3u8 / .mkv)", color = ChanColors.TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(12.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(ChanColors.Raised)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            BasicTextField(
                value = url,
                onValueChange = { url = it },
                textStyle = TextStyle(color = ChanColors.TextPrimary, fontSize = 14.sp),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { inner ->
                    if (url.isEmpty()) Text("https://…", color = ChanColors.TextSecondary, fontSize = 14.sp)
                    inner()
                },
            )
        }
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PillText("Cancel", onClick = onDismiss)
            Spacer(Modifier.weight(1f))
            PillText("Use link", onClick = {
                val v = url.trim()
                if (v.isNotEmpty() && (v.startsWith("http://") || v.startsWith("https://"))) {
                    val isM3u8 = v.contains(".m3u8")
                    val isLiveStream = isM3u8
                    onUse(v, if (isM3u8) "iptv" else "direct", isLiveStream)
                }
            })
        }
    }
}

@Composable
private fun DialogShell(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.6f))
            .clickable { onDismiss() },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .padding(24.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(ChanColors.Surface)
                .border(1.dp, ChanColors.Divider, RoundedCornerShape(16.dp))
                .clickable(enabled = false) { }
                .padding(18.dp),
        ) {
            content()
        }
    }
}

// ════════════════════════ Shared widgets ════════════════════════

@Composable
fun PillText(text: String, tint: Color = ChanColors.TextPrimary, title: String? = null, onClick: (() -> Unit)? = null) {
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
private fun TabPill(text: String, active: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(if (active) ChanColors.TextPrimary else ChanColors.Surface)
            .border(1.dp, if (active) ChanColors.TextPrimary else ChanColors.Divider, RoundedCornerShape(20.dp))
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

/** Generate a QR bitmap (zxing) for the share panel. */
private fun qrBitmap(content: String, size: Int = 480): Bitmap? {
    return try {
        val hints = mapOf(EncodeHintType.MARGIN to 1)
        val matrix = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size, hints)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        for (x in 0 until size) {
            for (y in 0 until size) {
                bmp.setPixel(x, y, if (matrix.get(x, y)) AndroidColor.BLACK else AndroidColor.WHITE)
            }
        }
        bmp
    } catch (_: Exception) {
        null
    }
}

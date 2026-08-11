package com.chan.watchparty.nativeplayer.ui

import android.graphics.Color as AndroidColor
import android.widget.FrameLayout
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.chan.watchparty.nativeplayer.player.ManagedPlayer
import com.chan.watchparty.nativeplayer.player.PlayerState
import com.chan.watchparty.nativeplayer.util.formatTime
import kotlinx.coroutines.delay

private const val CONTROLS_HIDE_DELAY_MS = 3500L
private const val SEEK_STEP_MS = 10_000L
private val SPEED_PRESETS = floatArrayOf(1f, 1.25f, 1.5f, 2f)

/**
 * RoomPlayerScreen — the native room player UI.
 *
 * Layout (top → bottom):
 *   • Video surface fills the screen edge-to-edge (behind system bars).
 *   • Buffering indicator + error card float above it.
 *   • Controls overlay (top bar / center play / bottom bar) respects system
 *     + display-cutout insets via [safeDrawingPadding] so nothing is ever
 *     under the status bar, gesture bar, or a camera cutout — portrait or
 *     landscape.
 *
 * Gestures:
 *   • Single tap on the video → toggle controls.
 *   • Double-tap left/right half → seek −10s / +10s.
 *   • Drag the slider → scrub with a live time preview.
 *
 * PiP: when [pipMode] is true only the surface is drawn (no chrome).
 */
@Composable
fun RoomPlayerScreen(
    player: ManagedPlayer,
    title: String,
    isLive: Boolean,
    pipMode: Boolean,
    onBack: () -> Unit,
    onTogglePip: () -> Unit,
    onToggleFullscreen: () -> Unit,
) {
    val state by player.state.collectAsStateWithLifecycle()
    var controlsVisible by remember { mutableStateOf(true) }
    var speedIndex by remember { mutableStateOf(0) }

    // Auto-hide the chrome while playing; keep it up when paused/buffering.
    LaunchedEffect(controlsVisible, state.isPlaying, state.isBuffering) {
        if (controlsVisible && state.isPlaying && !state.isBuffering) {
            delay(CONTROLS_HIDE_DELAY_MS)
            controlsVisible = false
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .pointerInput(Unit) {
                detectTapGestures(
                    onTap = { controlsVisible = !controlsVisible },
                    onDoubleTap = { offset ->
                        val target = if (offset.x < size.width / 2f) {
                            -SEEK_STEP_MS
                        } else {
                            SEEK_STEP_MS
                        }
                        player.seekTo(state.positionMs + target)
                    },
                )
            },
    ) {
        // ── Video surface (ExoPlayer ⇄ libVLC) ──
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

        // ── Buffering indicator ──
        AnimatedVisibility(
            visible = state.isBuffering && !pipMode && state.errorMessage == null,
            enter = fadeIn(tween(150)),
            exit = fadeOut(tween(150)),
            modifier = Modifier.align(Alignment.Center),
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                CircularProgressIndicator(color = Color.White, strokeWidth = 3.dp)
                if (state.bufferingPercent > 0) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = "${state.bufferingPercent}%",
                        color = Color.White.copy(alpha = 0.9f),
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
        }

        // ── Error card (retry / close) ──
        state.errorMessage?.let { message ->
            ErrorCard(
                message = message,
                onRetry = { player.retry() },
                onClose = onBack,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(24.dp),
            )
        }

        // ── Controls overlay ──
        if (!pipMode) {
            AnimatedVisibility(
                visible = controlsVisible && state.errorMessage == null,
                enter = fadeIn(tween(200)),
                exit = fadeOut(tween(200)),
            ) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(alpha = 0.22f)),
                ) {
                    PlayerTopBar(
                        title = title,
                        onBack = onBack,
                        onTogglePip = onTogglePip,
                        modifier = Modifier
                            .align(Alignment.TopCenter)
                            .safeDrawingPadding(),
                    )
                    PlayerCenterControls(
                        isPlaying = state.isPlaying,
                        onTogglePlay = { player.playOrPause() },
                        modifier = Modifier.align(Alignment.Center),
                    )
                    PlayerBottomBar(
                        state = state,
                        isLive = isLive,
                        speedLabel = formatSpeed(SPEED_PRESETS[speedIndex]),
                        onSpeedCycle = {
                            speedIndex = (speedIndex + 1) % SPEED_PRESETS.size
                            player.setRate(SPEED_PRESETS[speedIndex])
                        },
                        onSeek = { player.seekTo(it) },
                        onToggleFullscreen = onToggleFullscreen,
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .safeDrawingPadding(),
                    )
                }
            }
        }
    }
}

// ─────────────────────────── Top bar ────────────────────────────────────

@Composable
private fun PlayerTopBar(
    title: String,
    onBack: () -> Unit,
    onTogglePip: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(Color.Black.copy(alpha = 0.55f))
            .padding(horizontal = 4.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onBack) {
            Icon(
                imageVector = Icons.Filled.ArrowBack,
                contentDescription = "Back to room",
                tint = Color.White,
            )
        }
        Text(
            text = title,
            color = Color.White,
            style = MaterialTheme.typography.titleMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 8.dp),
        )
        TextButton(onClick = onTogglePip) {
            Text("PiP", color = Color.White)
        }
    }
}

// ─────────────────────── Center play / pause ────────────────────────────

@Composable
private fun PlayerCenterControls(
    isPlaying: Boolean,
    onTogglePlay: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(76.dp)
            .background(Color.Black.copy(alpha = 0.45f), CircleShape)
            .clickable { onTogglePlay() },
        contentAlignment = Alignment.Center,
    ) {
        if (isPlaying) {
            // Pause glyph drawn directly (Icons.Filled.Pause lives in the large
            // material-icons-extended artifact — not worth the APK weight).
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(
                    Modifier
                        .size(width = 9.dp, height = 28.dp)
                        .background(Color.White, CircleShape)
                )
                Box(
                    Modifier
                        .size(width = 9.dp, height = 28.dp)
                        .background(Color.White, CircleShape)
                )
            }
        } else {
            Icon(
                imageVector = Icons.Filled.PlayArrow,
                contentDescription = "Play",
                tint = Color.White,
                modifier = Modifier.size(44.dp),
            )
        }
    }
}

// ─────────────────────────── Bottom bar ─────────────────────────────────

@Composable
private fun PlayerBottomBar(
    state: PlayerState,
    isLive: Boolean,
    speedLabel: String,
    onSpeedCycle: () -> Unit,
    onSeek: (Long) -> Unit,
    onToggleFullscreen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var dragPositionMs by remember { mutableStateOf<Long?>(null) }
    val duration = state.durationMs.coerceAtLeast(1L)
    val position = (dragPositionMs ?: state.positionMs).coerceIn(0L, duration)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Color.Black.copy(alpha = 0.55f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        if (isLive) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier
                        .size(8.dp)
                        .background(Color(0xFFFF4D4D), CircleShape),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text = "LIVE",
                    color = Color(0xFFFF4D4D),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                )
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onSpeedCycle) {
                    Text("$speedLabel×", color = Color.White)
                }
                TextButton(onClick = onToggleFullscreen) {
                    Text("⛶", color = Color.White)
                }
            }
        } else {
            // Scrub preview while dragging
            dragPositionMs?.let { dragMs ->
                Text(
                    text = formatTime(dragMs),
                    color = Color.White,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = formatTime(position),
                    color = Color.White,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                Slider(
                    value = position.toFloat(),
                    onValueChange = { dragPositionMs = it.toLong() },
                    onValueChangeFinished = {
                        dragPositionMs?.let(onSeek)
                        dragPositionMs = null
                    },
                    valueRange = 0f..duration.toFloat(),
                    modifier = Modifier.weight(1f),
                    colors = SliderDefaults.colors(
                        thumbColor = Color.White,
                        activeTrackColor = Color.White,
                        inactiveTrackColor = Color.White.copy(alpha = 0.3f),
                    ),
                )
                Text(
                    text = formatTime(duration),
                    color = Color.White,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                TextButton(onClick = onSpeedCycle) {
                    Text("$speedLabel×", color = Color.White)
                }
                TextButton(onClick = onToggleFullscreen) {
                    Text("⛶", color = Color.White)
                }
            }
        }
    }
}

// ─────────────────────────── Error card ─────────────────────────────────

@Composable
private fun ErrorCard(
    message: String,
    onRetry: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(containerColor = Color(0xE6121214)),
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "Playback problem",
                color = Color.White,
                style = MaterialTheme.typography.titleMedium,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = message,
                color = Color.White.copy(alpha = 0.85f),
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = onRetry) { Text("Retry") }
                TextButton(onClick = onClose) { Text("Close") }
            }
        }
    }
}

private fun formatSpeed(rate: Float): String =
    if (rate == rate.toLong().toFloat()) rate.toLong().toString() else rate.toString()

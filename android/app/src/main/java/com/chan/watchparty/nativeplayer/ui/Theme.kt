package com.chan.watchparty.nativeplayer.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * Chan in-app design tokens — matches the app's web theme exactly
 * (src/styles/theme.css) so the native room looks like the former room:
 *   --room-bg: #0A0A0C  --room-surface: #141417  --room-surface-raised: #1B1B1F
 *   --room-divider: #232329  --room-text-primary: #F5F5F7  --room-text-secondary: #A6A6B0
 *   --accent-orange: #F5F5F7  --radius-card: 10px
 */
object ChanColors {
    val Bg = Color(0xFF0A0A0C)
    val Surface = Color(0xFF141417)
    val Raised = Color(0xFF1B1B1F)
    val Divider = Color(0xFF232329)
    val TextPrimary = Color(0xFFF5F5F7)
    val TextSecondary = Color(0xFFA6A6B0)
    val Accent = Color(0xFFF5F5F7)
    val Danger = Color(0xFFFF5A4F)
    val Live = Color(0xFFFF4D4D)
    val Success = Color(0xFF00E699)
}

private val ChanColorScheme = darkColorScheme(
    primary = ChanColors.TextPrimary,
    onPrimary = ChanColors.Bg,
    secondary = ChanColors.TextSecondary,
    background = ChanColors.Bg,
    surface = ChanColors.Surface,
    onBackground = ChanColors.TextPrimary,
    onSurface = ChanColors.TextPrimary,
    error = ChanColors.Danger,
)

@Composable
fun ChanNativeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = ChanColorScheme, content = content)
}

package com.chan.watchparty.nativeplayer.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Chan in-app design tokens, ported to Material3. */
object ChanColors {
    val Bg = Color(0xFF050505)
    val Surface = Color(0xFF121214)
    val Raised = Color(0xFF1A1A1C)
    val Hairline = Color(0x1AFFFFFF) // ~10% white
    val TextPrimary = Color(0xFFF4F1EA)
    val TextSecondary = Color(0xFF9A9AA0)
    val Accent = Color(0xFFFF6A2B)
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

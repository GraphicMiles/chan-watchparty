package com.chan.watchparty.nativeplayer.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Chan's monochrome-on-black look, ported to Material3. */
private val ChanColorScheme = darkColorScheme(
    primary = Color(0xFFF4F1EA),
    onPrimary = Color(0xFF050505),
    secondary = Color(0xFF9A9AA0),
    background = Color.Black,
    surface = Color(0xFF121214),
    onBackground = Color(0xFFF4F1EA),
    onSurface = Color(0xFFF4F1EA),
    error = Color(0xFFFF5A4F),
)

@Composable
fun ChanNativeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = ChanColorScheme, content = content)
}

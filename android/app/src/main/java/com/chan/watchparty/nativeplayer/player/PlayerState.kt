package com.chan.watchparty.nativeplayer.player

/**
 * Immutable playback state pushed to the Compose UI via StateFlow.
 * Updated on the main thread only (engine callbacks are marshalled).
 */
data class PlayerState(
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val isPlaying: Boolean = false,
    val isBuffering: Boolean = false,
    val bufferingPercent: Int = 0,
    val isEnded: Boolean = false,
    /** "exo" | "vlc" | "" (not started) */
    val engineName: String = "",
    val errorMessage: String? = null,
    /** "expired" | "network" | "decode" | "other" — maps to friendly copy in UI */
    val errorKind: String = "other",
)

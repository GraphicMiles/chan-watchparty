import { registerPlugin } from '@capacitor/core'

export interface ShowEmbeddedOptions {
  url: string
  title?: string
  startSeconds?: number
  referer?: string
  /** Extra headers from the stream descriptor (merged over UA/Referer). */
  headers?: Record<string, string>
  /** Container hint from the descriptor: mkv | mp4 | hls | unknown. */
  container?: string
  /** Codec hint from the descriptor: e.g. "hevc+aac", "avc+aac", null. */
  codec?: string | null
  /** Hide native chrome; the app's own control bar drives playback. */
  controls?: boolean
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface PlayerPosition {
  positionMs: number
  durationMs: number
  isPlaying: boolean
}

export interface CloseResult {
  positionMs?: number
  durationMs?: number
  ended?: boolean
  wasPlaying?: boolean
}

export type ErrorKind = 'expired' | 'network' | 'decode' | 'other'

export interface ProbeResult {
  ok: boolean
  status?: number
  contentType?: string
  ranged?: boolean
  error?: string
}

export type PlaybackStateEvent =
  | { state: 'ready' }
  | { state: 'buffering'; percent: number }
  | { state: 'playing' }
  | { state: 'paused' }
  | { state: 'ended' }
  | { state: 'error'; message: string; kind: ErrorKind }
  | { state: 'engine'; engine: string }

export type ControlsEvent = { type: 'tap' }

export interface VideoTrack {
  id: number
  height: number
  width: number
  bitrate: number
  description: string
}

export interface VideoEffects {
  /** multipliers ~1.0 neutral */
  brightness: number
  contrast: number
  saturation: number
  /** degrees, 0 neutral */
  hue: number
}

export interface NativeRoomOptions {
  /** Room credentials — the native room reads everything from Firestore. */
  roomId: string
  uid: string
  displayName?: string
  idToken: string
  projectId: string
  apiKey?: string
  apiBase?: string
  /** Resume position (playerState.currentTime). */
  startSeconds?: number
}

export interface NativeRoomResult {
  positionMs?: number
  durationMs?: number
  ended?: boolean
  wasPlaying?: boolean
}

export interface VideoPlayerPlugin {
  /** Show the embedded native player over the room stage. */
  showEmbedded(options: ShowEmbeddedOptions): Promise<void>
  /**
   * Option B: launch the fully-native room player (NativeRoomActivity).
   * The web room stays mounted underneath; the activity returns the playback
   * result through the 'nativeRoomResult' listener when it closes.
   */
  openNativeRoom(options: NativeRoomOptions): Promise<void>
  /** Result of a closed NativeRoomActivity. */
  addListener(
    eventName: 'nativeRoomResult',
    handler: (event: NativeRoomResult) => void
  ): Promise<{ remove: () => void }>
  /** Apply brightness/contrast/saturation/hue to the active native engine. */
  setVideoEffects(options: VideoEffects): Promise<void>
  /** Attach a VTT subtitle track (empty detaches). */
  setSubtitles(options: { vttText: string }): Promise<void>
  /** Enumerate native video tracks for the quality menu. */
  getVideoTracks(): Promise<{ tracks: VideoTrack[] }>
  /** Select quality: auto, or a specific track id / max height. */
  setVideoQuality(options: { auto: boolean; trackId?: number; height?: number }): Promise<void>
  /** Hide/show the native surface (panels must render above it). */
  setVisible(options: { visible: boolean }): Promise<void>
  /** Position the native surface (px on screen). */
  setRect(rect: Rect): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seekTo(options: { positionMs: number }): Promise<void>
  /** Real engine volume 0..1. */
  setVolume(options: { volume: number }): Promise<void>
  getPosition(): Promise<PlayerPosition>
  setFullscreen(options: { fullscreen: boolean }): Promise<void>
  /** Enter Android Picture-in-Picture (from the app's control bar). */
  enterPip(): Promise<void>
  /** Update the native overlay status text (used during recovery). */
  showStatus(options: { text: string }): Promise<void>
  /** Quick range probe of a media URL to classify failures. */
  probeStatus(options: { url: string; referer?: string }): Promise<ProbeResult>
  /** Close the embedded player; resolves with the playback result. */
  closeEmbedded(): Promise<CloseResult>
  /** Subscribe to playback state events. */
  addListener(
    eventName: 'playbackState',
    handler: (event: PlaybackStateEvent) => void
  ): Promise<{ remove: () => void }>
  /** Subscribe to control-surface events (e.g. tap on the video surface). */
  addListener(
    eventName: 'controlsEvent',
    handler: (event: ControlsEvent) => void
  ): Promise<{ remove: () => void }>
}

export const VideoPlayerPlugin = registerPlugin<VideoPlayerPlugin>('VideoPlayerPlugin')

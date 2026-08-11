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

export interface VideoPlayerPlugin {
  /** Show the embedded native player over the room stage. */
  showEmbedded(options: ShowEmbeddedOptions): Promise<void>
  /** Position the native surface (px on screen). */
  setRect(rect: Rect): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seekTo(options: { positionMs: number }): Promise<void>
  setVolume(options: { volume: number }): Promise<void>
  getPosition(): Promise<PlayerPosition>
  setFullscreen(options: { fullscreen: boolean }): Promise<void>
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
}

export const VideoPlayerPlugin = registerPlugin<VideoPlayerPlugin>('VideoPlayerPlugin')

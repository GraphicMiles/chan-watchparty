import { registerPlugin } from '@capacitor/core'

export interface ShowEmbeddedOptions {
  url: string
  title?: string
  startSeconds?: number
  referer?: string
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

export type PlaybackStateEvent =
  | { state: 'ready' }
  | { state: 'buffering'; percent: number }
  | { state: 'playing' }
  | { state: 'paused' }
  | { state: 'ended' }
  | { state: 'error'; message: string }
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
  /** Close the embedded player; resolves with the playback result. */
  closeEmbedded(): Promise<CloseResult>
  /** Subscribe to playback state events. */
  addListener(
    eventName: 'playbackState',
    handler: (event: PlaybackStateEvent) => void
  ): Promise<{ remove: () => void }>
}

export const VideoPlayerPlugin = registerPlugin<VideoPlayerPlugin>('VideoPlayerPlugin')

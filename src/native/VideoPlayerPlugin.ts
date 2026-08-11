import { registerPlugin } from '@capacitor/core'

export interface NativeVideoPlayerOptions {
  url: string
  title?: string
  startSeconds?: number
  referer?: string
}

export interface NativeVideoPlayerResult {
  /** Playback position (ms) when the player closed. */
  positionMs?: number
  /** Total duration (ms), 0 if unknown. */
  durationMs?: number
  /** True if the video reached the end inside the native player. */
  ended?: boolean
  /** True if playback was in progress when the player closed. */
  wasPlaying?: boolean
}

export interface VideoPlayerPlugin {
  /** Open the native in-app player; resolves with the playback result on close. */
  openNative(options: NativeVideoPlayerOptions): Promise<NativeVideoPlayerResult>
}

export const VideoPlayerPlugin = registerPlugin<VideoPlayerPlugin>('VideoPlayerPlugin')

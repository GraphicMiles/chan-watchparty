import { registerPlugin } from '@capacitor/core'

export interface NativeVideoPlayerOptions {
  url: string
  title?: string
  startSeconds?: number
  referer?: string
}

export interface VideoPlayerPlugin {
  openNative(options: NativeVideoPlayerOptions): Promise<void>
}

export const VideoPlayerPlugin = registerPlugin<VideoPlayerPlugin>('VideoPlayerPlugin')

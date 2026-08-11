import { Capacitor } from '@capacitor/core'
import { VideoPlayerPlugin } from '../../native/VideoPlayerPlugin'

/**
 * Native room bridge (Option B).
 *
 * On Android, non-YouTube content plays in the fully-native room player
 * (NativeRoomActivity — Compose + Media3/VLC). The web room stays mounted
 * underneath and resumes from the returned position when the native screen
 * closes, so nothing ever plays twice.
 *
 * Opt out at runtime (e.g. for debugging): localStorage 'chan:forceWebRoom' = '1'
 */

export function isNativeRoomSupported() {
  if (!Capacitor.isNativePlatform()) return false
  if (Capacitor.getPlatform() !== 'android') return false
  try {
    return window.localStorage.getItem('chan:forceWebRoom') !== '1'
  } catch {
    return true
  }
}

export async function launchNativeRoom(options) {
  await VideoPlayerPlugin.openNativeRoom(options)
}

/** Subscribe to the native room result; returns a handle with remove(). */
export function onNativeRoomResult(handler) {
  return VideoPlayerPlugin.addListener('nativeRoomResult', handler)
}

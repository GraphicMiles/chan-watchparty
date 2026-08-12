import { Capacitor } from '@capacitor/core'
import { VideoPlayerPlugin } from '../../native/VideoPlayerPlugin'

/**
 * Native room bridge.
 *
 * The watch room is NATIVE on Android for everything except YouTube. The web
 * room page acts as the launch shell: it joins the room (keeps the seat warm
 * + host heartbeat), hands the room credentials to NativeRoomActivity, and
 * stays mounted underneath. When the native room closes, the web shell
 * freezes the returned position and offers to reopen or use the web player.
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

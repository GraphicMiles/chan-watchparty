# Chan — Android Build Guide

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Build the web app and sync to Android
npm run android:build

# 3. Open in Android Studio (to build APK/AAB and run on device)
npm run android:open
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run android:build` | Build web assets + sync to Android |
| `npm run android:open` | Open project in Android Studio |
| `npm run android:run` | Build, sync, and run on connected device |
| `npm run android:studio` | Alias for opening Android Studio |

## Architecture

- **Capacitor 8** wraps the Vite-built React app in a native Android WebView
- **Native Plugins**: StatusBar, SplashScreen, ScreenOrientation, Keyboard, App, Haptics, Network, Preferences
- **MKV Playback**: Server-side remux (MKV → fMP4) with VLC-compatible codec support:
  - Video: H.264, H.265/HEVC, VP8, VP9, AV1
  - Audio: AAC, MP3, Opus, Vorbis, AC3, EAC3, FLAC, DTS

## Android Configuration

- **Package**: `com.chan.watchparty`
- **Min SDK**: 23 (Android 6.0)
- **Target SDK**: 34 (Android 14)
- **Theme**: Dark (#0a0a0f background, #FF6A2B accent)
- **Features**:
  - Picture-in-Picture support
  - Deep linking for room invites
  - Safe-area insets for notch devices
  - Wake lock during video playback
  - Hardware-accelerated WebView
  - Large heap allocation for video buffering
  - Mixed content allowed (HTTP streams proxied through HTTPS)

## Building Release APK

1. Open `android/` in Android Studio
2. Build → Generate Signed Bundle / APK
3. Choose APK
4. Create or select keystore
5. Select `release` build variant
6. Build

## Debugging

```bash
# View logs from connected device
adb logcat -s Capacitor/

# Or filter for the app
adb logcat | grep -i chan
```

Enable web debugging in `capacitor.config.json`:
```json
{
  "android": {
    "webContentsDebuggingEnabled": true
  }
}
```

Then use Chrome DevTools: `chrome://inspect/#devices`

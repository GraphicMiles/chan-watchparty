import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// ─── Capacitor / Android Native Bridge ───────────────────────────────────────
// When running inside a Capacitor Android shell, initialise native plugins
// (status bar, splash screen, safe-area insets) before mounting the React tree.
async function bootstrapNative() {
  try {
    const { Capacitor } = await import('@capacitor/core')
    if (Capacitor.isNativePlatform()) {
      const { SplashScreen } = await import('@capacitor/splash-screen')
      const { StatusBar, Style } = await import('@capacitor/status-bar')
      const { ScreenOrientation } = await import('@capacitor/screen-orientation')
      const { Keyboard } = await import('@capacitor/keyboard')
      const { App: NativeApp } = await import('@capacitor/app')

      // Dark status bar to match app theme
      try {
        await StatusBar.setStyle({ style: Style.Dark })
        await StatusBar.setBackgroundColor({ color: '#0a0a0f' })
        await StatusBar.setOverlaysWebView({ overlay: true })
      } catch { /* non-critical */ }

      // Lock to portrait on phones (landscape auto-enabled for video player via CSS)
      try {
        await ScreenOrientation.lock({ orientation: 'portrait' })
      } catch { /* unsupported on some devices */ }

      // Keyboard resize behaviour
      try {
        await Keyboard.setResizeMode({ mode: 'body' })
      } catch { /* */ }

      // Handle Android back button
      try {
        NativeApp.addListener('backButton', ({ canGoBack }) => {
          // If we are on a video player page and the video is fullscreen, exit fullscreen
          const fsElement = document.fullscreenElement || document.webkitFullscreenElement
          if (fsElement) {
            if (document.exitFullscreen) document.exitFullscreen()
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen()
            return
          }
          // Otherwise let the router handle back navigation
          if (canGoBack) {
            window.history.back()
          } else {
            // On root screen — minimise app instead of closing
            NativeApp.minimizeApp()
          }
        })
      } catch { /* */ }

      // Hide splash screen once React mounts
      return async () => {
        try {
          await SplashScreen.hide({ fadeDuration: 300 })
        } catch { /* */ }
      }
    }
  } catch {
    // Not running in Capacitor — standard web environment
  }
  return () => {}
}

async function main() {
  const hideSplash = await bootstrapNative()

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )

  // Hide native splash screen after first paint
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      hideSplash()
    })
  })
}

main()

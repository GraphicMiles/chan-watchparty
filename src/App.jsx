import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './shared/auth/hooks/useAuth.jsx'
import { ToastProvider } from './shared/ui/index.js'
import { ConnectionBanner } from './shared/components/ConnectionBanner.jsx'
import { ErrorBoundary } from './shared/components/ErrorBoundary.jsx'
import { AuthPage } from './features/auth/index.js'
import { HomePage } from './features/home/index.js'

// Lazy-load heavy route components to reduce initial bundle size
const CreateRoomPage = lazy(() => import('./features/create/pages/CreateRoomPage.jsx').then(m => ({ default: m.default })))
const RoomPage = lazy(() => import('./features/room/pages/RoomPage.jsx').then(m => ({ default: m.default })))
const UnifiedSearch = lazy(() => import('./features/search/UnifiedSearch.jsx').then(m => ({ default: m.default })))

function Loading() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888' }}>Loading…</div>
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <ConnectionBanner />
          <ErrorBoundary fallback={(error, resetError) => (
            <div style={{
              minHeight: '100vh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 12,
              padding: 24,
              background: '#0B0B0D',
              color: '#F2EFEA',
              fontFamily: 'system-ui, sans-serif',
            }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Something went wrong</div>
              <pre style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxWidth: '90vw',
                maxHeight: '40vh',
                overflow: 'auto',
                background: '#141417',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                padding: 12,
                fontSize: 12,
                color: '#FF8A80',
              }}>
                {error?.message || String(error || 'Unknown error')}
                {'\n\n'}
                {error?.stack || ''}
              </pre>
              <button
                type="button"
                onClick={resetError}
                style={{
                  padding: '10px 20px',
                  borderRadius: 999,
                  border: 'none',
                  background: '#F2EFEA',
                  color: '#0B0B0D',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Retry
              </button>
            </div>
          )}>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/auth" element={<AuthPage />} />
                <Route path="/create" element={<CreateRoomPage />} />
                <Route path="/room/:roomId" element={<RoomPage />} />
                <Route path="/search" element={<UnifiedSearch />} />
                <Route path="/media" element={<UnifiedSearch />} />
                <Route path="/scraper" element={<Navigate to="/search" replace />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}

export default App

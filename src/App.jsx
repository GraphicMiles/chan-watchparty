import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './shared/auth/hooks/useAuth.jsx'
import { ToastProvider } from './shared/ui/index.js'
import { ConnectionBanner } from './shared/components/ConnectionBanner.jsx'
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
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}

export default App

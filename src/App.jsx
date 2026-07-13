import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './shared/auth/hooks/useAuth.jsx'
import { ToastProvider } from './shared/ui/index.js'
import { ConnectionBanner } from './shared/components/ConnectionBanner.jsx'
import { AuthPage } from './features/auth/index.js'
import { HomePage } from './features/home/index.js'
import { CreateRoomPage } from './features/create/index.js'
import { RoomPage } from './features/room/index.js'
import UnifiedSearch from './features/search/UnifiedSearch.jsx'

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <ConnectionBanner />
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
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}

export default App

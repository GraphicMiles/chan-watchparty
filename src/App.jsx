import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './shared/auth/hooks/useAuth.jsx'
import { ToastProvider } from './shared/ui/index.js'
import { ConnectionBanner } from './shared/components/ConnectionBanner.jsx'
import { AuthPage } from './features/auth/index.js'
import { HomePage } from './features/home/index.js'
import { CreateRoomPage } from './features/create/index.js'
import { RoomPage } from './features/room/index.js'

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
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  )
}

export default App

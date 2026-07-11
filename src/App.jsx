import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './shared/auth/hooks/useAuth.jsx'
import { AuthPage } from './features/auth/index.js'
import { HomePage } from './features/home/index.js'
import { CreateRoomPage } from './features/create/index.js'
import { RoomPage } from './features/room/index.js'

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/create" element={<CreateRoomPage />} />
          <Route path="/room/:roomId" element={<RoomPage />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App

import React from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { ToastContainer } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

import { AuthProvider } from './features/auth/AuthContext'
import ProtectedRoute from './features/auth/ProtectedRoute'

import LoginPage from './features/auth/pages/LoginPage'
import RegisterPage from './features/auth/pages/RegisterPage'
import HomePage from './features/home/pages/HomePage'
import CreateRoomPage from './features/create/pages/CreateRoomPage'
import RoomPage from './features/room/pages/RoomPage'
import UnifiedSearch from './features/search/UnifiedSearch'
import ScraperPage from './features/scraper/ScraperPage'
import ProfilePage from './features/profile/pages/ProfilePage'

import styles from './App.module.scss'

function App() {
  return (
    <AuthProvider>
      <div className={styles.app}>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          
          {/* Protected routes */}
          <Route path="/" element={<ProtectedRoute><HomePage /></ProtectedRoute>} />
          <Route path="/create" element={<ProtectedRoute><CreateRoomPage /></ProtectedRoute>} />
          <Route path="/room/:roomId" element={<ProtectedRoute><RoomPage /></ProtectedRoute>} />
          <Route path="/search" element={<ProtectedRoute><UnifiedSearch /></ProtectedRoute>} />
          <Route path="/scraper" element={<ProtectedRoute><ScraperPage /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
          
          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <ToastContainer 
          position="top-right"
          autoClose={3000}
          hideProgressBar={false}
          newestOnTop
          closeOnClick
          rtl={false}
          pauseOnFocusLoss
          draggable
          pauseOnHover
        />
      </div>
    </AuthProvider>
  )
}

export default App

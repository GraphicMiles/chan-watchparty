import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import './redesign/redesign.css';
import { UserProvider, useUser } from './redesign/ui.jsx';
import Auth from './redesign/screens/Auth.jsx';
import Home from './redesign/screens/Home.jsx';
import Browse from './redesign/screens/Browse.jsx';
import Title from './redesign/screens/Title.jsx';
import Create from './redesign/screens/Create.jsx';
import Room from './redesign/screens/Room.jsx';
import Settings from './redesign/screens/Settings.jsx';
import Share from './redesign/screens/Share.jsx';
import ErrorPage from './redesign/screens/ErrorPage.jsx';
import Profile from './redesign/screens/Profile.jsx';
import States from './redesign/screens/States.jsx';

/*
 * Redesign (mock-data phase): the approved REDESIGN_MOCKUP.html implemented
 * 1:1 against src/redesign/data.js. The previous Firebase-backed screens
 * are kept under src/features, unrouted, to be rewired screen by screen.
 */

function Gate({ children }) {
  const { name } = useUser();
  return name ? children : <Navigate to="/auth" replace />;
}

function AppRoutes() {
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/auth" element={<Auth />} />
        <Route path="/" element={<Gate><Home /></Gate>} />
        <Route path="/search" element={<Gate><Browse /></Gate>} />
        <Route path="/media" element={<Gate><Browse /></Gate>} />
        <Route path="/title" element={<Gate><Title /></Gate>} />
        <Route path="/create" element={<Gate><Create /></Gate>} />
        <Route path="/room/:roomId" element={<Gate><Room /></Gate>} />
        <Route path="/room/:roomId/settings" element={<Gate><Settings /></Gate>} />
        <Route path="/room/:roomId/share" element={<Gate><Share /></Gate>} />
        <Route path="/room/:roomId/error" element={<Gate><ErrorPage /></Gate>} />
        <Route path="/profile" element={<Gate><Profile /></Gate>} />
        <Route path="/states" element={<Gate><States /></Gate>} />
        <Route path="/scraper" element={<Navigate to="/search" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function App() {
  return (
    <UserProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </UserProvider>
  );
}

export default App;

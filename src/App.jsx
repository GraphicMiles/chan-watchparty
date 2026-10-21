import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import './redesign/redesign.css';
import { AuthProvider, useAuth } from './shared/auth/hooks/useAuth.jsx';
import { ToastProvider } from './shared/ui/index.js';
import { ConnectionBanner } from './shared/components/ConnectionBanner.jsx';
import { ErrorBoundary } from './shared/components/ErrorBoundary.jsx';
import Auth from './redesign/screens/Auth.jsx';
import Home from './redesign/screens/Home.jsx';

/*
 * Chan redesign, fully wired: the approved REDESIGN_MOCKUP.html screens on
 * top of the existing hooks/services/player (logic untouched). The legacy
 * pages under src/features remain as the reference implementations.
 */

// Lazy-load heavy route components to reduce initial bundle size
const Browse = lazy(() => import('./redesign/screens/Browse.jsx'));
const Title = lazy(() => import('./redesign/screens/Title.jsx'));
const Create = lazy(() => import('./redesign/screens/Create.jsx'));
const Room = lazy(() => import('./redesign/screens/Room.jsx'));
const Profile = lazy(() => import('./redesign/screens/Profile.jsx'));

function Loading() {
  return (
    <div className="screen">
      <div className="center-state">
        <Loader2 size={26} className="spin" style={{ color: 'var(--amber)' }} />
        <p>Loading…</p>
      </div>
    </div>
  );
}

/* Auth gate: every screen needs the anonymous identity. A deep link hit
   while signed out is remembered so sign-in lands back on it. */
function Gate({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) {
    try {
      sessionStorage.setItem('chan:after-auth', location.pathname + location.search);
    } catch { /* storage unavailable */ }
    return <Navigate to="/auth" replace />;
  }
  return children;
}

function AppRoutes() {
  return (
    <div className="app-shell">
      <ConnectionBanner />
      <ErrorBoundary fallback={(error, resetError) => (
        <div style={{
          minHeight: '100%',
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
              background: '#E9B44C',
              color: '#1D1402',
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
            <Route path="/auth" element={<Auth />} />
            <Route path="/" element={<Gate><Home /></Gate>} />
            <Route path="/search" element={<Gate><Browse /></Gate>} />
            <Route path="/media" element={<Gate><Browse /></Gate>} />
            <Route path="/title" element={<Gate><Title /></Gate>} />
            <Route path="/create" element={<Gate><Create /></Gate>} />
            <Route path="/room/:roomId" element={<Gate><Room /></Gate>} />
            <Route path="/profile" element={<Gate><Profile /></Gate>} />
            <Route path="/scraper" element={<Navigate to="/search" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}

export default App;

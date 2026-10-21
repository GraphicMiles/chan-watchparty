import { lazy, Suspense, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import './redesign/redesign.css';
import { AuthProvider, useAuth } from './shared/auth/hooks/useAuth.jsx';
import { ToastProvider, useToast } from './shared/ui/index.js';
import { deepLinkPathFromNotification, parseDeepLink } from './shared/lib/deepLink.js';
import { initPushNotifications } from './shared/lib/push.js';
import { ConnectionBanner } from './shared/components/ConnectionBanner.jsx';
import { ErrorBoundary } from './shared/components/ErrorBoundary.jsx';
import Auth from './redesign/screens/Auth.jsx';
import Home from './redesign/screens/Home.jsx';

/*
 * Chan redesign, fully wired: the approved REDESIGN_MOCKUP.html screens on
 * top of the existing hooks/services/player. Legacy duplicate screens were
 * retired only after their live logic had been ported into these routes.
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

/* Native-only bridge: turns Android App Links / custom-scheme intents and
   push-notification taps into the same React routes used on the web. The
   Gate above remembers protected targets across anonymous sign-in. */
function NativeBridge() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const currentPathRef = useRef('/');
  const lastOpenRef = useRef({ path: '', at: 0 });

  useEffect(() => {
    currentPathRef.current = `${location.pathname}${location.search}`;
  }, [location.pathname, location.search]);

  const openPathRef = useRef((path) => {
    if (!path) return;
    const now = Date.now();
    if (lastOpenRef.current.path === path && now - lastOpenRef.current.at < 1500) return;
    lastOpenRef.current = { path, at: now };
    if (currentPathRef.current !== path) navigate(path);
  });

  useEffect(() => {
    let cancelled = false;
    let removeListener = null;

    (async () => {
      try {
        const [{ Capacitor }, { App: NativeApp }] = await Promise.all([
          import('@capacitor/core'),
          import('@capacitor/app'),
        ]);
        if (cancelled || !Capacitor.isNativePlatform()) return;

        const handle = await NativeApp.addListener('appUrlOpen', ({ url }) => {
          openPathRef.current(parseDeepLink(url));
        });
        if (cancelled) {
          handle?.remove?.();
          return;
        }
        removeListener = handle?.remove;

        const launched = await NativeApp.getLaunchUrl().catch(() => null);
        if (!cancelled && launched?.url) {
          openPathRef.current(parseDeepLink(launched.url));
        }
      } catch {
        /* Web routing already starts on the URL the browser supplied. */
      }
    })();

    return () => {
      cancelled = true;
      try { removeListener?.(); } catch { /* listener already gone during teardown */ }
    };
  }, []);

  useEffect(() => {
    if (!user) {
      initPushNotifications(null).catch(() => {});
      return undefined;
    }

    let active = true;
    initPushNotifications(user, {
      onOpen: (action) => {
        const path = deepLinkPathFromNotification(action);
        if (path) openPathRef.current(path);
      },
      onForeground: (notification) => {
        const path = deepLinkPathFromNotification(notification);
        if (path && currentPathRef.current === path) return;
        const message = notification?.body || notification?.title || 'New room activity';
        toast(message, { variant: 'info', duration: 5000 });
      },
      onError: (err) => {
        if (active) console.warn('Push registration unavailable:', err?.message || err);
      },
    }).catch((err) => {
      if (active) console.warn('Push setup unavailable:', err?.message || err);
    });

    return () => { active = false; };
  }, [user, toast]);

  return null;
}

function AppRoutes() {
  return (
    <div className="app-shell">
      <NativeBridge />
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

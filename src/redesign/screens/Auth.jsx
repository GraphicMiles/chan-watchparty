import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, User, Loader2 } from 'lucide-react';
import { useAuth } from '../../shared/auth/hooks/useAuth.jsx';
import { Avatar, gradFor } from '../ui.jsx';

const MOSAIC = ['Shogun', 'Dune', 'The Bear', 'Oppenheimer', 'The Last of Us', 'Spider-Verse', 'Breaking Bad', 'Wednesday', 'Silo'];

export default function Auth() {
  const { user, loading: authLoading, signInAnonymously } = useAuth();
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const afterAuthTargetRef = useRef(null);
  const afterAuthPath = () => {
    // Both submit() and the auth-state effect navigate after sign-in.
    // Cache the one-shot target so the second caller cannot consume an
    // already-removed value and win the race with a navigation to Home.
    if (afterAuthTargetRef.current) return afterAuthTargetRef.current;
    let target = '/';
    try {
      target = sessionStorage.getItem('chan:after-auth') || '/';
      sessionStorage.removeItem('chan:after-auth');
    } catch { /* storage unavailable */ }
    afterAuthTargetRef.current = target;
    return target;
  };

  useEffect(() => {
    if (!authLoading && user) navigate(afterAuthPath(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading, navigate]);

  if (authLoading || user) {
    return (
      <div className="screen">
        <div className="center-state"><Loader2 size={26} className="spin" style={{ color: 'var(--amber)' }} /><p>Loading...</p></div>
      </div>
    );
  }

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await signInAnonymously(value.trim() || 'Viewer');
      navigate(afterAuthPath(), { replace: true });
    } catch (err) {
      setError(err.message || 'Could not join anonymously');
      setLoading(false);
    }
  };

  return (
    <div className="screen">
      <div className="auth-mosaic">
        {MOSAIC.map((t) => <div key={t} style={gradFor(t)} />)}
      </div>
      <div className="auth-shade" />
      <div className="safe-top" style={{ position: 'relative', zIndex: 2 }} />
      <form
        className="scroll"
        style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', padding: '0 20px 14px' }}
        onSubmit={submit}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 'auto 0 14px' }}>
          <span className="logo" style={{ width: 44, height: 44, borderRadius: 13 }}><Play size={22} /></span>
          <span style={{ fontSize: 24, fontWeight: 900, letterSpacing: '.06em' }}>CHAN</span>
        </div>
        <h1 style={{ fontSize: 29, lineHeight: 1.13, letterSpacing: '-.02em' }}>The screening<br />room is open.</h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.55, margin: '10px 0 22px' }}>
          Watch together with an anonymous identity.<br />No email, no tracking, just pick a name.
        </p>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }} htmlFor="auth-name">Display name</label>
        <div className="field">
          <User size={18} />
          <input
            id="auth-name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Pick a display name"
            aria-label="Display name"
            maxLength={30}
            autoComplete="nickname"
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 12 }}>
          <span style={{ display: 'flex', flex: 'none' }}><Avatar name={value.trim() || 'Viewer'} size={36} /></span>
          <span>
            <small style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, display: 'block' }}>
              This is how you appear in rooms. Colour is set by your name.
            </small>
            <b style={{ fontSize: 12.5 }}>{value.trim() || 'Viewer'}</b>
          </span>
        </div>
        {error ? (
          <div className="err-note" role="alert" style={{ margin: '14px 0 0' }}>
            <span>{error}</span>
          </div>
        ) : null}
        <button type="submit" className="btn btn-primary" style={{ marginTop: 22 }} disabled={loading}>
          {loading ? <Loader2 size={18} className="spin" /> : null}
          {loading ? 'Signing……' : 'Continue'}
        </button>
        <p style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--faint)', marginTop: 14 }}>
          Leave it empty and we call you Viewer.
        </p>
      </form>
    </div>
  );
}

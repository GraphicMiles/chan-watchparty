import { useState } from 'react';
import { Play, User } from 'lucide-react';
import { POSTERS } from '../data.js';
import { Avatar, grad, useGo, useUser } from '../ui.jsx';

export default function Auth() {
  const go = useGo();
  const { setName } = useUser();
  const [value, setValue] = useState('Tunde');
  const initial = (value.trim()[0] || 'V').toUpperCase();

  return (
    <div className="screen">
      <div className="auth-mosaic">
        {POSTERS.slice(0, 9).map((p) => <div key={p.t} style={grad(p)} />)}
      </div>
      <div className="auth-shade" />
      <div className="safe-top" style={{ position: 'relative', zIndex: 2 }} />
      <div className="scroll" style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', padding: '0 20px 14px' }}>
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
            aria-label="Display name"
            maxLength={24}
            autoComplete="off"
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, padding: 12 }}>
          <span style={{ display: 'flex', flex: 'none' }}><Avatar name={initial} color="#E9B44C" size={36} /></span>
          <span style={{ flex: '1 1 auto', minWidth: 0 }}>
            <small style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.5, display: 'block' }}>
              This is how you appear in rooms. Colour is set by your name.
            </small>
          </span>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 22 }}
          onClick={() => { setName(value.trim() || 'Viewer'); go('home'); }}
        >
          Continue
        </button>
        <p style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--faint)', marginTop: 14 }}>
          Leave it empty and we call you Viewer.
        </p>
      </div>
    </div>
  );
}

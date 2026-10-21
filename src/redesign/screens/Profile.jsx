import { useState } from 'react';
import { Award, LogOut, Check } from 'lucide-react';
import { BADGES, BUILD } from '../data.js';
import { Avatar, BottomNav, Toggle, useGo, useTempFlag, useUser } from '../ui.jsx';

export default function Profile() {
  const go = useGo();
  const { name, setName } = useUser();
  const [draft, setDraft] = useState(name || 'Viewer');
  const [adult, setAdult] = useState(false);
  const [ageOpen, setAgeOpen] = useState(false);
  const [saved, markSaved] = useTempFlag();

  const toggleAdult = (next) => {
    if (next) setAgeOpen(true);
    else setAdult(false);
  };

  return (
    <div className="screen">
      <div className="safe-top" />
      <div className="scroll">
        <div className="px" style={{ marginTop: 6 }}>
          <h1 style={{ fontSize: 24, letterSpacing: '-.02em' }}>Profile</h1>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <Avatar name={name || 'Viewer'} color="#E9B44C" size={58} />
            <span style={{ minWidth: 0 }}>
              <b className="truncate" style={{ fontSize: 17, display: 'block' }}>{name || 'Viewer'}</b>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Watch Party Member</span>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <div style={{ flex: '1 1 0', minWidth: 0, background: 'var(--surface2)', borderRadius: 12, padding: 12, textAlign: 'center' }}>
              <b style={{ display: 'block', fontSize: 14 }}>Active</b>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Status</span>
            </div>
            <div style={{ flex: '1 1 0', minWidth: 0, background: 'var(--surface2)', borderRadius: 12, padding: 12, textAlign: 'center' }}>
              <b style={{ display: 'block', fontSize: 14 }}>Level 4</b>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Watch Tier</span>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <b style={{ fontSize: 13 }}>Badges</b>
            {BADGES.map((b) => (
              <div key={b} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '5px 0' }}>
                <span style={{ color: 'var(--muted)' }}><Award size={16} /></span>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{b}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="px" style={{ marginTop: 20 }}>
          <label className="micro" style={{ display: 'block', marginBottom: 8 }} htmlFor="profile-name">Display name</label>
          <div className="field">
            <input id="profile-name" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Display name" maxLength={24} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => { setName(draft.trim() || 'Viewer'); markSaved(); }}
            >
              {saved ? <><Check size={14} />Saved</> : 'Save name'}
            </button>
            <span className="helper">Shown in chat and room lists.</span>
          </div>
        </div>
        <div className="card" style={{ marginTop: 18, padding: '4px 16px' }}>
          <div className="switch-row">
            <span><b>Adult content (18+)</b><small>Shows the 18+ section in Browse after an age check</small></span>
            <Toggle on={adult} onChange={toggleAdult} label="Adult content" />
          </div>
        </div>
        <div className="card" style={{ marginTop: 12 }}>
          <b style={{ fontSize: 13 }}>App build</b>
          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9, marginTop: 8 }}>
            Version: {BUILD.version}<br />
            Commit: {BUILD.commit}<br />
            Built: {BUILD.built}
          </div>
        </div>
        <div className="px" style={{ marginTop: 18 }}>
          <button
            type="button"
            className="btn btn-danger"
            style={{ height: 44, fontSize: 14 }}
            onClick={() => { setName(''); go('auth'); }}
          >
            <LogOut size={15} />Sign out
          </button>
        </div>
      </div>
      <BottomNav active="profile" />
      {ageOpen && (
        <div className="sheet-wrap">
          <div className="sheet-dim" onClick={() => setAgeOpen(false)} />
          <div className="sheet">
            <div className="sheet-grip" />
            <b style={{ fontSize: 16 }}>Age verification required</b>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6, marginTop: 8 }}>
              You must be 18 or older to access adult content. This adds the 18+ section to Browse on this account.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={() => { setAdult(true); setAgeOpen(false); }}
            >
              I am 18+
            </button>
            <div style={{ textAlign: 'center' }}>
              <button type="button" className="text-btn" onClick={() => setAgeOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

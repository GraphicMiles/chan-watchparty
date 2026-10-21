import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { Award, LogOut, Check, Loader2 } from 'lucide-react';
import { App as NativeApp } from '@capacitor/app';
import { db } from '../../shared/lib/firebase.js';
import { useAuth } from '../../shared/auth/hooks/useAuth.jsx';
import { useToast } from '../../shared/ui/index.js';
import { VideoPlayerPlugin } from '../../native/VideoPlayerPlugin';
import { disablePushNotifications, enablePushNotifications, getPushState } from '../../shared/lib/push.js';
import { Avatar, BottomNav, Toggle, useTempFlag } from '../ui.jsx';

const ADULT_KEY = 'chan:adult-verified';

export function isAdultVerified() {
  try { return window.localStorage.getItem(ADULT_KEY) === '1'; } catch { return false; }
}
function setAdultVerifiedStored(on) {
  try {
    if (on) window.localStorage.setItem(ADULT_KEY, '1');
    else window.localStorage.removeItem(ADULT_KEY);
  } catch { /* storage unavailable */ }
}

export default function Profile() {
  const { user, updateDisplayName, logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [draft, setDraft] = useState(user?.displayName || 'Viewer');
  const [saving, setSaving] = useState(false);
  const [adult, setAdult] = useState(() => isAdultVerified());
  const [ageOpen, setAgeOpen] = useState(false);
  const [saved, markSaved] = useTempFlag();
  const [tier, setTier] = useState('Free');
  const [buildInfo, setBuildInfo] = useState(null);
  const [push, setPush] = useState({ supported: false, receive: 'denied', enabled: false });
  const [pushBusy, setPushBusy] = useState(false);

  // Account doc (tier) for the identity card.
  useEffect(() => {
    if (!user) return;
    setDraft(user.displayName || 'Viewer');
    getDoc(doc(db, 'users', user.uid))
      .then((snap) => {
        const t = snap.exists() ? snap.data().tier : null;
        if (t) setTier(t.charAt(0).toUpperCase() + t.slice(1));
      })
      .catch(() => {});
  }, [user]);

  // Exact APK identity from Gradle/CI (same source as the old Header).
  useEffect(() => {
    let active = true;
    VideoPlayerPlugin.getBuildInfo()
      .then((info) => { if (active) setBuildInfo(info); })
      .catch(() => {
        NativeApp.getInfo()
          .then((info) => { if (active) setBuildInfo({ version: info?.version || '', commit: '', builtAt: '' }); })
          .catch(() => {});
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    getPushState().then((state) => { if (active) setPush(state); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const built = buildInfo?.builtAt
    ? buildInfo.builtAt.replace('T', ' ').replace(/:\d{2}(?:\.\d+)?Z$/, 'Z')
    : '';
  const version = buildInfo?.version?.replace(/-debug$/, '') || '';

  const saveName = async () => {
    const next = draft.trim() || 'Viewer';
    setSaving(true);
    try {
      await updateDisplayName(next);
      markSaved();
    } catch (err) {
      toast(err.message || 'Could not save name', { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const toggleAdult = (next) => {
    if (next) setAgeOpen(true);
    else { setAdult(false); setAdultVerifiedStored(false); }
  };

  const togglePush = async (next) => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      const state = next
        ? await enablePushNotifications(user)
        : await disablePushNotifications(user);
      setPush(state);
      if (next && state.enabled) toast('Room join alerts are on', { variant: 'success' });
      else if (next) toast('Allow notifications in Android settings to receive room alerts', { variant: 'warning' });
      else toast('Room join alerts are off', { variant: 'success' });
    } catch (err) {
      setPush(await getPushState().catch(() => push));
      toast(err.message || 'Could not update notifications', { variant: 'error' });
    } finally {
      setPushBusy(false);
    }
  };

  const signOut = async () => {
    try { await disablePushNotifications(user); } catch { /* do not trap the user in a signed-in session */ }
    try { await logout(); } catch { /* still leave */ }
    navigate('/auth', { replace: true });
  };

  // Universal Chan Passport badges (room host/co-host badges are awarded
  // in-room; see ParticipantList calculateUserBadges).
  const badges = ['Watch Diehard', 'Active Member'];

  return (
    <div className="screen with-nav">
      <div className="safe-top" />
      <div className="scroll">
        <div className="px" style={{ marginTop: 6 }}>
          <h1 style={{ fontSize: 24, letterSpacing: '-.02em' }}>Profile</h1>
        </div>
        <div className="card rise" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <Avatar name={user?.displayName || 'Viewer'} uid={user?.uid} size={58} />
            <span style={{ minWidth: 0 }}>
              <b className="truncate" style={{ fontSize: 17, display: 'block' }}>{user?.displayName || 'Viewer'}</b>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>Watch Party Member</span>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <div style={{ flex: '1 1 0', minWidth: 0, background: 'var(--surface2)', borderRadius: 12, padding: 12, textAlign: 'center' }}>
              <b style={{ display: 'block', fontSize: 14 }}>Active</b>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Status</span>
            </div>
            <div style={{ flex: '1 1 0', minWidth: 0, background: 'var(--surface2)', borderRadius: 12, padding: 12, textAlign: 'center' }}>
              <b style={{ display: 'block', fontSize: 14 }}>{tier}</b>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>Watch Tier</span>
            </div>
          </div>
          <div style={{ marginTop: 14 }}>
            <b style={{ fontSize: 13 }}>Badges</b>
            {badges.map((b) => (
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
            <input
              id="profile-name"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveName(); }}
              aria-label="Display name"
              maxLength={30}
              autoComplete="nickname"
            />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={saveName} disabled={saving}>
              {saving ? <Loader2 size={14} className="spin" /> : saved ? <><Check size={14} />Saved</> : 'Save name'}
            </button>
            <span className="helper">Shown in chat and room lists.</span>
          </div>
        </div>

        <div className="card" style={{ marginTop: 18, padding: '4px 16px' }}>
          <div className="switch-row">
            <span><b>Adult content (18+)</b><small>Shows the 18+ section in Browse after an age check</small></span>
            <Toggle on={adult} onChange={toggleAdult} label="Adult content" />
          </div>
          <div className="switch-row">
            <span>
              <b>Room join alerts</b>
              <small>{push.supported ? 'Get a push notification when someone joins a room you host' : 'Available in the Android app'}</small>
            </span>
            <Toggle on={push.enabled} onChange={togglePush} label="Room join alerts" />
          </div>
        </div>

        <div className="card" style={{ marginTop: 12 }}>
          <b style={{ fontSize: 13 }}>App build</b>
          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9, marginTop: 8 }}>
            Version: {version ? `v${version}` : 'Web build'}<br />
            Commit: {buildInfo?.commit ? buildInfo.commit.slice(0, 7) : 'unknown'}<br />
            Built: {built || 'unknown'}
          </div>
        </div>

        <div className="px" style={{ marginTop: 18 }}>
          <button type="button" className="btn btn-danger" style={{ height: 44, fontSize: 14 }} onClick={signOut}>
            <LogOut size={15} />Sign out
          </button>
        </div>
      </div>
      <BottomNav active="profile" />

      {ageOpen && (
        <div className="sheet-wrap">
          <div className="sheet-dim" onClick={() => setAgeOpen(false)} />
          <div className="sheet" role="dialog" aria-label="Age verification">
            <div className="sheet-grip" />
            <b style={{ fontSize: 16 }}>Age verification required</b>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6, marginTop: 8 }}>
              You must be 18 or older to access adult content. By continuing, you confirm
              you are of legal age in your jurisdiction.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={() => { setAdult(true); setAdultVerifiedStored(true); setAgeOpen(false); }}
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

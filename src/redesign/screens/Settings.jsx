import { useEffect, useState } from 'react';
import { Bookmark, PictureInPicture2, RotateCw, Check } from 'lucide-react';
import { ROOM } from '../data.js';
import { Player, RoomHead, Toggle, useGo, useTempFlag } from '../ui.jsx';

export default function Settings() {
  const go = useGo();
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(ROOM.startAt);
  const [quality, setQuality] = useState('Auto');
  const [captions, setCaptions] = useState(true);
  const [glow, setGlow] = useState(true);
  const [brightness, setBrightness] = useState(100);
  const [volume, setVolume] = useState(80);
  const [pinned, setPinned] = useState(false);
  const [pip, setPip] = useState(false);
  const [rot, setRot] = useState(false);
  const [title, setTitle] = useState('Shogun, episode 4');
  const [saved, markSaved] = useTempFlag();

  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => setPos((s) => Math.min(ROOM.duration, s + 1)), 1000);
    return () => clearInterval(t);
  }, [playing]);

  const sliderRow = (label, help, min, max, val, set) => (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
      <div className="h-row">
        <b style={{ fontSize: 14 }}>{label}</b>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>{val}%</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={val}
        onChange={(e) => set(+e.target.value)}
        style={{ marginTop: 8 }}
        aria-label={label}
      />
      <p className="helper" style={{ marginTop: 4 }}>{help}</p>
    </div>
  );

  return (
    <div className="screen">
      <RoomHead />
      <Player
        playing={playing}
        onTogglePlay={() => setPlaying((v) => !v)}
        pos={pos}
        onSkip={(d) => setPos((s) => Math.max(0, Math.min(ROOM.duration, s + d)))}
        skips
        caption={captions}
        pins
        extraPins={pinned ? [62] : []}
        vibe={glow}
        bgFilter={`brightness(${brightness / 100})`}
      />
      <div className="scroll">
        <div className="px" style={{ marginTop: 12 }}><span className="sec-title">Player</span></div>
        <div className="card" style={{ marginTop: 10, padding: '6px 16px' }}>
          <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
            <b style={{ fontSize: 14 }}>Quality</b>
            <div style={{ display: 'flex', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
              {['Auto', '1080p', '720p', '480p'].map((q) => (
                <button key={q} type="button" className={`chip${quality === q ? ' active' : ''}`} onClick={() => setQuality(q)}>{q}</button>
              ))}
            </div>
            <p className="helper" style={{ marginTop: 8 }}>MKV and HEVC files use the VLC engine on Android.</p>
          </div>
          <div className="switch-row">
            <span><b>AI captions</b><small>Scene descriptions and sound cues for this stream</small></span>
            <Toggle on={captions} onChange={setCaptions} label="AI captions" />
          </div>
          {sliderRow('Brightness', '0 to 200%. Opens over the video on Android.', 0, 200, brightness, setBrightness)}
          {sliderRow('Volume', 'Your device only.', 0, 100, volume, setVolume)}
          <div className="switch-row">
            <span><b>Vibe Glow</b><small>Colours the player border from the video</small></span>
            <Toggle on={glow} onChange={setGlow} label="Vibe Glow" />
          </div>
        </div>
        <div className="action-pills">
          <button type="button" className={pinned ? 'on' : ''} onClick={() => setPinned((v) => !v)}><Bookmark size={14} />Pin moment</button>
          <button type="button" className={pip ? 'on' : ''} onClick={() => setPip((v) => !v)}><PictureInPicture2 size={15} />PiP</button>
          <button type="button" className={rot ? 'on' : ''} onClick={() => setRot((v) => !v)}><RotateCw size={14} />Rotate</button>
        </div>
        <p className="helper px" style={{ marginTop: 10 }}>Pins drop a named marker on the seek bar for the whole room.</p>
        <div className="px" style={{ marginTop: 20 }}><span className="sec-title">Room</span></div>
        <div className="card" style={{ marginTop: 10, padding: '6px 16px' }}>
          <div style={{ padding: '12px 0', borderBottom: '1px solid var(--line)' }}>
            <label className="micro" style={{ display: 'block', marginBottom: 8 }} htmlFor="stream-title">Stream title (host)</label>
            <div className="field">
              <input id="stream-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Stream title" />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={markSaved}>
                {saved ? <><Check size={14} />Saved</> : 'Save'}
              </button>
              <button type="button" className="text-btn" onClick={() => setTitle('Shogun, episode 4')}>Cancel</button>
            </div>
          </div>
          <div className="switch-row">
            <span><b>Share screen</b><small>Needs a desktop browser to start. Phones can watch.</small></span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => go('share')}>Start</button>
          </div>
        </div>
        <p className="helper px" style={{ marginTop: 14 }}>
          Live TV and sports: seeking is off. Quality, captions and volume still apply.
        </p>
      </div>
    </div>
  );
}

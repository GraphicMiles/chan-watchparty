import { useEffect, useState } from 'react';
import { X, Copy, Share2, Check } from 'lucide-react';
import { ROOM, QR_CELLS } from '../data.js';
import { Player, RoomHead, copyText, useGo, useTempFlag } from '../ui.jsx';

export default function Share() {
  const go = useGo();
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(ROOM.startAt);
  const [linkCopied, markLink] = useTempFlag();
  const [codeCopied, markCode] = useTempFlag();
  const [shared, markShared] = useTempFlag();

  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => setPos((s) => Math.min(ROOM.duration, s + 1)), 1000);
    return () => clearInterval(t);
  }, [playing]);

  const doShare = () => {
    if (navigator.share) {
      navigator.share({ title: ROOM.name, text: 'Join my watch party', url: ROOM.link }).catch(() => {});
    } else {
      copyText(ROOM.link).then(markShared, markShared);
    }
  };

  return (
    <div className="screen">
      <RoomHead />
      <Player
        playing={playing}
        onTogglePlay={() => setPlaying((v) => !v)}
        pos={pos}
        onSkip={(d) => setPos((s) => Math.max(0, Math.min(ROOM.duration, s + d)))}
        desktop
      />
      <div className="px" style={{ flex: 'none', marginTop: 12 }}>
        <b style={{ fontSize: 15 }}>Temi is sharing their screen</b>
        <p className="helper" style={{ marginTop: 4 }}>
          Everyone watches the shared screen and its audio. On a phone, sharing falls back to the camera.
        </p>
        <button type="button" className="btn btn-ghost" style={{ height: 44, fontSize: 14, marginTop: 10 }} onClick={() => go('room')}>
          Stop screen share
        </button>
      </div>
      <div className="scroll" />
      <div className="sheet-wrap">
        <div className="sheet-dim" onClick={() => go('room')} />
        <div className="sheet">
          <div className="sheet-grip" />
          <div className="h-row">
            <b style={{ fontSize: 16 }}>Share room</b>
            <button type="button" className="icon-btn" onClick={() => go('room')} aria-label="Close share"><X size={16} /></button>
          </div>
          <div className="qr" style={{ marginTop: 8 }}>
            <span className="qr-grid">
              {QR_CELLS.map((v, i) => (v ? <i key={i} /> : <i key={i} className="o" />))}
            </span>
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <input
              readOnly
              aria-label="Invite link"
              value={ROOM.link}
              onFocus={(e) => e.target.select()}
            />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ height: 44, fontSize: 14 }}
              onClick={() => copyText(ROOM.link).then(markLink, markLink)}
            >
              {linkCopied ? <><Check size={15} />Copied</> : <><Copy size={15} />Copy link</>}
            </button>
            <button type="button" className="btn btn-primary" style={{ height: 44, fontSize: 14 }} onClick={doShare}>
              {shared ? <><Check size={15} />Link copied</> : <><Share2 size={15} />Share</>}
            </button>
          </div>
          <div className="h-row" style={{ marginTop: 16 }}>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Invite code</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <b className="mono" style={{ letterSpacing: '.12em' }}>{ROOM.code}</b>
              <button
                type="button"
                className="icon-btn"
                onClick={() => copyText(ROOM.code).then(markCode, markCode)}
                aria-label="Copy code"
              >
                {codeCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

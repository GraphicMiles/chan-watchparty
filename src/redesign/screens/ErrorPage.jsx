import { useRef } from 'react';
import { TriangleAlert, ChevronLeft, RotateCw, Check } from 'lucide-react';
import { copyText, useGo, useTempFlag } from '../ui.jsx';

const DETAILS = 'kind: expired\nSource returned 403. The signed URL is past its window.\nengine: vlc (exo could not demux mkv)';

export default function ErrorPage() {
  const go = useGo();
  const diagRef = useRef(null);
  const [copied, markCopied] = useTempFlag();

  return (
    <div className="screen">
      <div className="safe-top" />
      <div className="px h-row" style={{ flex: 'none', marginTop: 4 }}>
        <button type="button" className="icon-btn" onClick={() => go('room')} aria-label="Back to room"><ChevronLeft size={19} /></button>
        <b style={{ fontSize: 15 }}>Playback problem</b>
        <span style={{ width: 40 }} />
      </div>
      <div className="scroll">
        <div style={{ margin: '14px 20px 0', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, aspectRatio: '16/9', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 18, textAlign: 'center' }}>
          <span style={{ color: 'var(--danger-ink)' }}><TriangleAlert size={26} /></span>
          <b style={{ fontSize: 15 }}>This link has expired.</b>
          <span style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
            Download links are signed and go stale. The room keeps its place at 38:12 while you fix it.
          </span>
        </div>
        <div className="px" style={{ marginTop: 14 }}>
          <button type="button" className="btn btn-primary" onClick={() => go('room')}><RotateCw size={15} />Retry</button>
          <div style={{ display: 'flex', gap: 9, marginTop: 9 }}>
            <button type="button" className="btn btn-ghost" style={{ height: 44, fontSize: 13 }} onClick={() => go('room')}>Re-resolve link</button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ height: 44, fontSize: 13 }}
              onClick={() => diagRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
            >
              Network diagnostic
            </button>
          </div>
          <p className="helper" style={{ marginTop: 9 }}>Re-resolving needs the host or a co-host.</p>
        </div>
        <div className="card" style={{ marginTop: 16 }}>
          <div className="h-row">
            <b style={{ fontSize: 13 }}>Error details</b>
            <button type="button" className="see-all" onClick={() => copyText(DETAILS).then(markCopied, markCopied)}>
              {copied ? <><Check size={13} style={{ verticalAlign: '-2px' }} /> Copied</> : 'Copy'}
            </button>
          </div>
          <p className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.7, marginTop: 8, overflowWrap: 'anywhere', whiteSpace: 'pre-line' }}>
            {DETAILS}
          </p>
        </div>
        <div className="card" ref={diagRef} style={{ marginTop: 12 }}>
          <b style={{ fontSize: 13 }}>Network diagnostic</b>
          <p className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.7, marginTop: 8, overflowWrap: 'anywhere' }}>
            host reachable from this phone<br />
            range request: 206 partial content<br />
            Not a carrier block. Link expiry is the likely cause.
          </p>
        </div>
        <div className="px" style={{ marginTop: 20 }}>
          <span className="sec-title">Buffering</span>
          <div className="progress" style={{ marginTop: 12 }}><i style={{ width: '42%' }} /></div>
          <p className="helper" style={{ marginTop: 8 }}>Buffering 42%. Sync holds the room at the same timestamp, nobody drifts ahead.</p>
        </div>
        <div className="px" style={{ marginTop: 20 }}>
          <span className="sec-title">Room error</span>
          <div className="empty-box" style={{ marginTop: 10 }}>
            <span style={{ color: 'var(--danger-ink)' }}><TriangleAlert size={22} /></span>
            <h4>Room not found or already ended</h4>
            <p>The link may be old. Check Live now, or ask the host for a fresh invite.</p>
            <button type="button" className="btn btn-primary btn-sm" style={{ margin: '12px auto 0' }} onClick={() => go('home')}>Back to home</button>
          </div>
        </div>
      </div>
    </div>
  );
}

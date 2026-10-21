import { useState } from 'react';
import { Play, Check, ChevronLeft } from 'lucide-react';
import { POSTERS, EPISODES, TITLE } from '../data.js';
import { grad, useGo } from '../ui.jsx';

export default function Title() {
  const go = useGo();
  const p = POSTERS[0];
  const [picked, setPicked] = useState(3);

  return (
    <div className="screen">
      <div className="scroll">
        <div style={{ position: 'relative', height: 230, ...grad(p) }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg,rgba(0,0,0,.25),transparent 40%,var(--bg) 98%)' }} />
          <button
            type="button"
            className="icon-btn"
            onClick={() => go('browse')}
            aria-label="Back"
            style={{ position: 'absolute', top: 'calc(10px + env(safe-area-inset-top,0px))', left: 16 }}
          >
            <ChevronLeft size={19} />
          </button>
          <div style={{ position: 'absolute', left: 20, right: 20, bottom: 6 }}>
            <h1 style={{ fontSize: 30, letterSpacing: '-.02em', marginTop: 8 }}>{TITLE.name}</h1>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{TITLE.meta}</p>
          </div>
        </div>
        <div className="px" style={{ marginTop: 12 }}>
          <p style={{ fontSize: 13.5, color: 'var(--soft)', lineHeight: 1.6 }}>{TITLE.synopsis}</p>
        </div>
        <div className="px h-row" style={{ margin: '22px 0 6px' }}>
          <span className="sec-title" style={{ fontSize: 16 }}>Season 1</span>
          <span style={{ fontSize: 12, color: 'var(--muted)', flex: 'none' }}>{EPISODES.length} episodes</span>
        </div>
        <div style={{ padding: '0 10px' }}>
          {EPISODES.map((e, i) => (
            <button key={e.id} type="button" className={`ep-row${picked === i ? ' active' : ''}`} onClick={() => setPicked(i)}>
              <span className="ep-thumb" style={grad(p)}><Play size={18} style={{ position: 'relative', zIndex: 1 }} /></span>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <b style={{ display: 'block', fontSize: 13.5, lineHeight: 1.3 }}>{e.id}, {e.title}</b>
                <small className="ep-sub">{e.sub}</small>
                <small className="ep-picked">Picked for your room</small>
              </span>
              <span className="ep-check"><Check size={18} /></span>
            </button>
          ))}
        </div>
      </div>
      <div className="sticky-cta">
        <button type="button" className="btn btn-primary" onClick={() => go('create')}>
          <Play size={17} />Start watch party
        </button>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, X, Link2, ChevronRight, Lock, Tv } from 'lucide-react';
import { POSTERS, CHANNELS, SPORTS } from '../data.js';
import { BottomNav, PosterCard, useGo } from '../ui.jsx';

const TABS = [
  ['all', 'All media'],
  ['youtube', 'YouTube'],
  ['direct', 'Direct links'],
  ['iptv', 'IPTV'],
  ['sports', 'Sports'],
];

export default function Browse() {
  const go = useGo();
  const [params, setParams] = useSearchParams();
  const layer = params.get('layer') || 'all';
  const liveMode = layer === 'iptv' || layer === 'sports';
  const [query, setQuery] = useState('Silo');
  const [done, setDone] = useState(false);

  const head = (
    <>
      <div className="safe-top" />
      <div className="px" style={{ marginTop: 6 }}>
        <h1 style={{ fontSize: 24, letterSpacing: '-.02em' }}>Browse</h1>
      </div>
      <div className="chip-row" style={{ marginTop: 12 }}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`chip${layer === id ? ' active' : ''}`}
            onClick={() => { setParams(id === 'all' ? {} : { layer: id }); setDone(false); }}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );

  if (liveMode) {
    return (
      <div className="screen">
        {head}
        <div className="scroll">
          <div className="px" style={{ marginTop: 14 }}>
            <div className="field" style={{ borderRadius: 'var(--r-pill)' }}>
              <Search size={17} />
              <input placeholder="Search live TV channels" aria-label="Search live TV channels" />
            </div>
          </div>
          <div className="px" style={{ margin: '20px 0 2px' }}><span className="sec-title">Live TV</span></div>
          {CHANNELS.map(([code, name, prog]) => (
            <button key={code} type="button" className="channel-row" onClick={() => go('create')}>
              <span className="channel-logo" style={{ background: 'var(--surface3)' }}>{code}</span>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <b style={{ fontSize: 14, display: 'block' }}>{name}</b>
                <small style={{ display: 'block', color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>{prog}</small>
              </span>
            </button>
          ))}
          <div className="px" style={{ margin: '18px 0 2px' }}><span className="sec-title">Live sports</span></div>
          {SPORTS.map(([title, meta]) => (
            <button key={title} type="button" className="channel-row" onClick={() => go('create')}>
              <span className="channel-logo" style={{ background: 'var(--surface3)', color: 'var(--muted)' }}><Tv size={20} /></span>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <b style={{ fontSize: 14, display: 'block', lineHeight: 1.3 }}>{title}</b>
                <small style={{ display: 'block', color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>{meta}</small>
              </span>
            </button>
          ))}
          <button type="button" className="channel-row" style={{ marginTop: 14 }} onClick={() => go('profile')}>
            <span className="channel-logo" style={{ background: 'var(--surface3)', color: 'var(--muted)' }}><Lock size={19} /></span>
            <span style={{ flex: '1 1 auto', minWidth: 0 }}>
              <b style={{ fontSize: 14, display: 'block' }}>Adult (18+)</b>
              <small style={{ color: 'var(--muted)', fontSize: 11.5 }}>Off. Turn it on in Profile and confirm your age.</small>
            </span>
            <span style={{ color: 'var(--faint)' }}><ChevronRight size={16} /></span>
          </button>
          <div className="px" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" style={{ height: 44, fontSize: 14, opacity: done ? 0.55 : 1 }} disabled={done} onClick={() => setDone(true)}>
              {done ? 'That is everything' : 'Load more'}
            </button>
          </div>
        </div>
        <BottomNav active="browse" />
      </div>
    );
  }

  return (
    <div className="screen">
      {head}
      <div className="scroll">
        <div className="px" style={{ marginTop: 14 }}>
          <div className="field" style={{ borderRadius: 'var(--r-pill)' }}>
            <Search size={17} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search media" />
            <button type="button" style={{ color: 'var(--muted)', flex: 'none' }} onClick={() => setQuery('')} aria-label="Clear search">
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="px" style={{ marginTop: 14 }}>
          <button
            type="button"
            onClick={() => go('create')}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 16, padding: '14px 16px' }}
          >
            <span style={{ color: 'var(--amber)', flex: 'none' }}><Link2 size={22} /></span>
            <span style={{ flex: '1 1 auto', minWidth: 0 }}>
              <b style={{ fontSize: 14 }}>Have a link instead?</b><br />
              <small style={{ color: 'var(--muted)', fontSize: 12 }}>YouTube, direct video or Live TV.</small>
            </span>
            <span style={{ color: 'var(--faint)', flex: 'none' }}><ChevronRight size={16} /></span>
          </button>
        </div>
        <div className="px h-row" style={{ margin: '20px 0 10px' }}>
          <span className="sec-title">{POSTERS.length} results</span>
          <button type="button" className="see-all" onClick={() => { setQuery(''); setParams({}); }}>Clear all</button>
        </div>
        <div className="px browse-grid">
          {POSTERS.map((p) => <PosterCard key={p.t} p={p} fluid onOpen={() => go('title')} />)}
        </div>
        <div className="px" style={{ marginTop: 18 }}>
          <button type="button" className="btn btn-ghost" style={{ height: 44, fontSize: 14, opacity: done ? 0.55 : 1 }} disabled={done} onClick={() => setDone(true)}>
            {done ? 'That is everything' : 'Load more'}
          </button>
        </div>
      </div>
      <BottomNav active="browse" />
    </div>
  );
}

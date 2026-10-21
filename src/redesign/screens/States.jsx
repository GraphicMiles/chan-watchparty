import { Users, ListVideo, Compass, Search } from 'lucide-react';
import { useGo } from '../ui.jsx';

/* Design-spec surface: loading skeletons + empty states in one place. */
export default function States() {
  const go = useGo();
  const block = { padding: '18px 20px 6px' };

  return (
    <div className="screen">
      <div className="safe-top" />
      <div className="scroll">
        <div style={block}>
          <span className="sec-title">Joining a room</span>
          <div className="skel" style={{ height: 168, borderRadius: 16, marginTop: 12 }} />
          <div className="skel" style={{ height: 11, width: '62%', marginTop: 12 }} />
          <div className="skel" style={{ height: 11, width: '40%', marginTop: 8 }} />
          <p className="helper" style={{ marginTop: 10 }}>Skeleton matches the room layout. Same treatment while search results load:</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12, marginTop: 12 }}>
            {Array(6).fill(0).map((_, i) => (
              <span key={i} style={{ minWidth: 0 }}>
                <span className="skel" style={{ display: 'block', aspectRatio: '2/3', borderRadius: 'var(--r-poster)' }} />
                <span className="skel" style={{ display: 'block', height: 9, width: '80%', marginTop: 8 }} />
                <span className="skel" style={{ display: 'block', height: 9, width: '55%', marginTop: 6 }} />
              </span>
            ))}
          </div>
        </div>
        <div style={block}>
          <span className="sec-title">No live rooms</span>
          <div className="empty-box" style={{ marginTop: 12 }}>
            <span style={{ color: 'var(--muted)' }}><Users size={24} /></span>
            <h4>No live rooms right now</h4>
            <p>Search above to start one, anyone can join.</p>
            <button type="button" className="btn btn-primary btn-sm" style={{ margin: '12px auto 0' }} onClick={() => go('browse')}>Browse media</button>
          </div>
        </div>
        <div style={block}>
          <span className="sec-title">Empty queue</span>
          <div className="empty-box" style={{ marginTop: 12 }}>
            <span style={{ color: 'var(--muted)' }}><ListVideo size={24} /></span>
            <h4>Queue is empty</h4>
            <p>Add a video and it plays after this one ends. Up to 5 items.</p>
          </div>
        </div>
        <div style={block}>
          <span className="sec-title">Create, nothing picked</span>
          <div className="empty-box" style={{ marginTop: 12 }}>
            <span style={{ color: 'var(--muted)' }}><Compass size={24} /></span>
            <h4>Pick something to watch</h4>
            <p>A YouTube video, a live channel, a sports match or a TV show. Then set up the room.</p>
            <button type="button" className="btn btn-primary btn-sm" style={{ margin: '12px auto 0' }} onClick={() => go('browse')}>Browse media</button>
          </div>
        </div>
        <div style={block}>
          <span className="sec-title">Search, no results</span>
          <div className="empty-box" style={{ marginTop: 12 }}>
            <span style={{ color: 'var(--muted)' }}><Search size={24} /></span>
            <h4>Nothing found for that title</h4>
            <p>Try a shorter title, switch source above, or paste a link instead.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

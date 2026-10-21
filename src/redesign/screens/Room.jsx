import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play, Pause, X, Send, Smile, Bot, Brain, Sparkles, MessageCircle, ListVideo, Users,
  ChevronRight, Trash2, Share2, Award, Shield, MicOff, Ban, RotateCw,
} from 'lucide-react';
import { POSTERS, PEOPLE, MESSAGES, QUIZ, QUEUE, ROOM } from '../data.js';
import { Avatar, Player, RoomHead, RoomMeta, Toggle, grad, useGo } from '../ui.jsx';

const FLOAT_EMOJI = ['❤', '🔥', '👏'];
let floatSeq = 100;

export default function Room() {
  const go = useGo();
  const [playing, setPlaying] = useState(true);
  const [pos, setPos] = useState(ROOM.startAt);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [tab, setTab] = useState('chat');
  const [floats, setFloats] = useState([
    { id: 1, emoji: '❤', top: '36%' },
    { id: 2, emoji: '🔥', top: '55%' },
  ]);
  const [dragY, setDragY] = useState(null);
  const dragStart = useRef(0);

  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => setPos((s) => Math.min(ROOM.duration, s + 1)), 1000);
    return () => clearInterval(t);
  }, [playing]);

  const closeSheet = useCallback(() => setSheetOpen(false), []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeSheet]);

  const spawnFloat = () => {
    const id = ++floatSeq;
    const emoji = FLOAT_EMOJI[Math.floor(Math.random() * FLOAT_EMOJI.length)];
    const top = `${34 + Math.round(Math.random() * 22)}%`;
    setFloats((f) => [...f, { id, emoji, top, fly: true }]);
    setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1850);
  };

  const openTab = (id) => { setTab(id); setSheetOpen(true); };

  const gripDown = (e) => {
    dragStart.current = e.clientY;
    setDragY(0);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const gripMove = (e) => {
    if (dragY === null) return;
    setDragY(Math.max(0, e.clientY - dragStart.current));
  };
  const gripUp = () => {
    if (dragY === null) return;
    if (dragY > 80 || dragY < 6) closeSheet();
    setDragY(null);
  };

  const tabBtn = (id, Icon, label) => (
    <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
      <Icon size={14} />{label}
    </button>
  );
  const peek = (id, Icon, title, sub) => (
    <button key={id} type="button" className="peek" onClick={() => openTab(id)}>
      <span className="peek-ic"><Icon size={18} /></span>
      <span className="peek-body"><b>{title}</b><span className="truncate">{sub}</span></span>
      <span className="peek-end"><ChevronRight size={16} /></span>
    </button>
  );

  return (
    <div className="screen">
      <RoomHead />
      <Player
        playing={playing}
        onTogglePlay={() => setPlaying((v) => !v)}
        pos={pos}
        onSkip={(d) => setPos((s) => Math.max(0, Math.min(ROOM.duration, s + d)))}
        pins
        floats={floats}
      />
      <RoomMeta />
      <div className="peeks">
        {peek('chat', MessageCircle, 'Chat', 'Leo: queue episode 5 after this, I am not stopping here')}
        {peek('queue', ListVideo, `Queue, ${QUEUE.length} of 5`, 'Up next: Shogun, episode 5')}
        {peek('people', Users, `People, ${ROOM.seats}`, `Invite code ${ROOM.code}`)}
      </div>

      <div className={`rs-wrap${sheetOpen ? '' : ' closed'}`}>
        <div className="rs-dim" onClick={closeSheet} />
        <div
          className="rs"
          role="dialog"
          aria-label="Room panel"
          style={dragY !== null ? { transform: `translateY(${dragY}px)`, transition: 'none' } : undefined}
        >
          <div
            className="rs-grip"
            aria-label="Close panel"
            onPointerDown={gripDown}
            onPointerMove={gripMove}
            onPointerUp={gripUp}
            onPointerCancel={gripUp}
          >
            <i />
          </div>
          <div className="rs-head">
            <div className="room-tabs">
              {tabBtn('chat', MessageCircle, 'Chat')}
              {tabBtn('queue', ListVideo, 'Queue')}
              {tabBtn('people', Users, 'People')}
            </div>
            <button type="button" className="icon-btn" onClick={closeSheet} aria-label="Close panel"><X size={17} /></button>
          </div>
          <div className="rs-mini">
            <button type="button" className="rs-mini-back" onClick={closeSheet} aria-label="Back to video">
              <span className="rs-mini-thumb" style={grad(POSTERS[0])} />
              <span style={{ minWidth: 0, flex: '1 1 auto' }}>
                <b className="truncate">{ROOM.episode}</b>
                <small><span className="live-dot ok" />In sync, tap to watch</small>
              </span>
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setPlaying((v) => !v)}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
          </div>
          {tab === 'chat' && <ChatPanel onReact={spawnFloat} />}
          {tab === 'queue' && <QueuePanel go={go} />}
          {tab === 'people' && <PeoplePanel go={go} />}
        </div>
      </div>
    </div>
  );
}

function ChatPanel({ onReact }) {
  const [msgs, setMsgs] = useState(MESSAGES);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [votes, setVotes] = useState(QUIZ.votes);
  const [picked, setPicked] = useState(-1);
  const scroller = useRef(null);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setMsgs((m) => [...m.filter((x) => x.kind !== 'typing'), { kind: 'msg', name: 'You', color: '#E9B44C', time: 'now', text: t, me: true }]);
    setText('');
    setReplyTo(null);
    requestAnimationFrame(() => {
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    });
  };

  const vote = (i) => {
    if (picked >= 0) return;
    setPicked(i);
    setVotes((v) => v.map((n, j) => (j === i ? n + 1 : n)));
  };

  return (
    <>
      <div className="scroll" style={{ paddingTop: 6 }} ref={scroller}>
        {msgs.map((m, i) => {
          if (m.kind === 'catchup') {
            return (
              <div key={i} className="bot-card">
                <b style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12.5 }}>
                  <Bot size={15} />AI catch up, 38 minutes in
                </b>
                <p style={{ marginTop: 6, color: 'var(--muted)' }}>
                  Toranaga has left Osaka with his court. Blackthorne just demonstrated the cannon drill. The room is split on what happens next.
                </p>
              </div>
            );
          }
          if (m.kind === 'quiz') {
            return (
              <div key={i} className="quiz">
                <b style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12.5 }}>
                  <Brain size={15} />Room trivia quiz{' '}
                  <span style={{ color: 'var(--faint)', fontWeight: 600 }}>by {QUIZ.by}</span>
                </b>
                <p style={{ fontSize: 13.5, marginTop: 8 }}>{QUIZ.q}</p>
                {QUIZ.options.map((o, j) => (
                  <button
                    key={o}
                    type="button"
                    className={`quiz-opt${picked >= 0 && j === QUIZ.correct ? ' correct' : ''}${picked === j && j !== QUIZ.correct ? ' wrong' : ''}`}
                    onClick={() => vote(j)}
                  >
                    {o} <span>{votes[j]}</span>
                  </button>
                ))}
                <p className="helper" style={{ marginTop: 9 }}>
                  {picked >= 0 ? 'Answer revealed. Votes are counted for the whole room.' : 'Tap an answer. Votes are counted for the whole room.'}
                </p>
              </div>
            );
          }
          if (m.kind === 'reactions') {
            return (
              <div key={i} className="reaction-counts">
                {m.items.map(([e, n]) => <span key={e}>{e} {n}</span>)}
              </div>
            );
          }
          if (m.kind === 'sys') return <div key={i} className="sys-line">{m.text}</div>;
          if (m.kind === 'typing') return <p key={i} className="sys-line is-left">{m.text}</p>;
          return (
            <div
              key={i}
              className="msg"
              onClick={() => setReplyTo(`${m.name}: ${m.text}`)}
              role="button"
              tabIndex={-1}
            >
              <Avatar name={m.name} color={m.color} size={32} />
              <div className="m-body">
                {m.reply ? <div className="reply-snippet">{m.reply}</div> : null}
                <b style={m.me ? { color: '#E9B44C' } : undefined}>{m.name}<time>{m.time}</time></b>
                <p>{m.text}</p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="chat-bar">
        {aiOpen && (
          <div className="ai-menu">
            <button type="button" disabled><Bot size={15} />Summary<span className="cd">in 4m</span></button>
            <button type="button" onClick={() => setAiOpen(false)}><Sparkles size={15} />Catch up</button>
            <button type="button" onClick={() => setAiOpen(false)}><Brain size={15} />Quiz</button>
          </div>
        )}
        {replyTo && (
          <div className="reply-bar">
            <span>Replying to {replyTo}</span>
            <button type="button" style={{ color: 'var(--muted)' }} onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={14} /></button>
          </div>
        )}
        <div className="composer">
          <button type="button" className="ai-btn" onClick={() => setAiOpen((v) => !v)} aria-label="AI tools">
            <Bot size={16} /><span className="ai-t">AI</span>
          </button>
          <div className="field">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
              placeholder={replyTo ? 'Write a reply...' : 'Message the room'}
              maxLength={500}
              aria-label="Message the room"
            />
          </div>
          <button type="button" className="react-btn" onClick={onReact} aria-label="Send reaction to video"><Smile size={19} /></button>
          <button type="button" className="send-btn" onClick={send} aria-label="Send message"><Send size={18} /></button>
        </div>
      </div>
    </>
  );
}

function QueuePanel({ go }) {
  const [rows, setRows] = useState(QUEUE);
  const [src, setSrc] = useState('YouTube');

  const playNow = (idx) => {
    setRows((r) => {
      const next = [...r];
      const [item] = next.splice(idx, 1);
      return [{ ...item, by: 'Up next' }, ...next];
    });
  };
  const remove = (idx) => setRows((r) => r.filter((_, j) => j !== idx));

  return (
    <div className="scroll">
      <div className="px h-row" style={{ marginTop: 14 }}>
        <span className="sec-title" style={{ fontSize: 16 }}>Queue, {rows.length} of 5</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => go('browse')}>Change video</button>
      </div>
      <p className="helper px" style={{ marginTop: 10 }}>
        The host can play any queued item right away. Change video swaps what is playing now.
      </p>
      <div style={{ display: 'flex', gap: 8, padding: '12px 20px 0' }}>
        <button
          type="button"
          className="chip active"
          onClick={() => setSrc((s) => (s === 'YouTube' ? 'Direct' : 'YouTube'))}
        >
          {src}
        </button>
        <div className="field" style={{ flex: '1 1 auto', height: 42, borderRadius: 'var(--r-pill)' }}>
          <input placeholder={src === 'YouTube' ? 'Search YouTube...' : 'Paste a video link...'} aria-label="Search source" />
        </div>
      </div>
      <div className="q-row" style={{ marginTop: 6 }}>
        <span className="room-thumb" style={{ ...grad(POSTERS[2]), width: 64, height: 40 }} />
        <span style={{ flex: '1 1 auto' }}>
          <b style={{ display: 'block', fontSize: 13, lineHeight: 1.3 }}>The Bear, season 3</b>
          <small style={{ color: 'var(--muted)', fontSize: 11.5 }}>TV show, Direct links</small>
        </span>
        <button type="button" className="btn btn-ghost btn-sm" style={{ flex: 'none' }} onClick={() => go('title')}>Episodes</button>
      </div>
      <div className="px" style={{ marginTop: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Playing next when this ends</span>
      </div>
      {rows.length === 0 && (
        <p className="helper px" style={{ marginTop: 8 }}>Queue is empty. Add a video and it plays after this one ends.</p>
      )}
      {rows.map((x, i) => (
        <div key={x.title} className="q-row">
          <span className="poster" style={{ ...grad(POSTERS[x.p]), width: 40, height: 60 }} />
          <span style={{ flex: '1 1 auto' }}>
            <b style={{ display: 'block', fontSize: 13.5, lineHeight: 1.3 }}>{x.title}</b>
            <small style={{ color: 'var(--muted)', fontSize: 11.5 }}>{x.by}</small>
          </span>
          <button type="button" className="icon-btn" onClick={() => playNow(i)} aria-label="Play now"><Play size={13} /></button>
          <button type="button" className="icon-btn" style={{ color: 'var(--danger-ink)' }} onClick={() => remove(i)} aria-label="Remove from queue"><Trash2 size={14} /></button>
        </div>
      ))}
      <p className="helper px" style={{ marginTop: 10 }}>Auto plays after a 5 second prompt.</p>
    </div>
  );
}

function PeoplePanel({ go }) {
  const [openIdx, setOpenIdx] = useState(2);
  const [locked, setLocked] = useState(false);
  const [banned, setBanned] = useState(true);

  const menu = (x) => (
    <div className="person-menu">
      <button type="button" onClick={() => setOpenIdx(-1)}><Award size={14} />View passport</button>
      <button type="button" onClick={() => setOpenIdx(-1)}><Shield size={14} />{x.role === 'Co-host' ? 'Demote to viewer' : 'Promote to co-host'}</button>
      <button type="button" onClick={() => setOpenIdx(-1)}><MicOff size={14} />{x.state === 'Chat muted' ? 'Unmute chat' : 'Mute chat'}</button>
      <button type="button" className="danger" onClick={() => setOpenIdx(-1)}><X size={14} />Remove from room</button>
      <button type="button" className="danger" onClick={() => setOpenIdx(-1)}><Ban size={14} />Ban from room</button>
    </div>
  );

  return (
    <div className="scroll">
      <div className="card" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>
          <b style={{ fontSize: 14, display: 'block' }}>Invite code</b>
          <small className="mono" style={{ color: 'var(--text)', fontSize: 15, fontWeight: 800, letterSpacing: '.12em' }}>{ROOM.code}</small>
        </span>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => go('share')}><Share2 size={14} />Share</button>
      </div>
      <div className="card" style={{ marginTop: 12, padding: '4px 16px' }}>
        <div className="switch-row">
          <span><b>Lock joins</b><small>Room is open to new joiners.</small></span>
          <Toggle on={locked} onChange={setLocked} label="Lock joins" />
        </div>
      </div>
      <p className="helper px" style={{ marginTop: 12 }}>Tap a participant for their passport and host actions.</p>
      {PEOPLE.map((x, i) => (
        <div key={x.n}>
          <button type="button" className="person" onClick={() => setOpenIdx(openIdx === i ? -1 : i)}>
            <Avatar name={x.n} color={x.c} size={38} />
            <span style={{ flex: '1 1 auto' }}>
              <b className="truncate" style={{ display: 'block', fontSize: 14 }}>
                {x.n}
                {x.state === 'Chat muted' ? <span style={{ color: 'var(--danger-ink)' }}> <MicOff size={13} style={{ verticalAlign: '-2px' }} /></span> : null}
              </b>
              <small style={{ display: 'block', color: 'var(--muted)', fontSize: 11.5, lineHeight: 1.4 }}>{x.badge}, {x.state}</small>
            </span>
            {i === 0
              ? <span className="pill pill-amber">HOST</span>
              : i === 1
                ? <span className="pill pill-glass">CO-HOST</span>
                : <span style={{ color: 'var(--faint)', flex: 'none' }}><ChevronRight size={16} /></span>}
          </button>
          {i > 0 && openIdx === i ? menu(x) : null}
        </div>
      ))}
      <div className="px" style={{ marginTop: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Banned ({banned ? 1 : 0})</span>
      </div>
      {banned ? (
        <div className="person">
          <span className="mono truncate" style={{ flex: '1 1 auto', fontSize: 11.5, color: 'var(--muted)' }}>uid 8f3ka...29x</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBanned(false)}><RotateCw size={13} />Unban</button>
        </div>
      ) : (
        <p className="helper px" style={{ marginTop: 6 }}>Nobody is banned.</p>
      )}
      <div className="card" style={{ marginTop: 14 }}>
        <b style={{ fontSize: 14 }}>Room info</b>
        <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.9, marginTop: 8 }}>
          Mode: Direct video<br />Privacy: Public
        </div>
      </div>
      <div className="px" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-danger" style={{ height: 44, fontSize: 14 }} onClick={() => go('home')}>
          End room for everyone
        </button>
      </div>
    </div>
  );
}

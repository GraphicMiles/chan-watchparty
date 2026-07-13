import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Smile, X, ArrowDown, Bot, Loader2, Sparkles, Brain, CheckCircle, Volume2 } from 'lucide-react'
import { collection, addDoc, serverTimestamp, doc, onSnapshot } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { Input, Button, IconButton, Modal, useToast } from '../../../shared/ui/index.js'
import ChatMessage from './ChatMessage.jsx'
import styles from './Chat.module.css'

const REACTIONS = ['heart', 'thumbs-up', 'laugh', 'fire', 'clap', 'wow']
const REACTION_SYMBOLS = { heart: '\u2764', 'thumbs-up': '\ud83d\udc4d', laugh: '\ud83d\ude02', fire: '\ud83d\udd25', clap: '\ud83d\udc4f', wow: '\ud83d\ude2e' }
const FLOATING_EMOJIS = ['\u2764', '\ud83d\udd25', '\ud83d\ude02', '\ud83d\udc4f', '\ud83d\ude2e', '\ud83d\udcaf']
const SOUND_FX = {
  airhorn: { name: 'Airhorn', emoji: '📯', url: 'https://cdn.freesound.org/previews/435/435255_8863641-lq.mp3' },
  cheer: { name: 'Stadium Cheer', emoji: '👏', url: 'https://cdn.freesound.org/previews/337/337049_5121236-lq.mp3' },
  boom: { name: 'Dramatic Boom', emoji: '💥', url: 'https://cdn.freesound.org/previews/266/266105_4486188-lq.mp3' },
  laugh: { name: 'Crowd Laugh', emoji: '🤣', url: 'https://cdn.freesound.org/previews/369/369515_6687700-lq.mp3' },
  applause: { name: 'Applause', emoji: '🎉', url: 'https://cdn.freesound.org/previews/483/483652_1015240-lq.mp3' },
}

const TYPING_DEBOUNCE = 1200
const TYPING_WRITE_INTERVAL = 2000
const GROUP_WINDOW_MS = 60_000
const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

function isGrouped(prev, curr) {
  if (!prev || !curr) return false
  if (prev.type === 'system' || curr.type === 'system' || prev.type === 'bot' || curr.type === 'bot') return false
  if (prev.uid !== curr.uid) return false
  return Math.abs((curr.createdAt || 0) - (prev.createdAt || 0)) <= GROUP_WINDOW_MS
}

export default function Chat({ messages, sendMessage, user, roomId, typing, setTyping }) {
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [cooldown, setCooldown] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  const [showEmoji, setShowEmoji] = useState(false)
  const [showFxMenu, setShowFxMenu] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const [optimistic, setOptimistic] = useState([])
  
  const [aiLoading, setAiLoading] = useState(false)
  const [catchupLoading, setCatchupLoading] = useState(false)
  const [quizLoading, setQuizLoading] = useState(false)
  const [aiCooldownSec, setAiCooldownSec] = useState(0)
  const [catchupModalData, setCatchupModalData] = useState(null)
  const [activeQuiz, setActiveQuiz] = useState(null)
  const [myQuizVote, setMyQuizVote] = useState(null)
  const [revealQuizAnswer, setRevealQuizAnswer] = useState(false)
  
  const bottomRef = useRef(null)
  const listRef = useRef(null)
  const typingTimer = useRef(null)
  const lastTypingWrite = useRef(0)
  const prevCount = useRef(0)

  useEffect(() => {
    if (!roomId) return undefined
    const ref = doc(db, 'rooms', roomId, 'aiState', 'summary')
    return onSnapshot(ref, (snap) => {
      if (!snap.exists()) {
        setAiCooldownSec(0)
        return
      }
      const data = snap.data()
      const lastMs = data?.lastSummaryAt?.toMillis?.() || data?.lastSummaryAtMs || 0
      const diff = Date.now() - lastMs
      if (diff < COOLDOWN_MS) {
        setAiCooldownSec(Math.ceil((COOLDOWN_MS - diff) / 1000))
      } else {
        setAiCooldownSec(0)
      }
    })
  }, [roomId])

  useEffect(() => {
    if (!roomId) return undefined
    const ref = doc(db, 'rooms', roomId, 'quiz', 'current')
    return onSnapshot(ref, (snap) => {
      if (!snap.exists() || !snap.data()?.active) {
        setActiveQuiz(null)
        setMyQuizVote(null)
        return
      }
      const data = snap.data()
      setActiveQuiz(data)
      if (user?.uid && data.votes?.[user.uid] !== undefined) {
        setMyQuizVote(data.votes[user.uid])
      } else {
        setMyQuizVote(null)
      }
      const createdMs = data.createdAt?.toMillis?.() || data.createdAtMs || Date.now()
      if (Date.now() - createdMs > 45000 || (user?.uid && data.votes?.[user.uid] !== undefined)) {
        setRevealQuizAnswer(true)
      } else {
        setRevealQuizAnswer(false)
      }
    })
  }, [roomId, user?.uid])

  useEffect(() => {
    if (aiCooldownSec <= 0) return undefined
    const timer = setInterval(() => {
      setAiCooldownSec((s) => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [aiCooldownSec])

  useEffect(() => {
    return () => {
      clearTimeout(typingTimer.current)
      setTyping?.(false)
    }
  }, [setTyping])

  const merged = (() => {
    const serverIds = new Set(messages.map((m) => m.id))
    const pending = optimistic.filter((m) => !serverIds.has(m.id) && !m.replaced)
    return [...messages, ...pending].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  })()

  useEffect(() => {
    setOptimistic((list) =>
      list.filter((opt) => {
        const found = messages.some(
          (m) =>
            m.uid === opt.uid &&
            m.text === opt.text &&
            Math.abs((m.createdAt || 0) - (opt.createdAt || 0)) < 15000
        )
        return !found
      })
    )
  }, [messages])

  useEffect(() => {
    if (atBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      setUnseen(0)
    } else if (merged.length > prevCount.current) {
      setUnseen((n) => n + (merged.length - prevCount.current))
    }
    prevCount.current = merged.length
  }, [merged.length, atBottom])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setAtBottom(nearBottom)
    if (nearBottom) setUnseen(0)
  }

  const jumpToLatest = () => {
    setAtBottom(true)
    setUnseen(0)
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const handleInputChange = (value) => {
    setText(value.slice(0, 500))
    if (!value.trim()) {
      setTyping(false)
      clearTimeout(typingTimer.current)
      lastTypingWrite.current = 0
      return
    }
    const now = Date.now()
    if (now - lastTypingWrite.current > TYPING_WRITE_INTERVAL) {
      lastTypingWrite.current = now
      setTyping(true)
    }
    clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => setTyping(false), TYPING_DEBOUNCE)
  }

  const insertEmoji = (key) => {
    setText((t) => (t + REACTION_SYMBOLS[key]).slice(0, 500))
    setShowEmoji(false)
  }

  const sendFloatingReaction = useCallback(async (emoji) => {
    if (!user || !roomId) return
    try {
      await addDoc(collection(db, 'rooms', roomId, 'floatingReactions'), {
        emoji,
        uid: user.uid,
        displayName: user.displayName || 'Viewer',
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
      })
    } catch {
      /* ignore */
    }
  }, [user, roomId])

  const triggerSoundFx = useCallback(async (fxKey) => {
    if (!user || !roomId) return
    try {
      setShowFxMenu(false)
      await addDoc(collection(db, 'rooms', roomId, 'soundEffects'), {
        soundKey: fxKey,
        uid: user.uid,
        displayName: user.displayName || 'Viewer',
        createdAt: serverTimestamp(),
        createdAtMs: Date.now(),
      })
    } catch (err) {
      toast(err.message || 'Could not play sound effect', { variant: 'error' })
    }
  }, [user, roomId, toast])

  const requestAiSummary = useCallback(async () => {
    if (!user || !roomId) return
    if (aiCooldownSec > 0) {
      toast(`AI Summary is on cooldown. Please wait ${Math.ceil(aiCooldownSec / 60)} min.`, { variant: 'warning' })
      return
    }
    try {
      setAiLoading(true)
      const token = await user.getIdToken()
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'ai', roomId, uid: user.uid }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        if (data?.onCooldown) {
          setAiCooldownSec(data.remainingSec || 300)
          toast(data.message || 'AI Summary is on cooldown', { variant: 'warning' })
        } else {
          throw new Error(data?.error || 'Could not generate summary')
        }
      } else {
        toast('AI Summary generated and posted to chat!', { variant: 'success' })
      }
    } catch (err) {
      toast(err.message || 'AI Summary request failed', { variant: 'error' })
    } finally {
      setAiLoading(false)
    }
  }, [user, roomId, aiCooldownSec, toast])

  const requestSmartCatchup = useCallback(async () => {
    if (!user || !roomId) return
    try {
      setCatchupLoading(true)
      const token = await user.getIdToken()
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'catchup', roomId, uid: user.uid }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data?.error || 'Could not generate recap')
      }
      setCatchupModalData(data)
    } catch (err) {
      toast(err.message || 'Smart Catch-Up failed', { variant: 'error' })
    } finally {
      setCatchupLoading(false)
    }
  }, [user, roomId, toast])

  const requestGenerateQuiz = useCallback(async () => {
    if (!user || !roomId) return
    try {
      setQuizLoading(true)
      const token = await user.getIdToken()
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'quiz', roomId, uid: user.uid }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data?.error || data?.message || 'Could not generate room quiz')
      }
      toast('New Room Quiz generated!', { variant: 'success' })
    } catch (err) {
      toast(err.message || 'Quiz generation failed', { variant: 'error' })
    } finally {
      setQuizLoading(false)
    }
  }, [user, roomId, toast])

  const voteQuizOption = useCallback(async (optionIndex) => {
    if (!user || !roomId || myQuizVote !== null) return
    try {
      setMyQuizVote(optionIndex)
      setRevealQuizAnswer(true)
      const token = await user.getIdToken()
      await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'votequiz', roomId, uid: user.uid, optionIndex }),
      })
    } catch {
      /* ignore */
    }
  }, [user, roomId, myQuizVote])

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!text.trim() || cooldown) return
    const payloadText = text.trim()
    const reply = replyTo
      ? { id: replyTo.id, displayName: replyTo.displayName, text: replyTo.text }
      : null
    const tempId = `local-${Date.now()}`
    setOptimistic((list) => [
      ...list,
      {
        id: tempId,
        uid: user?.uid,
        displayName: user?.displayName || 'Viewer',
        text: payloadText,
        createdAt: Date.now(),
        replyTo: reply,
        pending: true,
      },
    ])
    setText('')
    setReplyTo(null)
    setCooldown(true)
    setTyping(false)
    clearTimeout(typingTimer.current)
    setAtBottom(true)
    try {
      await sendMessage(payloadText, reply)
    } catch {
      setOptimistic((list) => list.filter((m) => m.id !== tempId))
    }
    setTimeout(() => setCooldown(false), 1000)
  }

  const typingNames = (typing || [])
    .filter((t) => t.id !== user?.uid)
    .map((t) => t.displayName)

  const nearLimit = text.length >= 400

  const quizVoteCounts = (() => {
    if (!activeQuiz || !activeQuiz.votes) return {}
    const counts = {}
    Object.values(activeQuiz.votes).forEach((idx) => {
      counts[idx] = (counts[idx] || 0) + 1
    })
    return counts
  })()

  return (
    <div className={styles.chat}>
      <div className={styles.chatActionsBar}>
        <div className={styles.floatingReactionsBar}>
          {FLOATING_EMOJIS.map((emoji, idx) => (
            <button
              key={idx}
              type="button"
              className={styles.floatingReactionBtn}
              onClick={() => sendFloatingReaction(emoji)}
              title={`Send ${emoji} to video canvas`}
            >
              {emoji}
            </button>
          ))}
          
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className={styles.floatingReactionBtn}
              onClick={() => setShowFxMenu(!showFxMenu)}
              title="Room Sound Effects (#11)"
            >
              <Volume2 size={15} />
            </button>
            {showFxMenu && (
              <div className={styles.emojiGrid} style={{ right: 'auto', left: 0, gridTemplateColumns: 'repeat(1, 1fr)', gap: '4px', minWidth: '150px' }}>
                {Object.entries(SOUND_FX).map(([key, fx]) => (
                  <button
                    key={key}
                    type="button"
                    className={styles.emojiButton}
                    style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', textAlign: 'left', padding: '6px 8px' }}
                    onClick={() => triggerSoundFx(key)}
                  >
                    <span>{fx.emoji}</span>
                    <span>{fx.name.replace(fx.emoji, '').trim()}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={styles.aiToolsRow}>
          <button
            type="button"
            className={styles.aiButton}
            onClick={requestAiSummary}
            disabled={aiLoading || aiCooldownSec > 0}
            title={aiCooldownSec > 0 ? `AI on cooldown (${Math.ceil(aiCooldownSec / 60)}m)` : 'Get AI Chat & Room Summary'}
          >
            {aiLoading ? <Loader2 size={13} className="spin" /> : <Bot size={13} />}
            <span>{aiCooldownSec > 0 ? `${Math.ceil(aiCooldownSec / 60)}m` : 'Summary'}</span>
          </button>

          <button
            type="button"
            className={styles.catchupButton}
            onClick={requestSmartCatchup}
            disabled={catchupLoading}
            title="Smart Catch-Up: Get a 3-bullet spoiler-free timeline recap of what you missed"
          >
            {catchupLoading ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
            <span>Catch-Up</span>
          </button>

          <button
            type="button"
            className={styles.quizButton}
            onClick={requestGenerateQuiz}
            disabled={quizLoading}
            title="Generate AI Room Trivia Quiz"
          >
            {quizLoading ? <Loader2 size={13} className="spin" /> : <Brain size={13} />}
            <span>Quiz</span>
          </button>
        </div>
      </div>

      {activeQuiz && (
        <div className={styles.quizCard}>
          <div className={styles.quizHeader}>
            <span className={styles.quizBadge}><Brain size={13} /> Room Trivia Quiz</span>
            <span className={styles.quizAuthor}>by {activeQuiz.createdByName}</span>
          </div>
          <p className={styles.quizQuestion}>{activeQuiz.question}</p>
          <div className={styles.quizOptionsGrid}>
            {activeQuiz.options?.map((opt, idx) => {
              const isSelected = myQuizVote === idx
              const isCorrect = revealQuizAnswer && activeQuiz.correctIndex === idx
              const isWrong = revealQuizAnswer && isSelected && !isCorrect
              const count = quizVoteCounts[idx] || 0
              return (
                <button
                  key={idx}
                  type="button"
                  className={`${styles.quizOptionBtn} ${isSelected ? styles.quizOptionSelected : ''} ${isCorrect ? styles.quizOptionCorrect : ''} ${isWrong ? styles.quizOptionWrong : ''}`}
                  onClick={() => voteQuizOption(idx)}
                  disabled={myQuizVote !== null && revealQuizAnswer}
                >
                  <span className={styles.quizOptionText}>{opt}</span>
                  {(myQuizVote !== null || count > 0) && <span className={styles.quizVoteBadge}>{count}</span>}
                  {isCorrect && <CheckCircle size={14} className={styles.correctIcon} style={{ color: '#00FF7F', marginLeft: 'auto' }} />}
                </button>
              )
            })}
          </div>
          {revealQuizAnswer && activeQuiz.funFact && (
            <div className={styles.funFactBox}>
              <strong>Fun Fact:</strong> {activeQuiz.funFact}
            </div>
          )}
        </div>
      )}

      <div className={styles.messages} ref={listRef} onScroll={onScroll}>
        {merged.length === 0 && (
          <span className={styles.empty}>No messages yet -- say hi or ask AI for a summary!</span>
        )}
        {merged.map((m, i) => {
          if (m.type === 'system' || m.type === 'bot') {
            return (
              <div key={m.id} className={styles.system}>
                {m.text}
              </div>
            )
          }
          const prev = merged[i - 1]
          const grouped = isGrouped(prev, m)
          return (
            <ChatMessage
              key={m.id}
              message={m}
              user={user}
              roomId={roomId}
              onReply={setReplyTo}
              grouped={grouped}
            />
          )
        })}
        <div ref={bottomRef} />
        {typingNames.length > 0 && (
          <div className={styles.typing}>
            <div className={styles.typingDot} />
            <div className={styles.typingDot} />
            <div className={styles.typingDot} />
            <span>
              {typingNames.length === 1
                ? `${typingNames[0]} is typing...`
                : `${typingNames.slice(0, 2).join(', ')}${typingNames.length > 2 ? ` +${typingNames.length - 2}` : ''} are typing...`}
            </span>
          </div>
        )}
      </div>

      {unseen > 0 && (
        <button type="button" className={styles.newPill} onClick={jumpToLatest}>
          <ArrowDown size={12} />
          {unseen} new message{unseen === 1 ? '' : 's'}
        </button>
      )}

      <form onSubmit={onSubmit} className={styles.form}>
        {replyTo && (
          <div className={styles.replyPreview}>
            <span>
              Replying to {replyTo.displayName}: {replyTo.text.slice(0, 60)}
              {replyTo.text.length > 60 ? '...' : ''}
            </span>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              className={styles.clearReply}
              aria-label="Cancel reply"
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className={styles.inputRow}>
          <Input
            value={text}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={replyTo ? 'Write a reply...' : 'Send a message...'}
            maxLength={500}
            className={styles.input}
          />
          <div className={styles.emojiPicker}>
            <IconButton type="button" onClick={() => setShowEmoji((s) => !s)} active={showEmoji} aria-label="Insert emoji">
              <Smile size={18} />
            </IconButton>
            {showEmoji && (
              <div className={styles.emojiGrid}>
                {REACTIONS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={styles.emojiButton}
                    onClick={() => insertEmoji(key)}
                  >
                    {REACTION_SYMBOLS[key]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button
            type="submit"
            disabled={cooldown || !text.trim()}
            size="sm"
            className={styles.sendButton}
            variant="cta"
          >
            <Send size={16} />
          </Button>
        </div>
        {nearLimit && (
          <div className={styles.counter} aria-live="polite">
            {text.length}/500
          </div>
        )}
      </form>

      <Modal
        open={Boolean(catchupModalData)}
        title="Smart Catch-Up Recap"
        icon={Sparkles}
        onClose={() => setCatchupModalData(null)}
      >
        {catchupModalData && (
          <div className={styles.catchupBody}>
            <div className={styles.catchupHeader}>
              <h4>{catchupModalData.title || 'Video Timeline'}</h4>
              <span className={styles.catchupTimeBadge}>~{catchupModalData.minutesIn} min in</span>
            </div>
            <div className={styles.catchupText}>
              {catchupModalData.catchup?.split('\n').map((line, idx) => (
                <p key={idx}>{line}</p>
              ))}
            </div>
            <div className={styles.catchupActions}>
              <Button variant="cta" onClick={() => setCatchupModalData(null)}>
                Got It — Let&apos;s Watch!
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

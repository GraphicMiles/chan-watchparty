import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Smile, X, ArrowDown, Bot, Loader2 } from 'lucide-react'
import { collection, addDoc, serverTimestamp, doc, onSnapshot } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import { Input, Button, IconButton, useToast } from '../../../shared/ui/index.js'
import ChatMessage from './ChatMessage.jsx'
import styles from './Chat.module.css'

const REACTIONS = ['heart', 'thumbs-up', 'laugh', 'fire', 'clap', 'wow']
const REACTION_SYMBOLS = { heart: '\u2764', 'thumbs-up': '\ud83d\udc4d', laugh: '\ud83d\ude02', fire: '\ud83d\udd25', clap: '\ud83d\udc4f', wow: '\ud83d\ude2e' }
const FLOATING_EMOJIS = ['\u2764', '\ud83d\udd25', '\ud83d\ude02', '\ud83d\udc4f', '\ud83d\ude2e', '\ud83d\udcaf']
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
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const [optimistic, setOptimistic] = useState([])
  const [aiLoading, setAiLoading] = useState(false)
  const [aiCooldownSec, setAiCooldownSec] = useState(0)
  
  const bottomRef = useRef(null)
  const listRef = useRef(null)
  const typingTimer = useRef(null)
  const lastTypingWrite = useRef(0)
  const prevCount = useRef(0)

  // Track AI Summary cooldown from Firestore so all users see when summary is ready/cooldown
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

  // Count down AI cooldown ticker every second
  useEffect(() => {
    if (aiCooldownSec <= 0) return undefined
    const timer = setInterval(() => {
      setAiCooldownSec((s) => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(timer)
  }, [aiCooldownSec])

  // Ensure typing status is cleared when unmounting
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

  const requestAiSummary = useCallback(async () => {
    if (!user || !roomId) return
    if (aiCooldownSec > 0) {
      toast(`AI Summary is on cooldown. Please wait ${Math.ceil(aiCooldownSec / 60)} min.`, { variant: 'warning' })
      return
    }
    try {
      setAiLoading(true)
      const token = await user.getIdToken()
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'summary', roomId, uid: user.uid }),
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

  return (
    <div className={styles.chat}>
      {/* Top Actions: Floating Quick Reactions + Ask AI Summary */}
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
        </div>

        <button
          type="button"
          className={styles.aiButton}
          onClick={requestAiSummary}
          disabled={aiLoading || aiCooldownSec > 0}
          title={aiCooldownSec > 0 ? `AI on cooldown (${Math.ceil(aiCooldownSec / 60)}m)` : 'Get AI Chat & Room Summary'}
        >
          {aiLoading ? <Loader2 size={13} className="spin" /> : <Bot size={14} />}
          <span>{aiCooldownSec > 0 ? `AI (${Math.ceil(aiCooldownSec / 60)}m)` : 'AI Summary'}</span>
        </button>
      </div>

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
    </div>
  )
}

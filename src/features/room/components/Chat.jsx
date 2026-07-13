import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Smile, X, ArrowDown } from 'lucide-react'
import { Input, Button, IconButton } from '../../../shared/ui/index.js'
import ChatMessage from './ChatMessage.jsx'
import styles from './Chat.module.css'

const REACTIONS = ['heart', 'thumbs-up', 'laugh', 'fire', 'clap', 'wow']
const REACTION_SYMBOLS = { heart: '\u2764', 'thumbs-up': '\ud83d\udc4d', laugh: '\ud83d\ude02', fire: '\ud83d\udd25', clap: '\ud83d\udc4f', wow: '\ud83d\ude2e' }
const TYPING_DEBOUNCE = 1200
const TYPING_WRITE_INTERVAL = 2000
const GROUP_WINDOW_MS = 60_000

function isGrouped(prev, curr) {
  if (!prev || !curr) return false
  if (prev.type === 'system' || curr.type === 'system') return false
  if (prev.uid !== curr.uid) return false
  return Math.abs((curr.createdAt || 0) - (prev.createdAt || 0)) <= GROUP_WINDOW_MS
}

export default function Chat({ messages, sendMessage, user, roomId, typing, setTyping }) {
  const [text, setText] = useState('')
  const [cooldown, setCooldown] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  const [showEmoji, setShowEmoji] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const [optimistic, setOptimistic] = useState([])
  const bottomRef = useRef(null)
  const listRef = useRef(null)
  const typingTimer = useRef(null)
  const lastTypingWrite = useRef(0)
  const prevCount = useRef(0)

  // Ensure typing status is cleared when unmounting or changing rooms
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
      <div className={styles.messages} ref={listRef} onScroll={onScroll}>
        {merged.length === 0 && (
          <span className={styles.empty}>No messages yet -- say hi</span>
        )}
        {merged.map((m, i) => {
          if (m.type === 'system') {
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

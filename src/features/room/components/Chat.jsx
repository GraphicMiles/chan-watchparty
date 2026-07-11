import { useState, useRef, useEffect } from 'react'
import { Card, Input, Button, IconButton } from '../../../shared/ui/index.js'
import ChatMessage from './ChatMessage.jsx'
import styles from './Chat.module.css'

const EMOJIS = ['😀', '😂', '😍', '🔥', '👍', '❤️', '👏', '😮', '🎉', '🤔', '😢', '😡']
const TYPING_DEBOUNCE = 1200
const TYPING_WRITE_INTERVAL = 2000

export default function Chat({ messages, sendMessage, user, roomId, typing, setTyping }) {
  const [text, setText] = useState('')
  const [cooldown, setCooldown] = useState(false)
  const [replyTo, setReplyTo] = useState(null)
  const [showEmoji, setShowEmoji] = useState(false)
  const bottomRef = useRef(null)
  const typingTimer = useRef(null)
  const lastTypingWrite = useRef(0)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleInputChange = (value) => {
    setText(value)
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

  const insertEmoji = (emoji) => {
    setText((t) => t + emoji)
    setShowEmoji(false)
  }

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!text.trim() || cooldown) return
    await sendMessage(text, replyTo ? { id: replyTo.id, displayName: replyTo.displayName, text: replyTo.text } : null)
    setText('')
    setReplyTo(null)
    setCooldown(true)
    setTyping(false)
    clearTimeout(typingTimer.current)
    setTimeout(() => setCooldown(false), 1000)
  }

  const typingNames = typing
    .filter((t) => t.id !== user?.uid)
    .map((t) => t.displayName)

  return (
    <Card className={styles.chat}>
      <h3 className={styles.title}>Chat</h3>
      <div className={styles.messages}>
        {messages.length === 0 && (
          <span className={styles.empty}>No messages yet. Say hi!</span>
        )}
        {messages.map((m) => (
          <ChatMessage
            key={m.id}
            message={m}
            user={user}
            roomId={roomId}
            onReply={setReplyTo}
          />
        ))}
        <div ref={bottomRef} />
        {typingNames.length > 0 && (
          <div className={styles.typing}>
            <div className={styles.typingDot} />
            <div className={styles.typingDot} />
            <div className={styles.typingDot} />
            <span>
              {typingNames.length === 1
                ? `${typingNames[0]} is typing…`
                : `${typingNames.slice(0, 2).join(', ')}${typingNames.length > 2 ? ` +${typingNames.length - 2}` : ''} are typing…`}
            </span>
          </div>
        )}
      </div>
      <form onSubmit={onSubmit} className={styles.form}>
        {replyTo && (
          <div className={styles.replyPreview}>
            <span>Replying to {replyTo.displayName}: {replyTo.text.slice(0, 60)}{replyTo.text.length > 60 ? '…' : ''}</span>
            <button type="button" onClick={() => setReplyTo(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
              ✕
            </button>
          </div>
        )}
        <div className={styles.inputRow}>
          <Input
            value={text}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={replyTo ? 'Write a reply…' : 'Send a message…'}
            maxLength={500}
            className={styles.input}
          />
          <div className={styles.emojiPicker}>
            <IconButton type="button" onClick={() => setShowEmoji((s) => !s)} active={showEmoji}>
              😊
            </IconButton>
            {showEmoji && (
              <div className={styles.emojiGrid}>
                {EMOJIS.map((emoji) => (
                  <button key={emoji} type="button" className={styles.emojiButton} onClick={() => insertEmoji(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <Button type="submit" disabled={cooldown || !text.trim()}>
            Send
          </Button>
        </div>
      </form>
    </Card>
  )
}

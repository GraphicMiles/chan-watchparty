import { useState, useRef, useEffect } from 'react'
import { Card, Input, Button } from '../../../shared/ui/index.js'
import styles from './Chat.module.css'

export default function Chat({ messages, sendMessage }) {
  const [text, setText] = useState('')
  const [cooldown, setCooldown] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const onSubmit = async (e) => {
    e.preventDefault()
    if (!text.trim() || cooldown) return
    await sendMessage(text)
    setText('')
    setCooldown(true)
    setTimeout(() => setCooldown(false), 1000)
  }

  return (
    <Card className={styles.chat}>
      <h3 className={styles.title}>Chat</h3>
      <div className={styles.messages}>
        {messages.length === 0 && (
          <span className={styles.empty}>No messages yet. Say hi!</span>
        )}
        {messages.map((m) => (
          <div key={m.id} className={styles.message}>
            <div className={styles.meta}>
              <span className={styles.author}>{m.displayName}</span>
              <span className={styles.time}>
                {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <span className={styles.text}>{m.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={onSubmit} className={styles.form}>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Send a message…"
          maxLength={500}
          className={styles.input}
        />
        <Button type="submit" disabled={cooldown || !text.trim()}>
          Send
        </Button>
      </form>
    </Card>
  )
}

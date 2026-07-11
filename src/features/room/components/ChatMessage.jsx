import { useEffect, useState } from 'react'
import { doc, collection, onSnapshot, setDoc, deleteDoc } from 'firebase/firestore'
import { db } from '../../../shared/lib/firebase.js'
import styles from './ChatMessage.module.css'

const REACTION_EMOJIS = ['❤️', '👍', '😂', '🔥', '👏', '😮']

export default function ChatMessage({ message, user, roomId, onReply, grouped = false }) {
  const [reactions, setReactions] = useState([])
  const [showEmoji, setShowEmoji] = useState(false)
  const isMe = message.uid === user?.uid

  useEffect(() => {
    if (!roomId || !message.id || message.pending || String(message.id).startsWith('local-')) return
    const unsub = onSnapshot(
      collection(db, 'rooms', roomId, 'messages', message.id, 'reactions'),
      (snap) => setReactions(snap.docs.map((d) => ({ uid: d.id, emoji: d.data().emoji })))
    )
    return unsub
  }, [roomId, message.id, message.pending])

  const counts = reactions.reduce((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] || 0) + 1
    return acc
  }, {})
  const myReaction = reactions.find((r) => r.uid === user?.uid)

  const react = async (emoji) => {
    if (!user || !message.id || message.pending) return
    const ref = doc(db, 'rooms', roomId, 'messages', message.id, 'reactions', user.uid)
    if (myReaction?.emoji === emoji) {
      await deleteDoc(ref).catch(() => {})
    } else {
      await setDoc(ref, { emoji }).catch(() => {})
    }
    setShowEmoji(false)
  }

  return (
    <div className={`${styles.message} ${grouped ? styles.grouped : ''} ${message.pending ? styles.pending : ''} ${isMe ? styles.mine : ''}`}>
      {message.replyTo && (
        <div className={styles.replySnippet}>
          <span className={styles.replyAuthor}>{message.replyTo.displayName}</span>
          <span>{message.replyTo.text}</span>
        </div>
      )}
      {!grouped && (
        <div className={styles.meta}>
          <span className={styles.author}>{message.displayName}</span>
          <span className={styles.time}>
            {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      )}
      <span className={styles.text}>{message.text}</span>
      {!message.pending && (
        <div className={styles.actions}>
          <button type="button" className={styles.actionButton} onClick={() => onReply(message)}>
            Reply
          </button>
          <div className={styles.reactWrap}>
            <button type="button" className={styles.actionButton} onClick={() => setShowEmoji((s) => !s)}>
              React
            </button>
            {showEmoji && (
              <div className={styles.emojiMenu}>
                {REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className={styles.emojiBtn}
                    onClick={() => react(emoji)}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {Object.keys(counts).length > 0 && (
        <div className={styles.reactions}>
          {Object.entries(counts).map(([emoji, count]) => (
            <button
              key={emoji}
              type="button"
              className={`${styles.reaction} ${myReaction?.emoji === emoji ? styles.reactionActive : ''}`}
              onClick={() => react(emoji)}
            >
              {emoji} <span className={styles.reactionCount}>{count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Button, Input, Modal } from '../../../shared/ui/index.js'
import styles from './ShareRoom.module.css'

export default function ShareRoom({ room, roomId, open, onClose }) {
  const [qr, setQr] = useState('')
  const url = room?.inviteCode
    ? `${window.location.origin}/room/${roomId}?invite=${room.inviteCode}`
    : `${window.location.origin}/room/${roomId}`

  useEffect(() => {
    if (!open) return
    QRCode.toDataURL(url, {
      width: 200,
      margin: 2,
      color: { dark: '#7c89f7', light: '#0f111a' },
    })
      .then(setQr)
      .catch(() => setQr(''))
  }, [open, url])

  const copy = () => {
    navigator.clipboard.writeText(url)
    alert('Link copied')
  }

  const share = () => {
    if (navigator.share) {
      navigator.share({
        title: room?.title,
        text: `Join ${room?.title} on Chan`,
        url,
      })
    } else {
      copy()
    }
  }

  return (
    <Modal open={open} title="Share room" onClose={onClose}>
      <div className={styles.share}>
        {qr && <img src={qr} alt="QR code" className={styles.qr} />}
        <Input value={url} readOnly className={styles.link} />
        <div className={styles.actions}>
          <Button onClick={copy} variant="secondary">Copy link</Button>
          <Button onClick={share}>Share</Button>
        </div>
        {room?.inviteCode && (
          <p className={styles.code}>Invite code: <strong>{room.inviteCode}</strong></p>
        )}
      </div>
    </Modal>
  )
}

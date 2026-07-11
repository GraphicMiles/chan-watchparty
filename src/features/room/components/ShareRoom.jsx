import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Button, Input, Modal, useToast } from '../../../shared/ui/index.js'
import styles from './ShareRoom.module.css'

export default function ShareRoom({ room, roomId, open, onClose }) {
  const { toast } = useToast()
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast('Invite link copied', { variant: 'success' })
    } catch {
      toast('Could not copy link', { variant: 'error' })
    }
  }

  const copyCode = async () => {
    if (!room?.inviteCode) return
    try {
      await navigator.clipboard.writeText(room.inviteCode)
      toast('Invite code copied', { variant: 'success' })
    } catch {
      toast('Could not copy code', { variant: 'error' })
    }
  }

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: room?.title,
          text: `Join ${room?.title} on Chan`,
          url,
        })
      } catch {
        /* user cancelled */
      }
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
          <Button onClick={copy} variant="secondary">Copy invite link</Button>
          <Button onClick={share}>Share</Button>
        </div>
        {room?.inviteCode && (
          <p className={styles.code}>
            Invite code: <strong>{room.inviteCode}</strong>{' '}
            <button type="button" className={styles.copyCode} onClick={copyCode}>
              Copy code
            </button>
          </p>
        )}
      </div>
    </Modal>
  )
}

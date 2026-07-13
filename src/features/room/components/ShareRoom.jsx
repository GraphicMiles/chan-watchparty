import { useEffect, useState } from 'react'
import { Copy, Share2, Hash } from 'lucide-react'
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
      color: { dark: '#7c89f7', light: '#0C0E16' },
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
    <Modal open={open} title="Share Room" onClose={onClose}>
      <div className={styles.share}>
        {qr && <img src={qr} alt="QR code" className={styles.qr} />}
        <Input value={url} readOnly className={styles.link} />
        <div className={styles.actions}>
          <Button onClick={copy} variant="secondary">
            <Copy size={14} />
            Copy Link
          </Button>
          <Button onClick={share}>
            <Share2 size={14} />
            Share
          </Button>
        </div>
        {room?.inviteCode && (
          <div className={styles.code}>
            <Hash size={14} />
            <span>Invite code: <strong>{room.inviteCode}</strong></span>
            <button type="button" className={styles.copyCode} onClick={copyCode}>
              <Copy size={12} />
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}

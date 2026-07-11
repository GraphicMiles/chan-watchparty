import { Card, Avatar } from '../../../shared/ui/index.js'
import { SyncPulse } from '../../../shared/components/SyncPulse.jsx'
import styles from './ParticipantList.module.css'

export default function ParticipantList({
  participants,
  hostId,
  coHosts = [],
  currentUserId,
  isHost,
  onKick,
  onPromote,
  onMute,
}) {
  const getRole = (p) => {
    if (p.id === hostId) return 'host'
    if (coHosts.includes(p.id)) return 'co-host'
    return p.role || 'viewer'
  }

  return (
    <Card className={styles.list}>
      <h3 className={styles.title}>Participants</h3>
      <div className={styles.participants}>
        {participants.map((p) => {
          const role = getRole(p)
          const isSelf = p.id === currentUserId
          const canManage = isHost && !isSelf

          return (
            <div key={p.id} className={styles.participant}>
              <div className={styles.avatarWrap}>
                <Avatar name={p.displayName} size={36} status={p.id === hostId ? 'live' : undefined} />
                {p.id === hostId && (
                  <div className={styles.pulse}>
                    <SyncPulse active size={44} />
                  </div>
                )}
              </div>
              <div className={styles.info}>
                <span className={styles.name}>{p.displayName}</span>
                <span className={styles.role}>
                  {role}
                  {p.muted && <span className={styles.mutedTag}> · muted</span>}
                </span>
              </div>
              {canManage && (
                <div className={styles.actions}>
                  {role === 'viewer' ? (
                    <button className={styles.action} onClick={() => onPromote(p.id, 'co-host')}>
                      Promote
                    </button>
                  ) : (
                    <button className={styles.action} onClick={() => onPromote(p.id, 'viewer')}>
                      Demote
                    </button>
                  )}
                  <button className={styles.action} onClick={() => onMute(p.id, !p.muted)}>
                    {p.muted ? 'Unmute' : 'Mute'}
                  </button>
                  <button className={`${styles.action} ${styles.danger}`} onClick={() => onKick(p.id)}>
                    Kick
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

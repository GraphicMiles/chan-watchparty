import { Crown, Shield, User, MicOff } from 'lucide-react'
import { Card, Avatar, Badge } from '../../../shared/ui/index.js'
import { SyncPulse } from '../../../shared/components/SyncPulse.jsx'
import styles from './ParticipantList.module.css'

export default function ParticipantList({
  participants,
  hostId,
  coHosts = [],
  currentUserId,
  isHost,
  canControl,
  onKick,
  onPromote,
  onMute,
}) {
  const getRole = (p) => {
    if (p.id === hostId) return 'host'
    if (coHosts.includes(p.id)) return 'co-host'
    return p.role || 'viewer'
  }

  const roleIcon = (role) => {
    if (role === 'host') return Crown
    if (role === 'co-host') return Shield
    return User
  }

  return (
    <Card className={styles.list}>
      <h3 className={styles.title}>Participants</h3>
      <div className={styles.participants}>
        {participants.map((p) => {
          const role = getRole(p)
          const isSelf = p.id === currentUserId
          const canManage = isHost && !isSelf
          const canMute = canControl && !isSelf

          return (
            <div key={p.id} className={styles.participant}>
              <div className={styles.avatarWrap}>
                <Avatar
                  name={p.displayName}
                  uid={p.id}
                  size={36}
                  isHost={p.id === hostId}
                  status={p.id === hostId ? 'live' : 'online'}
                />
                {p.id === hostId && (
                  <div className={styles.pulse}>
                    <SyncPulse active size={44} />
                  </div>
                )}
              </div>
              <div className={styles.info}>
                <span className={styles.name}>
                  {p.displayName}
                  {isSelf && <span className={styles.selfTag}> (you)</span>}
                </span>
                <span className={styles.roleWrap}>
                  <Badge
                    variant={role === 'host' ? 'accent' : role === 'co-host' ? 'accent' : 'muted'}
                    icon={roleIcon(role)}
                  >
                    {role}
                  </Badge>
                  {p.muted && (
                    <span className={styles.mutedTag}>
                      <MicOff size={10} />
                      muted
                    </span>
                  )}
                </span>
              </div>
              {(canManage || canMute) && (
                <div className={styles.actions}>
                  {canManage && (
                    <>
                      {role === 'viewer' ? (
                        <button className={styles.action} onClick={() => onPromote(p.id, 'co-host')}>
                          Promote
                        </button>
                      ) : role !== 'host' ? (
                        <button className={styles.action} onClick={() => onPromote(p.id, 'viewer')}>
                          Demote
                        </button>
                      ) : null}
                    </>
                  )}
                  {canMute && (
                    <button className={styles.action} onClick={() => onMute(p.id, !p.muted)}>
                      {p.muted ? 'Unmute' : 'Mute'}
                    </button>
                  )}
                  {canManage && (
                    <button className={`${styles.action} ${styles.danger}`} onClick={() => onKick(p.id)}>
                      Kick
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

import { Card, Avatar } from '../../../shared/ui/index.js'
import { SyncPulse } from '../../../shared/components/SyncPulse.jsx'
import styles from './ParticipantList.module.css'

export default function ParticipantList({ participants, hostId }) {
  return (
    <Card className={styles.list}>
      <h3 className={styles.title}>Participants</h3>
      <div className={styles.participants}>
        {participants.map((p) => (
          <div key={p.id} className={styles.participant}>
            <div className={styles.avatarWrap}>
              <Avatar name={p.displayName} size={36} />
              {p.id === hostId && (
                <div className={styles.pulse}>
                  <SyncPulse active size={44} />
                </div>
              )}
            </div>
            <div className={styles.info}>
              <span className={styles.name}>{p.displayName}</span>
              {p.id === hostId && <span className={styles.role}>Host</span>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

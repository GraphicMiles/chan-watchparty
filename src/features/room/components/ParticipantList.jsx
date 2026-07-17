import { useState } from 'react'
import { MoreVertical, Shield, UserX, Mic, MicOff, Award, Clock } from 'lucide-react'
import { Avatar, Badge, Modal, Button } from '../../../shared/ui/index.js'
import styles from './ParticipantList.module.css'

export function calculateUserBadges(participant, isHost, isCoHost) {
  const badges = []
  if (isHost || participant?.role === 'host') {
    badges.push({ id: 'host', label: 'Room Host VIP', color: '#FF6A2B' })
    badges.push({ id: 'cinephile', label: 'Master Cinephile', color: '#8A2BE2' })
  } else if (isCoHost || participant?.role === 'co-host') {
    badges.push({ id: 'cohost', label: 'Co Host Guard', color: '#1F7A5C' })
  }
  badges.push({ id: 'streak', label: 'Watch Diehard', color: '#EA3323' })
  badges.push({ id: 'chatter', label: 'Active Member', color: '#00BFFF' })
  return badges
}

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
  const [menuOpenFor, setMenuOpenFor] = useState(null)
  const [selectedPassportUser, setSelectedPassportUser] = useState(null)

  const handleAction = (uid, action) => {
    setMenuOpenFor(null)
    if (action === 'kick') onKick(uid)
    else if (action === 'promote-cohost') onPromote(uid, 'co-host')
    else if (action === 'demote-viewer') onPromote(uid, 'viewer')
    else if (action === 'mute') onMute(uid, true)
    else if (action === 'unmute') onMute(uid, false)
  }

  const hostParticipant = participants.find((p) => p.id === hostId)
  const coHostParticipants = participants.filter((p) => p.id !== hostId && coHosts.includes(p.id))
  const viewerParticipants = participants.filter((p) => p.id !== hostId && !coHosts.includes(p.id))

  const sortedParticipants = [
    ...(hostParticipant ? [hostParticipant] : []),
    ...coHostParticipants,
    ...viewerParticipants,
  ]

  return (
    <div className={styles.listContainer}>
      <div className={styles.header}>
        <h3>Room Participants ({participants.length})</h3>
        <p className={styles.subText}>Click any participant to view their Chan Passport & Badges!</p>
      </div>

      <div className={styles.list}>
        {sortedParticipants.map((p) => {
          const pIsHost = p.id === hostId
          const pIsCoHost = coHosts.includes(p.id)
          const pIsMe = p.id === currentUserId
          const canModerateThisUser = isHost && !pIsHost && !pIsMe
          const badges = calculateUserBadges(p, pIsHost, pIsCoHost)

          return (
            <div key={p.id} className={styles.row}>
              <div className={styles.left} onClick={() => setSelectedPassportUser(p)} style={{ cursor: 'pointer' }}>
                <Avatar name={p.displayName || 'Anonymous'} size={34} />
                <div className={styles.info}>
                  <div className={styles.nameRow}>
                    <span className={styles.name}>
                      {p.displayName || 'Anonymous'}
                      {pIsMe && <span className={styles.meTag}> (you)</span>}
                    </span>
                    {p.muted && <MicOff size={13} className={styles.mutedIcon} title="Muted" />}
                  </div>
                  <div className={styles.badgesRow}>
                    {pIsHost && <Badge variant="accent" size="sm">Host</Badge>}
                    {pIsCoHost && !pIsHost && <Badge variant="success" size="sm">Co Host</Badge>}
                    <span className={styles.miniBadge}>{badges[0]?.label}</span>
                  </div>
                </div>
              </div>

              <div className={styles.actions}>
                {canModerateThisUser && (
                  <div className={styles.menuWrapper}>
                    <button
                      type="button"
                      className={styles.menuBtn}
                      onClick={() => setMenuOpenFor(menuOpenFor === p.id ? null : p.id)}
                      title="Participant actions"
                    >
                      <MoreVertical size={16} />
                    </button>

                    {menuOpenFor === p.id && (
                      <div className={styles.menu}>
                        {pIsCoHost ? (
                          <button type="button" onClick={() => handleAction(p.id, 'demote-viewer')}>
                            <Shield size={14} /> Demote to Viewer
                          </button>
                        ) : (
                          <button type="button" onClick={() => handleAction(p.id, 'promote-cohost')}>
                            <Shield size={14} /> Promote to Co Host
                          </button>
                        )}

                        {p.muted ? (
                          <button type="button" onClick={() => handleAction(p.id, 'unmute')}>
                            <Mic size={14} /> Unmute Chat
                          </button>
                        ) : (
                          <button type="button" onClick={() => handleAction(p.id, 'mute')}>
                            <MicOff size={14} /> Mute Chat
                          </button>
                        )}

                        <button type="button" className={styles.dangerItem} onClick={() => handleAction(p.id, 'kick')}>
                          <UserX size={14} /> Remove from Room
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Chan Passport Modal (#13) */}
      <Modal
        open={Boolean(selectedPassportUser)}
        title="Chan Passport & Badges"
        icon={Award}
        onClose={() => setSelectedPassportUser(null)}
      >
        {selectedPassportUser && (
          <div className={styles.passportBody}>
            <div className={styles.passportHeaderRow}>
              <Avatar name={selectedPassportUser.displayName || 'Anonymous'} size={64} />
              <div>
                <h3 className={styles.passportName}>{selectedPassportUser.displayName || 'Anonymous'}</h3>
                <span className={styles.passportRole}>
                  {selectedPassportUser.id === hostId ? 'Room Host VIP' : coHosts.includes(selectedPassportUser.id) ? 'Co Host Guard' : 'Watch Party Member'}
                </span>
              </div>
            </div>

            <div className={styles.passportStatsGrid}>
              <div className={styles.statBox}>
                <Clock size={16} className={styles.statIcon} />
                <span className={styles.statVal}>Active</span>
                <span className={styles.statLbl}>Status</span>
              </div>
              <div className={styles.statBox}>
                <Award size={16} className={styles.statIcon} />
                <span className={styles.statVal}>Level 4</span>
                <span className={styles.statLbl}>Watch Tier</span>
              </div>
            </div>

            <div className={styles.passportBadgesSection}>
              <h4>Earned Social Badges</h4>
              <div className={styles.passportBadgesList}>
                {calculateUserBadges(
                  selectedPassportUser,
                  selectedPassportUser.id === hostId,
                  coHosts.includes(selectedPassportUser.id)
                ).map((b, idx) => (
                  <span key={idx} className={styles.passportBadgeItem} style={{ borderColor: b.color }}>
                    {b.label}
                  </span>
                ))}
              </div>
            </div>

            <div className={styles.passportActions}>
              <Button variant="secondary" onClick={() => setSelectedPassportUser(null)}>
                Close Passport
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

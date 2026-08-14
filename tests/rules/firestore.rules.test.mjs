/**
 * Firestore security-rules tests (Firestore emulator).
 *
 * Run: npm run test:rules
 *
 * Covers the privilege/privacy boundaries that are not enforceable anywhere
 * else: chat/queue/reactions and room-document writes all go client → Firestore
 * directly, so these rules are the only thing standing between a signed-in
 * user and another room's data.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore'
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ID = 'chan-rules-test'

const HOST = 'host_uid'
const COHOST = 'cohost_uid'
const VIEWER = 'viewer_uid'
const OUTSIDER = 'outsider_uid'
const BANNED = 'banned_uid'
const ROOM = 'room1'

let testEnv

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(join(__dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8710,
    },
  })
})

afterAll(async () => { await testEnv?.cleanup() })

/** Seed a room with a host, a co-host, a viewer and one chat message. */
beforeEach(async () => {
  await testEnv.clearFirestore()
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    await setDoc(doc(db, 'rooms', ROOM), {
      hostId: HOST,
      hostName: 'Host',
      title: 'Movie night',
      coHosts: [COHOST],
      bannedUids: [BANNED],
      isPrivate: true,
      inviteCode: 'SECRET1',
      locked: false,
      capacity: 12,
      participantCount: 3,
      status: 'live',
      videoType: 'youtube',
    })
    for (const uid of [HOST, COHOST, VIEWER]) {
      await setDoc(doc(db, 'rooms', ROOM, 'participants', uid), {
        displayName: uid,
        role: uid === HOST ? 'host' : uid === COHOST ? 'co-host' : 'viewer',
        muted: false,
      })
    }
    await setDoc(doc(db, 'rooms', ROOM, 'participants', 'muted_uid'), {
      displayName: 'Muted', role: 'viewer', muted: true,
    })
    await setDoc(doc(db, 'rooms', ROOM, 'messages', 'm1'), {
      uid: VIEWER, displayName: 'Viewer', text: 'hello',
    })
    await setDoc(doc(db, 'rooms', ROOM, 'quiz', 'current'), { question: 'q', votes: {} })
  })
})

const as = (uid) => testEnv.authenticatedContext(uid).firestore()
const anon = () => testEnv.unauthenticatedContext().firestore()

const msg = (uid, text = 'hi') => ({
  uid, displayName: 'Name', text, createdAt: serverTimestamp(),
})

describe('room document', () => {
  it('host can update room content fields', async () => {
    await assertSucceeds(updateDoc(doc(as(HOST), 'rooms', ROOM), { title: 'New title' }))
  })

  it('co-host can update room content fields', async () => {
    await assertSucceeds(updateDoc(doc(as(COHOST), 'rooms', ROOM), { title: 'Co-host retitle' }))
  })

  it('co-host CANNOT seize the room by rewriting hostId', async () => {
    await assertFails(updateDoc(doc(as(COHOST), 'rooms', ROOM), { hostId: COHOST }))
  })

  it('co-host CANNOT edit the co-host list', async () => {
    await assertFails(updateDoc(doc(as(COHOST), 'rooms', ROOM), { coHosts: [COHOST, OUTSIDER] }))
  })

  it('host CAN edit the co-host list', async () => {
    await assertSucceeds(updateDoc(doc(as(HOST), 'rooms', ROOM), { coHosts: [COHOST, VIEWER] }))
  })

  it('co-host CANNOT edit the ban list', async () => {
    await assertFails(updateDoc(doc(as(COHOST), 'rooms', ROOM), { bannedUids: [] }))
  })

  it('nobody can raise capacity beyond the cap', async () => {
    await assertFails(updateDoc(doc(as(HOST), 'rooms', ROOM), { capacity: 100000 }))
  })

  it('host can set a sane capacity', async () => {
    await assertSucceeds(updateDoc(doc(as(HOST), 'rooms', ROOM), { capacity: 8 }))
  })

  it('viewer cannot update the room', async () => {
    await assertFails(updateDoc(doc(as(VIEWER), 'rooms', ROOM), { title: 'nope' }))
  })

  it('participantCount is server-managed and not client-writable', async () => {
    await assertFails(updateDoc(doc(as(HOST), 'rooms', ROOM), { participantCount: 999 }))
  })

  it('creating a room as someone else is rejected', async () => {
    await assertFails(setDoc(doc(as(VIEWER), 'rooms', 'room2'), {
      hostId: OUTSIDER, title: 'x', status: 'live', capacity: 4, participantCount: 0,
    }))
  })
})

describe('room privacy', () => {
  it('a participant can read the room', async () => {
    await assertSucceeds(getDoc(doc(as(VIEWER), 'rooms', ROOM)))
  })

  it('a non-participant CANNOT read a private room (invite code leak)', async () => {
    await assertFails(getDoc(doc(as(OUTSIDER), 'rooms', ROOM)))
  })

  it('anonymous users cannot read rooms', async () => {
    await assertFails(getDoc(doc(anon(), 'rooms', ROOM)))
  })
})

describe('chat', () => {
  it('participant can post', async () => {
    const db = as(VIEWER)
    const batch = writeBatch(db)
    batch.set(doc(collection(db, 'rooms', ROOM, 'messages')), msg(VIEWER))
    batch.set(doc(db, 'rooms', ROOM, 'chatMeta', VIEWER), { lastMessageAt: serverTimestamp() })
    await assertSucceeds(batch.commit())
  })

  it('non-participant cannot post', async () => {
    await assertFails(addDoc(collection(as(OUTSIDER), 'rooms', ROOM, 'messages'), msg(OUTSIDER)))
  })

  it('muted participant cannot post', async () => {
    await assertFails(addDoc(collection(as('muted_uid'), 'rooms', ROOM, 'messages'), msg('muted_uid')))
  })

  it('cannot post as another user', async () => {
    await assertFails(addDoc(collection(as(VIEWER), 'rooms', ROOM, 'messages'), msg(HOST)))
  })

  it('oversized messages are rejected', async () => {
    await assertFails(addDoc(collection(as(VIEWER), 'rooms', ROOM, 'messages'), msg(VIEWER, 'x'.repeat(501))))
  })

  it('non-participant CANNOT read chat history', async () => {
    await assertFails(getDocs(collection(as(OUTSIDER), 'rooms', ROOM, 'messages')))
  })

  it('participant can read chat history', async () => {
    await assertSucceeds(getDocs(collection(as(VIEWER), 'rooms', ROOM, 'messages')))
  })

  it('author can delete own message', async () => {
    await assertSucceeds(deleteDoc(doc(as(VIEWER), 'rooms', ROOM, 'messages', 'm1')))
  })

  it('host can delete any message (moderation)', async () => {
    await assertSucceeds(deleteDoc(doc(as(HOST), 'rooms', ROOM, 'messages', 'm1')))
  })

  it('other viewers cannot delete a message', async () => {
    await assertFails(deleteDoc(doc(as(OUTSIDER), 'rooms', ROOM, 'messages', 'm1')))
  })

  it('messages are immutable (no post-hoc editing)', async () => {
    await assertFails(updateDoc(doc(as(VIEWER), 'rooms', ROOM, 'messages', 'm1'), { text: 'edited' }))
  })
})

describe('chat flood control', () => {
  // A compliant send: message + cooldown stamp in one atomic batch.
  const send = (db, uid, text = 'hi') => {
    const batch = writeBatch(db)
    batch.set(doc(collection(db, 'rooms', ROOM, 'messages')), {
      uid, displayName: 'Name', text, createdAt: serverTimestamp(),
    })
    batch.set(doc(db, 'rooms', ROOM, 'chatMeta', uid), { lastMessageAt: serverTimestamp() })
    return batch.commit()
  }

  it('allows a compliant send (message + stamp in one batch)', async () => {
    await assertSucceeds(send(as(VIEWER), VIEWER))
  })

  it('BLOCKS a message that skips the cooldown stamp', async () => {
    // This is the bypass that matters: if the stamp were optional, a client
    // could simply never write it and flood freely.
    await assertFails(addDoc(collection(as(VIEWER), 'rooms', ROOM, 'messages'), msg(VIEWER)))
  })

  it('BLOCKS a second message inside the cooldown window', async () => {
    await assertSucceeds(send(as(VIEWER), VIEWER, 'first'))
    await assertFails(send(as(VIEWER), VIEWER, 'flood'))
  })

  it('allows the next message once the cooldown has elapsed', async () => {
    await assertSucceeds(send(as(VIEWER), VIEWER, 'first'))
    await new Promise((r) => setTimeout(r, 1400))
    await assertSucceeds(send(as(VIEWER), VIEWER, 'second'))
  })

  it('cooldown is per-user, not global', async () => {
    await assertSucceeds(send(as(VIEWER), VIEWER, 'viewer msg'))
    // A different user must not be throttled by someone else's stamp.
    await assertSucceeds(send(as(HOST), HOST, 'host msg'))
  })

  it('cannot backdate the stamp to defeat the cooldown', async () => {
    // Single db handle: doc refs must come from the same Firestore instance.
    const db = as(VIEWER)
    const batch = writeBatch(db)
    batch.set(doc(collection(db, 'rooms', ROOM, 'messages')), {
      uid: VIEWER, displayName: 'Name', text: 'sneaky', createdAt: serverTimestamp(),
    })
    batch.set(doc(db, 'rooms', ROOM, 'chatMeta', VIEWER), {
      lastMessageAt: new Date(2000, 0, 1),
    })
    await assertFails(batch.commit())
  })

  it('cannot write another user’s cooldown stamp', async () => {
    await assertFails(setDoc(doc(as(VIEWER), 'rooms', ROOM, 'chatMeta', HOST), {
      lastMessageAt: serverTimestamp(),
    }))
  })

  it('cannot smuggle extra fields into the stamp document', async () => {
    await assertFails(setDoc(doc(as(VIEWER), 'rooms', ROOM, 'chatMeta', VIEWER), {
      lastMessageAt: serverTimestamp(), role: 'host',
    }))
  })
})

describe('banned users', () => {
  it('banned user cannot post chat', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'rooms', ROOM, 'participants', BANNED), {
        displayName: 'Banned', role: 'viewer', muted: false,
      })
    })
    await assertFails(addDoc(collection(as(BANNED), 'rooms', ROOM, 'messages'), msg(BANNED)))
  })

  it('banned user cannot add to the queue', async () => {
    await assertFails(addDoc(collection(as(BANNED), 'rooms', ROOM, 'queue'), {
      addedByUid: BANNED, title: 'Sneaky',
    }))
  })
})

describe('muted users cannot spam other surfaces', () => {
  it('muted user cannot send floating reactions', async () => {
    await assertFails(addDoc(collection(as('muted_uid'), 'rooms', ROOM, 'floatingReactions'), {
      uid: 'muted_uid', emoji: '🔥',
    }))
  })

  it('muted user cannot trigger sound effects', async () => {
    await assertFails(addDoc(collection(as('muted_uid'), 'rooms', ROOM, 'soundEffects'), {
      uid: 'muted_uid', soundKey: 'airhorn',
    }))
  })

  it('unmuted participant CAN send reactions', async () => {
    await assertSucceeds(addDoc(collection(as(VIEWER), 'rooms', ROOM, 'floatingReactions'), {
      uid: VIEWER, emoji: '🔥',
    }))
  })
})

describe('queue and participation scoping', () => {
  it('participant can add to the queue', async () => {
    await assertSucceeds(addDoc(collection(as(VIEWER), 'rooms', ROOM, 'queue'), {
      addedByUid: VIEWER, title: 'A film',
    }))
  })

  it('non-participant cannot add to the queue', async () => {
    await assertFails(addDoc(collection(as(OUTSIDER), 'rooms', ROOM, 'queue'), {
      addedByUid: OUTSIDER, title: 'Spam',
    }))
  })

  it('non-participant cannot send floating reactions', async () => {
    await assertFails(addDoc(collection(as(OUTSIDER), 'rooms', ROOM, 'floatingReactions'), {
      uid: OUTSIDER, emoji: '🔥',
    }))
  })
})

describe('quiz', () => {
  it('non-participant cannot overwrite the quiz', async () => {
    await assertFails(setDoc(doc(as(OUTSIDER), 'rooms', ROOM, 'quiz', 'current'), { question: 'pwned' }))
  })

  it('participant can vote', async () => {
    await assertSucceeds(updateDoc(doc(as(VIEWER), 'rooms', ROOM, 'quiz', 'current'), {
      [`votes.${VIEWER}`]: 1,
    }))
  })
})

describe('player state', () => {
  it('host can drive playback', async () => {
    await assertSucceeds(setDoc(doc(as(HOST), 'rooms', ROOM, 'playerState', 'current'), {
      isPlaying: true, currentTime: 10,
    }))
  })

  it('viewer cannot drive playback', async () => {
    await assertFails(setDoc(doc(as(VIEWER), 'rooms', ROOM, 'playerState', 'current'), {
      isPlaying: false, currentTime: 0,
    }))
  })

  it('non-participant cannot read player state', async () => {
    await assertFails(getDoc(doc(as(OUTSIDER), 'rooms', ROOM, 'playerState', 'current')))
  })
})

describe('participants subcollection', () => {
  it('is not client-writable (server-managed seats)', async () => {
    await assertFails(setDoc(doc(as(VIEWER), 'rooms', ROOM, 'participants', VIEWER), {
      displayName: 'Self promoted', role: 'host', muted: false,
    }))
  })

  it('a participant cannot unmute themselves', async () => {
    await assertFails(updateDoc(doc(as('muted_uid'), 'rooms', ROOM, 'participants', 'muted_uid'), {
      muted: false,
    }))
  })

  it('non-participant cannot enumerate the participant list', async () => {
    await assertFails(getDocs(collection(as(OUTSIDER), 'rooms', ROOM, 'participants')))
  })
})

describe('user profiles', () => {
  it('a user can write their own profile', async () => {
    await assertSucceeds(setDoc(doc(as(VIEWER), 'users', VIEWER), { displayName: 'Me' }))
  })

  it('a user cannot write someone else’s profile', async () => {
    await assertFails(setDoc(doc(as(VIEWER), 'users', HOST), { displayName: 'Hacked' }))
  })
})

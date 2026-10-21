/**
 * Authenticated push-device registry.
 *
 * Tokens live in users/{uid}/pushDevices/{installId}, which is written only
 * through this Admin endpoint. They are deliberately not fields on the
 * broadly readable users/{uid} profile document.
 */
import { FieldValue, getDb, verifyIdToken } from '../server-lib/firebaseAdmin.js'
import { fail, ok, preflight, statusForError } from '../server-lib/http.js'
import { checkRateLimit, clientKey } from '../server-lib/rateLimit.js'
import { sanitizeAction, sanitizeUid } from '../server-lib/sanitize.js'

const ALLOWED_PUSH_ACTIONS = ['register', 'unregister']
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
const TOKEN_RE = /^[\x21-\x7E]{20,4096}$/

async function requireUser(req, expectedUid) {
  const token = req.headers.authorization?.split('Bearer ')[1]
  if (!token) throw Object.assign(new Error('Missing token'), { status: 401 })
  let decoded
  try {
    decoded = await verifyIdToken(token)
  } catch {
    throw Object.assign(new Error('Invalid or expired token'), { status: 401 })
  }
  if (expectedUid && decoded.uid !== expectedUid) {
    throw Object.assign(new Error('Token uid does not match request uid'), { status: 403 })
  }
  return decoded
}

async function deleteOtherTokenDocs(db, uid, installId, token) {
  if (!token) return
  const snap = await db
    .collectionGroup('pushDevices')
    .where('token', '==', token)
    .limit(25)
    .get()
    .catch(() => null)

  const refs = []
  snap?.docs?.forEach((docSnap) => {
    const ownerUid = docSnap.ref.parent?.parent?.id
    if (ownerUid !== uid || docSnap.id !== installId) refs.push(docSnap.ref)
  })

  if (!refs.length) return
  const batch = db.batch()
  refs.forEach((ref) => batch.delete(ref))
  await batch.commit()
}

export default async function handler(req, res) {
  try {
    if (preflight(req, res, { methods: ['POST'] })) return
    const rl = await checkRateLimit(`push:${clientKey(req)}`, { limit: 30, windowMs: 60_000 })
    if (!rl.allowed) return fail(res, 429, 'Too many requests — slow down')

    const body = req.body || {}
    const action = sanitizeAction(String(body.action || '').toLowerCase(), ALLOWED_PUSH_ACTIONS)
    if (!action) return fail(res, 400, 'Invalid action')

    const uid = sanitizeUid(body.uid)
    const installId = String(body.installId || '').trim()
    if (!uid || !INSTALL_ID_RE.test(installId)) return fail(res, 400, 'Invalid device registration')

    const decoded = await requireUser(req, uid)
    const db = getDb()
    const deviceRef = db.collection('users').doc(decoded.uid).collection('pushDevices').doc(installId)

    if (action === 'unregister') {
      await deviceRef.delete()
      return ok(res, { unregistered: true })
    }

    const token = String(body.token || '').trim()
    if (!TOKEN_RE.test(token)) return fail(res, 400, 'Invalid push token')
    const platform = ['android', 'ios', 'web'].includes(body.platform) ? body.platform : 'android'

    await deleteOtherTokenDocs(db, decoded.uid, installId, token).catch(() => {})
    await deviceRef.set({
      installId,
      token,
      platform,
      enabled: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })

    return ok(res, { registered: true })
  } catch (err) {
    console.error('push API error', err)
    const safeMessage = statusForError(err) >= 500 ? 'Internal server error' : (err.message || 'Request failed')
    return fail(res, statusForError(err), safeMessage)
  }
}

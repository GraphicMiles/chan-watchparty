import { Firestore, FieldValue, Timestamp } from '@google-cloud/firestore'
import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

function getCredentials() {
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL
  let privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Firebase Admin credentials are missing. Check FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, and FIREBASE_ADMIN_PRIVATE_KEY.')
  }

  if (privateKey.trim().startsWith('{')) {
    try {
      const json = JSON.parse(privateKey)
      privateKey = json.private_key
      if (!privateKey) throw new Error('private_key not found in service account JSON')
    } catch (err) {
      throw new Error(`FIREBASE_ADMIN_PRIVATE_KEY looks like JSON but could not be parsed: ${err.message}`)
    }
  }

  privateKey = privateKey.replace(/\\n/g, '\n')

  return { projectId, clientEmail, privateKey }
}

let dbInstance = null
let authInstance = null

export function getDb() {
  if (!dbInstance) {
    const { projectId, clientEmail, privateKey } = getCredentials()
    dbInstance = new Firestore({
      projectId,
      credentials: { client_email: clientEmail, private_key: privateKey },
    })
  }
  return dbInstance
}

export function getAuthClient() {
  if (!authInstance) {
    const apps = getApps()
    if (apps.length === 0) {
      const { projectId, clientEmail, privateKey } = getCredentials()
      initializeApp({
        projectId,
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      })
    }
    authInstance = getAuth()
  }
  return authInstance
}

export async function verifyIdToken(token) {
  const auth = getAuthClient()
  return auth.verifyIdToken(token)
}

export { FieldValue, Timestamp }

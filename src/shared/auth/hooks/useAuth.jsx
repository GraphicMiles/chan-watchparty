import { createContext, useContext, useEffect, useState } from 'react'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  getRedirectResult,
  signOut,
  sendEmailVerification,
  updateProfile,
} from 'firebase/auth'
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db, googleProvider } from '../../lib/firebase.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getRedirectResult(auth).then(async (result) => {
      if (result?.user) {
        await ensureDisplayName(result.user, result.user.displayName)
      }
    }).catch((err) => {
      console.error('Redirect sign-in error:', err)
    })

    return onAuthStateChanged(auth, async (u) => {
      if (u) {
        try {
          const ref = doc(db, 'users', u.uid)
          const snap = await getDoc(ref)
          if (!snap.exists()) {
            await setDoc(ref, {
              displayName: u.displayName || u.email?.split('@')[0] || 'Viewer',
              email: u.email,
              emailVerified: u.emailVerified,
              tier: 'free',
              createdAt: serverTimestamp(),
            })
          }
        } catch (err) {
          console.error('Error syncing user doc:', err)
        }
        setUser(u)
      } else {
        setUser(null)
      }
      setLoading(false)
    })
  }, [])

  const ensureDisplayName = async (u, displayName) => {
    if (displayName && u.displayName !== displayName) {
      await updateProfile(u, { displayName })
    }
    await setDoc(
      doc(db, 'users', u.uid),
      { displayName: displayName || u.displayName || 'Viewer', emailVerified: u.emailVerified },
      { merge: true }
    )
  }

  const register = async (email, password, displayName) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password)
    await ensureDisplayName(cred.user, displayName)
    await sendEmailVerification(cred.user)
    return cred.user
  }

  const login = async (email, password) => {
    const cred = await signInWithEmailAndPassword(auth, email, password)
    return cred.user
  }

  const loginWithGoogle = async () => {
    const cred = await signInWithPopup(auth, googleProvider)
    await ensureDisplayName(cred.user, cred.user.displayName)
    return cred.user
  }

  const logout = () => signOut(auth)

  return (
    <AuthContext.Provider value={{ user, loading, login, register, loginWithGoogle, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

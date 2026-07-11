import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInAnonymously, updateProfile, signOut } from 'firebase/auth'
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../../lib/firebase.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      if (u) {
        try {
          const ref = doc(db, 'users', u.uid)
          const snap = await getDoc(ref)
          if (!snap.exists()) {
            await setDoc(ref, {
              displayName: u.displayName || 'Viewer',
              anonymous: true,
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

  const signInAnonymously = async (displayName) => {
    const name = displayName?.trim() || 'Viewer'
    const cred = await signInAnonymously(auth)
    await updateProfile(cred.user, { displayName: name })
    await setDoc(
      doc(db, 'users', cred.user.uid),
      { displayName: name, anonymous: true },
      { merge: true }
    )
    return cred.user
  }

  const updateDisplayName = async (displayName) => {
    if (!user) return
    const name = displayName?.trim() || 'Viewer'
    await updateProfile(user, { displayName: name })
    await setDoc(
      doc(db, 'users', user.uid),
      { displayName: name },
      { merge: true }
    )
  }

  const logout = () => signOut(auth)

  return (
    <AuthContext.Provider value={{ user, loading, signInAnonymously, updateDisplayName, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

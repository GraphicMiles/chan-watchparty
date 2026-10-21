import { apiPath, parseJsonResponse } from './api.js'

const CHANNEL_ID = 'room-activity'
const INSTALL_KEY = 'chan:install-id'
const ASKED_KEY = 'chan:push-permission-requested'
const ENABLED_KEY = 'chan:push-enabled'
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

let nativePromise = null
let listenersPromise = null
let currentUser = null
let currentHandlers = {}
let registrationWaiters = []
let pendingOpenActions = []

function storageGet(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage can be unavailable in hardened WebViews */
  }
}

function installId() {
  const existing = storageGet(INSTALL_KEY)
  if (existing && INSTALL_ID_RE.test(existing)) return existing
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  storageSet(INSTALL_KEY, random)
  return random
}

function deliverOpenAction(action) {
  if (currentHandlers.onOpen) {
    currentHandlers.onOpen(action)
  } else {
    // A cold-start tap can be replayed before Firebase auth/router handlers
    // exist. Buffer it until the app is ready to navigate.
    pendingOpenActions = [...pendingOpenActions.slice(-4), action]
  }
}

function flushOpenActions() {
  if (!currentHandlers.onOpen || !pendingOpenActions.length) return
  const pending = pendingOpenActions
  pendingOpenActions = []
  pending.forEach((action) => currentHandlers.onOpen(action))
}

function settleRegistration(error, token = '') {
  const waiters = registrationWaiters
  registrationWaiters = []
  waiters.forEach(({ resolve, reject, timeout }) => {
    window.clearTimeout(timeout)
    if (error) reject(error)
    else resolve(token)
  })
}

async function loadNative() {
  if (!nativePromise) {
    nativePromise = (async () => {
      const [{ Capacitor }, { PushNotifications }] = await Promise.all([
        import('@capacitor/core'),
        import('@capacitor/push-notifications'),
      ])
      if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('PushNotifications')) {
        return null
      }
      return { Capacitor, PushNotifications }
    })().catch(() => {
      nativePromise = null
      return null
    })
  }
  return nativePromise
}

async function pushApi(user, body) {
  if (!user) throw new Error('Sign in before changing notifications')
  const token = await user.getIdToken()
  const res = await fetch(apiPath('/api/push'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const data = await parseJsonResponse(res)
  if (!res.ok || data.success === false) {
    throw new Error(data.error || 'Push notification request failed')
  }
  return data
}

async function saveToken(tokenValue) {
  const token = String(tokenValue || '').trim()
  if (!currentUser || !token) return
  const native = await loadNative()
  await pushApi(currentUser, {
    action: 'register',
    uid: currentUser.uid,
    installId: installId(),
    token,
    platform: native?.Capacitor?.getPlatform?.() || 'android',
  })
  storageSet(ENABLED_KEY, '1')
}

async function ensureListeners() {
  if (!listenersPromise) {
    listenersPromise = (async () => {
      const native = await loadNative()
      if (!native) return false
      const { PushNotifications } = native

      await PushNotifications.addListener('registration', (token) => {
        void (async () => {
          try {
            await saveToken(token?.value)
            settleRegistration(null, token?.value || '')
          } catch (err) {
            settleRegistration(err)
            currentHandlers.onError?.(err)
          }
        })()
      })

      await PushNotifications.addListener('registrationError', (error) => {
        const err = new Error(error?.error || 'Push registration failed')
        settleRegistration(err)
        currentHandlers.onError?.(err)
      })

      await PushNotifications.addListener('pushNotificationReceived', (notification) => {
        currentHandlers.onForeground?.(notification)
      })

      await PushNotifications.addListener('pushNotificationActionPerformed', deliverOpenAction)

      try {
        await PushNotifications.createChannel({
          id: CHANNEL_ID,
          name: 'Room activity',
          description: 'Room joins and watch-party activity',
          importance: 4,
          visibility: 0,
          vibration: true,
        })
      } catch {
        /* Channel creation is Android-only and safe to retry on a later launch. */
      }
      return true
    })().catch((err) => {
      listenersPromise = null
      throw err
    })
  }
  return listenersPromise
}

async function registerAndWait(user) {
  const native = await loadNative()
  if (!native) throw new Error('Push notifications are only available in the Android app')
  currentUser = user
  await ensureListeners()
  const registration = new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      registrationWaiters = registrationWaiters.filter((w) => w.timeout !== timeout)
      reject(new Error('Push registration timed out. Check the connection and try again.'))
    }, 15_000)
    registrationWaiters.push({ resolve, reject, timeout })
  })
  registration.catch(() => {})
  try {
    await native.PushNotifications.register()
    await registration
  } catch (err) {
    settleRegistration(err)
    throw err
  }
}

export async function getPushState() {
  const native = await loadNative()
  if (!native) return { supported: false, receive: 'denied', enabled: false }
  try {
    const status = await native.PushNotifications.checkPermissions()
    return {
      supported: true,
      receive: status.receive || 'denied',
      enabled: status.receive === 'granted' && storageGet(ENABLED_KEY) !== '0',
    }
  } catch {
    return { supported: true, receive: 'denied', enabled: false }
  }
}

export async function initPushNotifications(user, handlers = {}) {
  currentUser = user || null
  currentHandlers = handlers || {}
  flushOpenActions()
  const native = await loadNative()
  if (!native || !user) return getPushState()

  await ensureListeners().catch(() => false)
  flushOpenActions()
  if (storageGet(ENABLED_KEY) === '0') return getPushState()

  let status = await native.PushNotifications.checkPermissions().catch(() => ({ receive: 'denied' }))
  if (status.receive === 'prompt' || status.receive === 'prompt-with-rationale') {
    if (storageGet(ASKED_KEY) !== '1') {
      storageSet(ASKED_KEY, '1')
      status = await native.PushNotifications.requestPermissions().catch(() => status)
    }
  }

  if (status.receive === 'granted') {
    storageSet(ENABLED_KEY, '1')
    native.PushNotifications.register().catch((err) => currentHandlers.onError?.(err))
  }
  return {
    supported: true,
    receive: status.receive || 'denied',
    enabled: status.receive === 'granted' && storageGet(ENABLED_KEY) !== '0',
  }
}

export async function enablePushNotifications(user, handlers = {}) {
  currentUser = user || null
  if (handlers && Object.keys(handlers).length) currentHandlers = handlers
  flushOpenActions()
  const native = await loadNative()
  if (!native) throw new Error('Push notifications are only available in the Android app')
  if (!user) throw new Error('Sign in before enabling notifications')

  await ensureListeners()
  flushOpenActions()
  storageSet(ASKED_KEY, '1')
  const status = await native.PushNotifications.requestPermissions()
  if (status.receive !== 'granted') {
    storageSet(ENABLED_KEY, '0')
    return { supported: true, receive: status.receive || 'denied', enabled: false }
  }

  storageSet(ENABLED_KEY, '1')
  await registerAndWait(user)
  return { supported: true, receive: 'granted', enabled: true }
}

export async function disablePushNotifications(user) {
  const native = await loadNative()
  storageSet(ENABLED_KEY, '0')
  if (!native) return { supported: false, receive: 'denied', enabled: false }

  let firstError = null
  if (user) {
    try {
      await pushApi(user, {
        action: 'unregister',
        uid: user.uid,
        installId: installId(),
      })
    } catch (err) {
      firstError = err
    }
  }

  try {
    await native.PushNotifications.unregister()
  } catch (err) {
    firstError = firstError || err
  }

  if (user?.uid === currentUser?.uid) currentUser = user
  if (firstError) throw firstError
  const status = await native.PushNotifications.checkPermissions().catch(() => ({ receive: 'denied' }))
  return { supported: true, receive: status.receive || 'denied', enabled: false }
}

/** Map Firebase Auth error codes to actionable user copy. */
export function friendlyAuthError(err) {
  const code = err?.code || ''
  const message = err?.message || ''

  if (code === 'auth/admin-restricted-operation' || message.includes('admin-restricted-operation')) {
    return [
      'Anonymous sign-in is disabled in Firebase.',
      '',
      'Fix (one-time, project owner):',
      '1. Open Firebase Console → Authentication → Sign-in method',
      '2. Enable "Anonymous"',
      '3. Save, wait ~30s, try again',
      '',
      'Project: chan-69ce6',
    ].join('\n')
  }

  if (code === 'auth/network-request-failed') {
    return 'Network error. Check your connection and try again.'
  }

  if (code === 'auth/too-many-requests') {
    return 'Too many attempts. Wait a minute and try again.'
  }

  if (code === 'auth/operation-not-allowed') {
    return 'This sign-in method is not enabled in Firebase Console → Authentication → Sign-in method.'
  }

  if (message) return message.replace(/^Firebase:\s*/i, '').replace(/\s*\(.*\)\.?$/, '').trim() || message
  return 'Could not sign in. Try again.'
}

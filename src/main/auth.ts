import type { Session } from '../shared/types'

/**
 * Mocked auth service behind a swappable interface. Real Google OAuth and
 * magic-link delivery land later (see reference3 / TODO "Real auth backend");
 * these stubs exercise the same in-app flow without opening a browser —
 * opening a fake Google OAuth URL looks like phishing to Gatekeeper / users.
 */

const MOCK_ACCOUNT = { email: 'harry@yuh.app', displayName: 'Harry' }

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function titleCase(local: string): string {
  return local.charAt(0).toUpperCase() + local.slice(1)
}

/** Derive a display name from an email local-part. */
export function sessionForEmail(email: string): Session {
  const local = (email.split('@')[0] || 'there').replace(/[._-]+/g, ' ').trim()
  return { email, displayName: titleCase(local || 'there') }
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

/** Continue with Google → in-app mock delay → signed-in session (no browser). */
export async function googleAuth(): Promise<Session> {
  await delay(600)
  return { ...MOCK_ACCOUNT }
}

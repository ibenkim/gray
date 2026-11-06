import { useEffect, useState } from 'react'
import type { Session } from '../state/types'
import { useWorkspaceDrag } from '../hooks/useWorkspaceDrag'
import googleIcon from '../assets/apps/google.svg'

type Mode = 'buttons' | 'email' | 'sent'

const TERMS_URL = 'https://yuh.app/terms'
const RESEND_SECONDS = 60
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * 1.1 welcome (Figma: welcome · welcome-email · welcome-check-inbox · welcome-error).
 * Google or an emailed sign-in link — no passwords. Errors stay inline and always leave
 * another path; there is no dismiss.
 */
export default function WelcomeStep({ session }: { session: Session }) {
  const [mode, setMode] = useState<Mode>('buttons')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [emailInvalid, setEmailInvalid] = useState(false)
  const [resendIn, setResendIn] = useState(0)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  useEffect(() => {
    if (mode !== 'sent' || resendIn <= 0) return
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [mode, resendIn])

  async function continueWithGoogle() {
    setAuthError(null)
    setBusy(true)
    try {
      const result = await window.grayBridge?.authGoogle?.()
      if (!result) setAuthError('Couldn’t sign in — the browser window was closed')
    } catch {
      setAuthError('Couldn’t sign in — try again')
    } finally {
      setBusy(false)
    }
  }

  async function sendMagicLink() {
    const address = email.trim()
    if (!EMAIL_RE.test(address)) {
      setEmailInvalid(true)
      return
    }
    setEmailInvalid(false)
    setBusy(true)
    try {
      const res = await window.grayBridge?.authSendMagicLink?.(address)
      if (res?.ok) {
        setMode('sent')
        setResendIn(RESEND_SECONDS)
      } else setEmailInvalid(true)
    } finally {
      setBusy(false)
    }
  }

  const clock = `${Math.floor(resendIn / 60)}:${String(resendIn % 60).padStart(2, '0')}`

  if (mode === 'sent') {
    return (
      <div className="onb-card">
        <div className="onb-step" key="sent">
          <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
            <div className="onb-eyebrow">Check your inbox</div>
            <div className="onb-title">Link sent</div>
          </div>
          <p className="onb-sub">
            We sent a sign-in link to {email.trim()}.
            <br />
            It signs you in on this Mac and expires in 15 minutes.
          </p>
          <div className="onb-gap-12" />
          <div className="onb-actions">
            <button className="onb-text-btn" disabled={resendIn > 0 || busy} onClick={sendMagicLink}>
              {resendIn > 0 ? `Resend (${clock})` : 'Resend link'}
            </button>
            <button
              className="onb-text-btn"
              onClick={() => {
                setEmail('')
                setMode('email')
              }}
            >
              Use a different email
            </button>
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'email') {
    return (
      <div className="onb-card">
        <div className="onb-step" key="email">
          <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
            <div className="onb-eyebrow">Welcome</div>
            <div className="onb-title">Sign in with email</div>
          </div>
          <p className="onb-sub">We’ll email you a sign-in link — no password to remember.</p>
          <div className="onb-gap-8" />
          <input
            className={`onb-input ${emailInvalid ? 'onb-input-error' : ''}`}
            type="email"
            autoFocus
            placeholder="you@work.com"
            value={email}
            aria-invalid={emailInvalid}
            onChange={(e) => {
              setEmail(e.target.value)
              setEmailInvalid(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendMagicLink()
            }}
          />
          {emailInvalid && <div className="onb-error">That doesn’t look like an email</div>}
          <div className="onb-gap-8" />
          <div className="onb-footer">
            <button className="onb-text-btn" onClick={() => setMode('buttons')}>
              Back
            </button>
            <span className="onb-footer-spacer" />
            <button className="btn btn-primary btn-md" disabled={busy} onClick={sendMagicLink}>
              Send link
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="onb-card">
      <div className="onb-step" key={authError ? 'error' : 'buttons'}>
        <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
          <div className="onb-eyebrow">Welcome</div>
          <div className="onb-title">Meet Gray</div>
        </div>
        <p className="onb-sub">
          Show it a task once. It learns the steps,
          <br />
          then does it for you — on schedule.
        </p>
        <div className="onb-gap" />
        <button
          className={`onb-google-btn ${authError ? 'onb-google-error' : ''}`}
          disabled={busy}
          onClick={continueWithGoogle}
        >
          {busy ? <span className="onb-spinner" aria-hidden="true" /> : <img src={googleIcon} alt="" />}
          {busy
            ? 'Opening your browser…'
            : authError
              ? 'Try Google again'
              : session
                ? `Continue as ${session.email}`
                : 'Continue with Google'}
        </button>
        {authError && <div className="onb-error onb-error-center">{authError}</div>}
        <div className="onb-alt">
          <button
            className="onb-alt-link"
            onClick={() => {
              setAuthError(null)
              setMode('email')
            }}
          >
            {authError ? 'Continue with email instead' : 'Continue with email'}
          </button>
        </div>
        {!authError && (
          <>
            <div className="onb-gap-8" />
            <div className="onb-terms">
              <button className="onb-terms-link" onClick={() => window.grayBridge?.openExternalUrl?.(TERMS_URL)}>
                By continuing you agree to the Terms &amp; Privacy Policy
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

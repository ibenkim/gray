import { useState } from 'react'
import type { Session } from '../state/types'
import { useWorkspaceDrag } from '../hooks/useWorkspaceDrag'

type Mode = 'buttons' | 'email' | 'sent'

const TERMS_URL = 'https://yuh.app/terms'

/** 1.1 welcome — Continue with Google / email magic link; no dismiss. */
export default function WelcomeStep({ session }: { session: Session }) {
  const [mode, setMode] = useState<Mode>('buttons')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  async function continueWithGoogle() {
    setError(null)
    setBusy(true)
    try {
      const result = await window.ghostBridge?.authGoogle?.()
      if (!result) setError('Couldn’t sign in — try again')
    } catch {
      setError('Couldn’t sign in — try again')
    } finally {
      setBusy(false)
    }
  }

  async function sendMagicLink() {
    if (!email.trim()) return
    setError(null)
    const res = await window.ghostBridge?.authSendMagicLink?.(email.trim())
    if (res?.ok) setMode('sent')
    else setError('That doesn’t look like an email — check and try again')
  }

  return (
    <div className="onb-card">
      <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
        <div className="onb-eyebrow">WELCOME</div>
        <div className="onb-title">Meet yuh</div>
      </div>
      <p className="onb-sub">
        Show it a task once. It learns the steps,
        <br />
        then does it for you — on schedule.
      </p>

      <div className="onb-gap" />

      {mode === 'sent' ? (
        <div className="onb-inbox">
          <div className="onb-inbox-title">Check your inbox</div>
          <div className="onb-inbox-sub">
            We sent a sign-in link to {email}. Open it to continue.
          </div>
        </div>
      ) : mode === 'email' ? (
        <input
          className="onb-input"
          type="email"
          autoFocus
          placeholder="you@work.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendMagicLink()
          }}
        />
      ) : (
        <button className="onb-google-btn" disabled={busy} onClick={continueWithGoogle}>
          <GoogleGlyph />
          {busy ? 'Opening browser…' : session ? `Continue as ${session.email}` : 'Continue with Google'}
        </button>
      )}

      {error && <div className="onb-error">{error}</div>}

      {mode !== 'sent' && (
        <div className="onb-alt">
          <button
            className="onb-link"
            onClick={() => {
              setError(null)
              setMode((m) => (m === 'email' ? 'buttons' : 'email'))
            }}
          >
            {mode === 'email' ? 'Continue with Google' : 'Continue with email'}
          </button>
        </div>
      )}

      <div className="onb-terms type-meta">
        <button
          className="onb-terms-link"
          onClick={() => window.ghostBridge?.openExternalUrl?.(TERMS_URL)}
        >
          By continuing you agree to the Terms & Privacy Policy
        </button>
      </div>
    </div>
  )
}

function GoogleGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  )
}

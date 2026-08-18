import { useEffect, useState } from 'react'
import type { Session, Team } from '../state/types'
import { useWorkspaceDrag } from '../hooks/useWorkspaceDrag'

type Choice = 'create' | 'join'

/** 1.2 team — Create (auto-named) or Join (invite link/code); joining never skips permissions. */
export default function TeamStep({
  session,
  pendingInvite,
  onBack
}: {
  session: Session
  pendingInvite: string | null
  onBack: () => void
}) {
  const [choice, setChoice] = useState<Choice>(pendingInvite ? 'join' : 'create')
  const [code, setCode] = useState(pendingInvite ?? '')
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [invitePreview, setInvitePreview] = useState<Team>(null)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  // Arrived via an invite link → pre-fill Join with a confirm row.
  useEffect(() => {
    if (!pendingInvite) return
    setChoice('join')
    setCode(pendingInvite)
    window.ghostBridge?.teamPreview?.(pendingInvite).then((res) => {
      if (res?.ok && res.team) setInvitePreview(res.team)
    })
  }, [pendingInvite])

  async function onContinue() {
    setBusy(true)
    try {
      if (choice === 'create') {
        await window.ghostBridge?.teamCreate?.()
        return
      }
      const res = await window.ghostBridge?.teamJoin?.(code)
      if (!res?.ok) {
        setInvalid(true)
        return
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="onb-card">
      <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
        <div className="onb-eyebrow">TEAM</div>
        <div className="onb-title">Where will you work?</div>
      </div>

      <div className="onb-gap" />

      <button
        className={`onb-option ${choice === 'create' ? 'onb-option-on' : ''}`}
        onClick={() => setChoice('create')}
      >
        <span className="onb-option-body">
          <span className="onb-option-title">Create a team</span>
          <span className="onb-option-sub">Start fresh — invite people later</span>
        </span>
        <span className={`onb-radio ${choice === 'create' ? 'onb-radio-on' : ''}`} />
      </button>

      <button
        className={`onb-option ${choice === 'join' ? 'onb-option-on' : ''}`}
        onClick={() => setChoice('join')}
      >
        <span className="onb-option-body">
          <span className="onb-option-title">Join a team</span>
          <span className="onb-option-sub">Use an invite link from your team owner</span>
        </span>
        <span className={`onb-radio ${choice === 'join' ? 'onb-radio-on' : ''}`} />
      </button>

      {choice === 'join' &&
        (invitePreview ? (
          <div className="onb-confirm-row">
            Join {invitePreview.name} · {invitePreview.memberCount} members
          </div>
        ) : (
          <div className="onb-join-field">
            <input
              className={`onb-input ${invalid ? 'onb-input-error' : ''}`}
              placeholder="Paste invite link or code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value)
                setInvalid(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onContinue()
              }}
            />
            {invalid && (
              <div className="onb-error">
                That link didn’t work — ask your team owner to re-send
              </div>
            )}
          </div>
        ))}

      <div className="onb-gap-sm" />

      <div className="onb-footer">
        <button className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
        <span className="onb-footer-spacer">
          {session && <span className="onb-footer-account">{session.email}</span>}
        </span>
        <button className="btn btn-primary btn-md" disabled={busy} onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  )
}

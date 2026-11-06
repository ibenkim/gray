import { useEffect, useState } from 'react'
import type { Session, Team } from '../state/types'
import { useWorkspaceDrag } from '../hooks/useWorkspaceDrag'

type Choice = 'create' | 'join'

/**
 * 1.2 team (Figma: team · team-join-invite). Create (auto-named) or Join (invite link or
 * code); arriving through an invite shows the confirm card. Joining never skips permissions.
 */
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
  const [declinedInvite, setDeclinedInvite] = useState(false)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  // Arrived via an invite link → the confirm card replaces the choice.
  useEffect(() => {
    if (!pendingInvite) return
    setChoice('join')
    setCode(pendingInvite)
    window.grayBridge?.teamPreview?.(pendingInvite).then((res) => {
      if (res?.ok && res.team) setInvitePreview(res.team)
    })
  }, [pendingInvite])

  async function onContinue() {
    setBusy(true)
    try {
      if (choice === 'create') {
        await window.grayBridge?.teamCreate?.()
        return
      }
      const res = await window.grayBridge?.teamJoin?.(code)
      if (!res?.ok) setInvalid(true)
    } finally {
      setBusy(false)
    }
  }

  if (invitePreview && !declinedInvite) {
    return (
      <div className="onb-card">
        <div className="onb-step" key="invite">
          <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
            <div className="onb-eyebrow">Team</div>
            <div className="onb-title">You’re invited</div>
          </div>
          <p className="onb-sub">You’ve been invited to join a team on Gray.</p>
          <div className="onb-gap-10" />
          <div className="onb-invite">
            <span className="onb-invite-name">{invitePreview.name}</span>
            <span className="onb-invite-meta">
              {invitePreview.memberCount} member{invitePreview.memberCount === 1 ? '' : 's'}
            </span>
          </div>
          {invalid && <div className="onb-error">This invite isn’t active anymore — ask for a new link</div>}
          <div className="onb-gap-12" />
          <div className="onb-footer">
            <button
              className="onb-text-btn"
              onClick={() => {
                setDeclinedInvite(true)
                setChoice('create')
              }}
            >
              Not now, start on Personal
            </button>
            <span className="onb-footer-spacer" />
            <button className="btn btn-primary btn-md" disabled={busy} onClick={onContinue}>
              Join {invitePreview.name}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="onb-card">
      <div className="onb-step" key="choose">
        <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
          <div className="onb-eyebrow">Team</div>
          <div className="onb-title">Where will you work?</div>
        </div>
        <div className="onb-gap-10" />
        <div role="radiogroup" aria-label="Team">
          <button
            role="radio"
            aria-checked={choice === 'create'}
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
            role="radio"
            aria-checked={choice === 'join'}
            className={`onb-option ${choice === 'join' ? 'onb-option-on' : ''}`}
            onClick={() => setChoice('join')}
          >
            <span className="onb-option-body">
              <span className="onb-option-title">Join a team</span>
              <span className="onb-option-sub">Use an invite link from your team owner</span>
            </span>
            <span className={`onb-radio ${choice === 'join' ? 'onb-radio-on' : ''}`} />
          </button>
        </div>
        {choice === 'join' && (
          <div className="onb-join-field">
            <input
              className={`onb-input ${invalid ? 'onb-input-error' : ''}`}
              placeholder="Paste invite link or code"
              autoFocus
              value={code}
              onChange={(e) => {
                setCode(e.target.value)
                setInvalid(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onContinue()
              }}
            />
            {invalid && <div className="onb-error">That link didn’t work — ask your team owner to re-send</div>}
          </div>
        )}
        <div className="onb-gap-12" />
        <div className="onb-footer">
          <button className="onb-text-btn" onClick={onBack}>
            Back
          </button>
          <span className="onb-footer-spacer" title={session?.email} />
          <button
            className="btn btn-primary btn-md"
            disabled={busy || (choice === 'join' && !code.trim())}
            onClick={onContinue}
          >
            Continue <span className="btn-arrow">→</span>
          </button>
        </div>
      </div>
    </div>
  )
}

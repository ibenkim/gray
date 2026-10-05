import { useEffect, useRef, useState } from 'react'
import { WorkspaceDialog } from './WorkspaceDialog'
import { formatInviteAge, isInviteExpired } from '../../../shared/teamFormat'
import type { Invite, Member, Team } from '../state/types'

/**
 * Teams roster — same Manage surface for both roles.
 * Owners keep invite / rename / remove; members get a view-only roster.
 */
export default function ManageView({
  team,
  canManage
}: {
  team: NonNullable<Team>
  /** Owner-only actions: invite, rename, remove, resend/revoke. */
  canManage: boolean
}) {
  const [inviting, setInviting] = useState(false)
  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(team.name)
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null)
  const inviteRef = useRef<HTMLInputElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setNameDraft(team.name)
  }, [team.name])

  useEffect(() => {
    if (inviting) inviteRef.current?.focus()
  }, [inviting])

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus()
      renameRef.current?.select()
    }
  }, [renaming])

  async function commitRename() {
    const next = nameDraft.trim()
    setRenaming(false)
    if (!next || next === team.name) {
      setNameDraft(team.name)
      return
    }
    await window.ghostBridge?.teamRename?.(next)
  }

  async function sendInvite() {
    const res = await window.ghostBridge?.teamInvite?.(email)
    if (res?.error) {
      setEmailError(true)
      return
    }
    setEmail('')
    setEmailError(false)
    setInviting(false)
  }

  const members = team.members
  const invites = team.invites
  const memberLabel = `${members.length} member${members.length === 1 ? '' : 's'}`

  return (
    <div className="ws-view">
      <div className="ws-header">
        <div className="manage-header-left">
          {renaming && canManage ? (
            <input
              ref={renameRef}
              className="ws-rename-input manage-rename-input"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitRename()
                }
                if (e.key === 'Escape') {
                  setNameDraft(team.name)
                  setRenaming(false)
                }
              }}
              onBlur={() => void commitRename()}
            />
          ) : (
            <>
              <div className="ws-header-title">Manage Team</div>
              <div className="ws-header-sub">{memberLabel}</div>
            </>
          )}
        </div>
        {canManage && (
          <div className="manage-header-actions">
            {inviting ? (
              <div className={`manage-invite-field ${emailError ? 'manage-invite-field-error' : ''}`}>
                <input
                  ref={inviteRef}
                  type="email"
                  placeholder="Email address"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setEmailError(false)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void sendInvite()
                    }
                    if (e.key === 'Escape') {
                      setInviting(false)
                      setEmail('')
                      setEmailError(false)
                    }
                  }}
                />
                {emailError && (
                  <div className="manage-invite-error">That doesn’t look like an email</div>
                )}
              </div>
            ) : (
              <>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setInviting(true)
                    setEmailError(false)
                  }}
                >
                  Invite to Team
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setNameDraft(team.name)
                    setRenaming(true)
                  }}
                >
                  Edit
                </button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="manage-section">
        <div className="manage-section-label">MEMBERS</div>
        <div className="ws-rows">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              canManage={canManage}
              onRemove={() => setRemoveTarget(m)}
            />
          ))}
        </div>
      </div>

      {invites.length > 0 && (
        <div className="manage-section">
          <div className="manage-section-label">INVITED</div>
          <div className="ws-rows">
            {invites.map((invite) => (
              <InvitedRow key={invite.id} invite={invite} canManage={canManage} />
            ))}
          </div>
        </div>
      )}

      {removeTarget && canManage && (
        <WorkspaceDialog
          title="Remove member?"
          confirmLabel="Remove member"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => {
            const id = removeTarget.id
            setRemoveTarget(null)
            void window.ghostBridge?.teamRemoveMember?.(id)
          }}
        >
          <p className="delete-dialog-target">{removeTarget.name}</p>
          <p>
            They keep their personal workflows. Workflows they shared stay with the team. Their
            scheduled team runs stop today.
          </p>
        </WorkspaceDialog>
      )}
    </div>
  )
}

function MemberRow({
  member,
  canManage,
  onRemove
}: {
  member: Member
  canManage: boolean
  onRemove: () => void
}) {
  const canRemove = canManage && member.role !== 'owner' && !member.isSelf
  return (
    <div className={`ws-row manage-member-row ${canRemove ? 'manage-member-removable' : ''}`}>
      <span className="ws-row-name">{member.name}</span>
      <span className="ws-row-right">
        {member.role === 'owner' && <span className="manage-role-chip">Owner</span>}
        {canRemove && (
          <button
            className="manage-remove-btn"
            title="Remove member"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            <RemoveX />
          </button>
        )}
      </span>
    </div>
  )
}

function InvitedRow({ invite, canManage }: { invite: Invite; canManage: boolean }) {
  const expired = isInviteExpired(invite)
  const age = formatInviteAge(invite)
  return (
    <div className={`ws-row manage-invite-row ${expired ? 'manage-invite-row-expired' : ''}`}>
      <span className="manage-invite-email">{invite.email}</span>
      <span className="manage-invite-age">· {age}</span>
      <span className="manage-invite-spacer" />
      {canManage && (
        <>
          <button
            className="manage-invite-resend"
            onClick={() => void window.ghostBridge?.teamResendInvite?.(invite.id)}
          >
            Resend
          </button>
          <button
            className="manage-invite-revoke"
            onClick={() => void window.ghostBridge?.teamRevokeInvite?.(invite.id)}
          >
            Revoke
          </button>
        </>
      )}
    </div>
  )
}

function RemoveX() {
  return (
    <svg width="7" height="7" viewBox="0 0 7 7" fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M0.5 0.5 6.5 6.5M6.5 0.5 0.5 6.5" />
    </svg>
  )
}

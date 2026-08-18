import { useEffect, useRef, useState } from 'react'
import { formatSchedule } from '../../../shared/schedule'
import type { Suggestion, Workflow } from '../state/types'
import AppChip from '../components/shared/AppChip'

/** 1.2–1.4 — Workflows home: metric header, rows with On/Off, Suggested card.
 *  Shared page reuses the same row grammar with a "shared by …" chip. */
export default function WorkflowsHome({
  workflows,
  hoursLine,
  suggestion,
  ownerTeamSize,
  variant = 'personal',
  onOpen,
  onToggleStatus,
  onDiscardSuggestion,
  onRename,
  onDuplicate,
  onDelete
}: {
  workflows: Workflow[]
  hoursLine: string
  suggestion: Suggestion | null
  /** When set, home header uses the owner team metric. */
  ownerTeamSize?: number
  /** `shared` lists team-scoped workflows with a "shared by …" chip. */
  variant?: 'personal' | 'shared'
  onOpen: (id: string) => void
  onToggleStatus: (id: string) => void
  onDiscardSuggestion: () => void
  onRename: (id: string, name: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
}) {
  const isShared = variant === 'shared'
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) {
      renameRef.current?.focus()
      renameRef.current?.select()
    }
  }, [renamingId])

  useEffect(() => {
    if (!openMenuId && !deleteId) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpenMenuId(null)
        setDeleteId(null)
      }
      if (openMenuId && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setOpenMenuId(null)
        onDuplicate(openMenuId)
      }
      if (openMenuId && e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        void navigator.clipboard?.writeText?.(`ghost://workflow/${openMenuId}`)
        setOpenMenuId(null)
      }
    }
    function onDown(e: MouseEvent) {
      if (openMenuId && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [openMenuId, deleteId, onDuplicate])

  function commitRename(id: string) {
    const next = nameDraft.trim()
    setRenamingId(null)
    const current = workflows.find((w) => w.id === id)
    if (!next || !current || next === current.name) {
      setNameDraft(current?.name ?? '')
      return
    }
    onRename(id, next)
  }

  const deleteTarget = deleteId ? workflows.find((w) => w.id === deleteId) : null

  // 4.1 first-run — empty Library: ready-state sub-line (no zero metric),
  // centered record CTA that parks the window and opens the record panel.
  // Shared empty state is a quieter mirror (no record CTA).
  if (workflows.length === 0 && !suggestion) {
    return (
      <div className="ws-view">
        <div className="ws-header">
          <div>
            <div className="ws-header-title">{isShared ? 'Shared' : 'Workflows'}</div>
            <div className="ws-header-sub">
              {isShared
                ? 'Nothing shared with the team yet'
                : 'Nothing here yet — yuh is ready when you are'}
            </div>
          </div>
        </div>
        {!isShared && (
          <div className="ws-empty">
            <div className="ws-empty-title">Record your first workflow</div>
            <div className="ws-empty-desc">
              Do the task once, the way you always do.
              <br />
              yuh learns the steps — then does it for you, on schedule.
            </div>
            <button
              className="btn btn-primary btn-md"
              onClick={() => {
                window.ghostBridge?.minimizeWindow?.()
                window.ghostBridge?.openRecordPanel?.()
              }}
            >
              +  Record a workflow
            </button>
            <div className="ws-empty-hint">
              yuh will also suggest workflows when it notices you repeating things
            </div>
          </div>
        )}
      </div>
    )
  }

  // Owner: "6 workflows · Team of 4 · ≈ 21 h returned this month"
  // Employee: title count + hours sub-line (unchanged).
  // Shared: "N shared" count header.
  const hoursMetric = hoursLine.startsWith('≈') ? hoursLine : `≈ ${hoursLine}`
  const isOwnerHeader = !isShared && ownerTeamSize != null

  return (
    <div className="ws-view">
      <div className="ws-header">
        <div>
          {isShared ? (
            <div className="ws-header-title">
              {workflows.length} shared
            </div>
          ) : isOwnerHeader ? (
            <div className="ws-header-title">
              {workflows.length} workflows · Team of {ownerTeamSize} · {hoursMetric}
            </div>
          ) : (
            <>
              <div className="ws-header-title">{workflows.length} workflows</div>
              <div className="ws-header-sub">{hoursLine}</div>
            </>
          )}
        </div>
        {!isShared && (
          <button
            className="btn btn-secondary"
            onClick={() => window.ghostBridge?.openRecordPanel?.()}
          >
            + Record a workflow
          </button>
        )}
      </div>

      <div className="ws-home-body scroll">
        <div className="ws-rows">
        {workflows.map((w) => {
          const schedule = w.trigger.cadence ? formatSchedule(w.trigger.cadence) : null
          const sharedByLabel = w.sharedByName ? `shared by ${w.sharedByName}` : null
          const menuOpen = openMenuId === w.id
          return (
            <div className="ws-row" key={w.id} onClick={() => onOpen(w.id)}>
              {renamingId === w.id ? (
                <input
                  ref={renameRef}
                  className="ws-rename-input"
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={() => commitRename(w.id)}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(w.id)
                    if (e.key === 'Escape') {
                      setNameDraft(w.name)
                      setRenamingId(null)
                    }
                  }}
                />
              ) : (
                <span className={`ws-row-name ${w.status === 'off' ? 'ws-row-name-off' : ''}`}>
                  {w.name}
                  {schedule && <span className="ws-row-schedule">  ·  {schedule}</span>}
                </span>
              )}
              <span className="ws-row-right">
                {isShared && sharedByLabel && (
                  <span className="manage-role-chip">{sharedByLabel}</span>
                )}
                <button
                  className={`status-word ${w.status === 'on' ? 'status-on' : 'status-off'}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleStatus(w.id)
                  }}
                >
                  {w.status === 'on' ? 'On' : 'Off'}
                </button>
                <div
                  className="ws-row-overflow"
                  ref={menuOpen ? menuRef : undefined}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="overflow-btn"
                    title="More"
                    aria-expanded={menuOpen}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      setOpenMenuId(menuOpen ? null : w.id)
                    }}
                  >
                    <OverflowDots />
                  </button>
                  {menuOpen && (
                    <div className="overflow-menu">
                      <button
                        className="overflow-item"
                        onClick={() => {
                          setOpenMenuId(null)
                          setNameDraft(w.name)
                          setRenamingId(w.id)
                        }}
                      >
                        <span>Rename</span>
                        <span className="overflow-shortcut">⏎</span>
                      </button>
                      <button
                        className="overflow-item"
                        onClick={() => {
                          setOpenMenuId(null)
                          onDuplicate(w.id)
                        }}
                      >
                        <span>Duplicate</span>
                        <span className="overflow-shortcut">⌘D</span>
                      </button>
                      <button className="overflow-item overflow-item-dim" disabled>
                        Move to folder…
                      </button>
                      <button
                        className="overflow-item"
                        onClick={() => {
                          void navigator.clipboard?.writeText?.(`ghost://workflow/${w.id}`)
                          setOpenMenuId(null)
                        }}
                      >
                        <span>Copy share link</span>
                        <span className="overflow-shortcut">⌥⌘C</span>
                      </button>
                      <div className="overflow-divider" />
                      <button
                        className="overflow-item"
                        onClick={() => {
                          setOpenMenuId(null)
                          onToggleStatus(w.id)
                        }}
                      >
                        {w.status === 'on' ? 'Turn off' : 'Turn on'}
                      </button>
                      <button
                        className="overflow-item overflow-item-rose"
                        onClick={() => {
                          setOpenMenuId(null)
                          setDeleteId(w.id)
                        }}
                      >
                        Delete…
                      </button>
                    </div>
                  )}
                </div>
                <ChevronRight />
              </span>
            </div>
          )
        })}
        </div>

        {!isShared && suggestion && (
          <div className="suggested-block">
            <div className="suggested-label">Suggested</div>
            <div className="suggested-card">
              <div className="suggested-title">
                {suggestion.title}
                <span className="ws-row-schedule">  ·  {suggestion.schedule}</span>
              </div>
              <div className="suggested-desc">
                {suggestion.descriptionBefore} <AppChip app={suggestion.app} />
                {suggestion.descriptionAfter}
              </div>
              <div className="suggested-noticed">{suggestion.noticedLine}</div>
              <div className="suggested-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => window.ghostBridge?.openEditor?.()}
                >
                  Set it up for me
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => window.ghostBridge?.openRecordPanel?.()}
                >
                  Record it myself
                </button>
                <button className="btn btn-quiet" onClick={onDiscardSuggestion}>
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {deleteTarget && (
        <div
          className="ws-scrim"
          onClick={() => setDeleteId(null)}
          onKeyDown={(e) => e.key === 'Escape' && setDeleteId(null)}
        >
          <div
            className="delete-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="delete-dialog-title">Delete “{deleteTarget.name}”?</div>
            <div className="delete-dialog-body">
              Scheduled runs stop immediately. Its {deleteTarget.runCount} runs stay in History. This
              can’t be undone.
            </div>
            <div className="delete-dialog-actions">
              <button className="btn btn-secondary" onClick={() => setDeleteId(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setDeleteId(null)
                  onDelete(deleteTarget.id)
                }}
              >
                Delete workflow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function ChevronRight() {
  return (
    <svg width="4" height="7" viewBox="0 0 4 7" fill="none" stroke="rgba(161,161,171,0.8)" strokeWidth="1">
      <path d="M0.5 0.5 3.5 3.5 0.5 6.5" />
    </svg>
  )
}

function OverflowDots() {
  return (
    <svg width="11" height="3" viewBox="0 0 11 3" fill="currentColor">
      <circle cx="1.5" cy="1.5" r="1.2" />
      <circle cx="5.5" cy="1.5" r="1.2" />
      <circle cx="9.5" cy="1.5" r="1.2" />
    </svg>
  )
}

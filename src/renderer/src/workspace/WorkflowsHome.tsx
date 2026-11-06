import { useEffect, useRef, useState } from 'react'
import { WorkspaceDialog } from './WorkspaceDialog'
import { WorkspacePopover } from './WorkspacePopover'
import { formatSchedule } from '../../../shared/schedule'
import type { Suggestion, Workflow } from '../state/types'
import type { RecordingSummary } from '../../../shared/types'
import AppChip from '../components/shared/AppChip'
import { IdleMark, RecordDot } from '../components/shared/Marks'
import { recordingStatusLabel } from './UploadReview'

/** Workflows home (Figma: Hero · Workspace / home/workflows): count + hours, rows with
 *  On/Off, and the Suggested card resting at the bottom. Shared reuses the row grammar. */
export default function WorkflowsHome({
  workflows,
  recordings = [],
  onOpenRecording,
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
  /** Saved recordings (personal Library only); shown even when there are no workflows. */
  recordings?: RecordingSummary[]
  onOpenRecording?: (recording: RecordingSummary) => void
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
  const [discarding, setDiscarding] = useState(false)
  /** The open row's More button: the menu is anchored to it in the card's overlay layer. */
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) {
      renameRef.current?.focus()
      renameRef.current?.select()
    }
  }, [renamingId])

  useEffect(() => setDiscarding(false), [suggestion?.id])

  // Menu shortcuts while a row menu is open (dismissal is the popover's).
  useEffect(() => {
    if (!openMenuId) return
    function onKey(e: KeyboardEvent) {
      if (openMenuId && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setOpenMenuId(null)
        onDuplicate(openMenuId)
      }
      if (openMenuId && e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        void navigator.clipboard?.writeText?.(`gray://workflow/${openMenuId}`)
        setOpenMenuId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openMenuId, onDuplicate])

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

  function discard() {
    setDiscarding(true)
    setTimeout(onDiscardSuggestion, 280)
  }

  const deleteTarget = deleteId ? workflows.find((w) => w.id === deleteId) : null

  const recordingsSection =
    !isShared && recordings.length > 0 ? (
      <div className="saved-recordings">
        <div className="suggested-label">Saved recordings</div>
        <div className="ws-rows">
          {recordings.map((r, i) => (
            <div
              className="ws-row"
              key={r.sessionId}
              style={{ ['--i' as string]: i }}
              onClick={() => onOpenRecording?.(r)}
            >
              <span className="ws-row-name">
                <span>{formatRecordingDate(r.startedAt)}</span>
                <span className="ws-row-schedule">{recordingStatusLabel(r)}</span>
              </span>
              <span className="ws-row-right">
                <span className="recording-action">
                  {r.interpretationState === 'complete' ? 'Open interpretation' : 'Review upload'}
                </span>
                <ChevronRight />
              </span>
            </div>
          ))}
        </div>
      </div>
    ) : null

  // 4.1 first-run — empty Library: a ready-state sub-line (no zero metric) and a record CTA
  // that parks the window and opens the record panel. Shared is a quieter mirror.
  if (workflows.length === 0 && !suggestion) {
    return (
      <div className="ws-view">
        <div className="ws-header">
          <div>
            <div className="ws-header-title">{isShared ? 'Shared' : 'Workflows'}</div>
            <div className="ws-header-sub">
              {isShared
                ? 'Nothing shared with the team yet'
                : recordings.length > 0
                  ? 'No workflows yet — your saved recordings are below'
                  : 'Gray is ready when you are'}
            </div>
          </div>
        </div>
        {recordingsSection}
        {!isShared && recordings.length === 0 && (
          <div className="ws-empty">
            <IdleMark className="ws-empty-mark" />
            <div className="ws-empty-title">Record your first workflow</div>
            <div className="ws-empty-desc">Do the task once, the way you always do.</div>
            <button
              className="btn btn-primary btn-md"
              onClick={() => {
                window.grayBridge?.minimizeWindow?.()
                window.grayBridge?.openRecordPanel?.()
              }}
            >
              <RecordDot />
              Record a workflow
            </button>
            <div className="ws-empty-hint">Gray will also suggest workflows when it notices you repeating things</div>
          </div>
        )}
      </div>
    )
  }

  const hoursMetric = hoursLine.startsWith('≈') ? hoursLine : hoursLine.replace(/^0 h/, '0 h')
  const isOwnerHeader = !isShared && ownerTeamSize != null

  return (
    <div className="ws-view">
      <div className="ws-header">
        <div>
          <div className="ws-header-title">
            {isShared ? `${workflows.length} shared` : `${workflows.length} workflows`}
          </div>
          <div className="ws-header-sub">
            {isShared
              ? 'Workflows your team can run'
              : isOwnerHeader
                ? `Team of ${ownerTeamSize} · ${hoursMetric}`
                : hoursMetric}
          </div>
        </div>
        {!isShared && (
          <button className="btn btn-primary btn-ws" onClick={() => window.grayBridge?.openRecordPanel?.()}>
            Record new
          </button>
        )}
      </div>

      <div className="ws-home-body scroll">
        <div className="ws-rows">
          {workflows.map((w, i) => {
            const schedule = w.trigger.cadence ? formatSchedule(w.trigger.cadence) : null
            const sharedByLabel = w.sharedByName ? `shared by ${w.sharedByName}` : null
            const menuOpen = openMenuId === w.id
            return (
              <div
                className={`ws-row ${menuOpen ? 'ws-row-selected' : ''}`}
                key={w.id}
                style={{ ['--i' as string]: i }}
                onClick={() => onOpen(w.id)}
              >
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
                  <span className={`ws-row-name ${w.status === 'off' ? 'ws-row-name-off' : ''}`} title={w.name}>
                    <span>{w.name}</span>
                    {schedule && <span className="ws-row-schedule">{schedule}</span>}
                  </span>
                )}
                <span className="ws-row-right">
                  {isShared && sharedByLabel && <span className="manage-role-chip">{sharedByLabel}</span>}
                  <div className="ws-row-overflow" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="overflow-btn"
                      title="More"
                      aria-label={`More for ${w.name}`}
                      aria-expanded={menuOpen}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        setMenuAnchor(e.currentTarget)
                        setOpenMenuId(menuOpen ? null : w.id)
                      }}
                    >
                      <OverflowDots />
                    </button>
                    {menuOpen && (
                      <WorkspacePopover anchor={menuAnchor} onClose={() => setOpenMenuId(null)} className="overflow-menu">
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
                            void navigator.clipboard?.writeText?.(`gray://workflow/${w.id}`)
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
                      </WorkspacePopover>
                    )}
                  </div>
                  <button
                    className={`status-word ${w.status === 'on' ? 'status-on' : 'status-off'}`}
                    aria-pressed={w.status === 'on'}
                    title={w.status === 'on' ? 'Turn off' : 'Turn on'}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleStatus(w.id)
                    }}
                  >
                    {w.status === 'on' ? 'On' : 'Off'}
                  </button>
                  <ChevronRight />
                </span>
              </div>
            )
          })}
        </div>

        {recordingsSection}

        {!isShared && suggestion && (
          <>
            <div className="ws-home-spacer" />
            <div className="suggested-block">
              <div
                className={`suggested-card ${discarding ? 'suggested-card-leaving' : ''}`}
                title={suggestion.noticedLine}
              >
                <div className="suggested-title">
                  {suggestion.title}
                  <span>{suggestion.schedule}</span>
                </div>
                <div className="suggested-desc">
                  {suggestion.descriptionBefore}
                  <AppChip app={suggestion.app} />
                  <SuggestionTail text={suggestion.descriptionAfter} />
                </div>
                <div className="suggested-actions">
                  <button className="btn btn-secondary btn-suggest" onClick={() => window.grayBridge?.openEditor?.()}>
                    Set it up for me
                  </button>
                  <button
                    className="btn btn-secondary btn-suggest"
                    onClick={() => window.grayBridge?.openRecordPanel?.()}
                  >
                    <RecordDot />
                    Record it myself
                  </button>
                  <button className="btn-discard" onClick={discard}>
                    Discard
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {deleteTarget && (
        <WorkspaceDialog
          title={`Delete “${deleteTarget.name}”?`}
          target={deleteTarget.name}
          confirmLabel="Delete workflow"
          returnFocusTo={menuAnchor}
          onCancel={() => setDeleteId(null)}
          onConfirm={() => {
            setDeleteId(null)
            onDelete(deleteTarget.id)
          }}
        >
          <p>
            Automatic runs stop immediately. Its {deleteTarget.runCount} runs stay in History. This can’t be
            undone.
          </p>
        </WorkspaceDialog>
      )}
    </div>
  )
}

/** "…post them to #eng-handoff with a checklist message." — channels read bold. */
function SuggestionTail({ text }: { text: string }) {
  const parts = text.split(/(#[\w-]+)/g)
  return (
    <>
      {parts.map((p, i) => (/^#[\w-]+$/.test(p) ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>))}
    </>
  )
}

function formatRecordingDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? 'Recording'
    : `Recording · ${d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
}

export function ChevronRight() {
  return (
    <span className="ws-chevron" aria-hidden="true">
      <svg width="4.06" height="6.71" viewBox="0 0 4.06066 6.70711" fill="none">
        <path d="M0.353554 0.353554L3.35355 3.35355L0.353554 6.35355" stroke="currentColor" />
      </svg>
    </span>
  )
}

export function OverflowDots() {
  return (
    <svg width="11" height="3" viewBox="0 0 11 3" fill="currentColor" aria-hidden="true">
      <circle cx="1" cy="1" r="1" transform="translate(0.5 0.5)" />
      <circle cx="5" cy="1" r="1" transform="translate(0.5 0.5)" />
      <circle cx="9" cy="1" r="1" transform="translate(0.5 0.5)" />
    </svg>
  )
}

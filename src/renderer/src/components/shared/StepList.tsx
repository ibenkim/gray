import { useEffect, useRef, useState } from 'react'
import type { EditorStep, StepApp } from '../../state/types'
import AppChip, { AppChipBlank, isAppSlotLabel, withAppSlotBlank } from './AppChip'
import MicIcon from '../ui/MicIcon'
import { PencilIcon } from './TriggerSection'

function renumber(steps: EditorStep[]): EditorStep[] {
  return steps.map((s, i) => ({ ...s, index: i + 1 }))
}

/** Renders a transcript with operator words (Only / Skip / Never) bolded. */
export function Transcript({ text }: { text: string }) {
  const parts = text.split(/\b(Only|Skip|Never)\b/)
  return (
    <>
      {parts.map((part, i) =>
        ['Only', 'Skip', 'Never'].includes(part) ? <strong key={i}>{part}</strong> : part
      )}
    </>
  )
}

type StepListProps = {
  steps: EditorStep[]
  onChange: (updater: (steps: EditorStep[]) => EditorStep[]) => void
  /** Deep-link from run detail "fix a step" — opens that row in edit mode. */
  initialEditStepId?: string | null
}

/**
 * STEPS ledger — identical rows and behavior on every surface (editor,
 * workflow detail). Hover edit/delete, inline edit → "Forming new step…" →
 * resolved flash, fix-step cards whose selections are never terminal.
 */
export default function StepList({ steps, onChange, initialEditStepId }: StepListProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [customFixId, setCustomFixId] = useState<string | null>(null)
  const [customFixText, setCustomFixText] = useState('')
  const newStepIds = useRef(new Set<string>())
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const openedEditRef = useRef<string | null>(null)

  useEffect(() => {
    if (!initialEditStepId || openedEditRef.current === initialEditStepId) return
    const step = steps.find((s) => s.id === initialEditStepId)
    if (!step) return
    openedEditRef.current = initialEditStepId
    setEditingId(step.id)
    setDraftText(step.title)
  }, [initialEditStepId, steps])

  function setPhase(id: string, phase: EditorStep['phase']) {
    onChange((s) => s.map((step) => (step.id === id ? { ...step, phase } : step)))
  }

  /** Commit an edit: "Forming new step…" → brief resolved flash → normal. */
  function runFormingPipeline(id: string) {
    setPhase(id, 'forming')
    timers.current.push(
      setTimeout(() => {
        setPhase(id, 'resolved')
        timers.current.push(setTimeout(() => setPhase(id, 'normal'), 900))
      }, 1100)
    )
  }

  function beginEdit(step: EditorStep) {
    setEditingId(step.id)
    setDraftText(step.title)
  }

  function commitEdit(step: EditorStep) {
    setEditingId(null)
    const text = draftText.trim()
    if (!text) {
      if (newStepIds.current.has(step.id)) deleteStep(step.id)
      return
    }
    if (text !== step.title) {
      onChange((s) => s.map((x) => (x.id === step.id ? { ...x, title: text } : x)))
      runFormingPipeline(step.id)
    }
    newStepIds.current.delete(step.id)
  }

  function cancelEdit(step: EditorStep) {
    setEditingId(null)
    if (newStepIds.current.has(step.id)) deleteStep(step.id)
  }

  function deleteStep(id: string) {
    newStepIds.current.delete(id)
    onChange((s) => renumber(s.filter((x) => x.id !== id)))
  }

  function addStep() {
    const id = `s${Date.now()}`
    newStepIds.current.add(id)
    onChange((s) => renumber([...s, { id, index: s.length + 1, title: '' }]))
    setEditingId(id)
    setDraftText('')
  }

  /** Picking a chip resolves the card into a chip-token (never terminal). */
  function pickFixOption(step: EditorStep, optionId: string, custom?: string) {
    onChange((s) =>
      s.map((x) =>
        x.id === step.id && x.fix
          ? {
              ...x,
              fix: { ...x.fix, selectedOptionId: optionId, customValue: custom, collapsed: true }
            }
          : x
      )
    )
    setCustomFixId(null)
    setCustomFixText('')
  }

  function reopenFix(step: EditorStep) {
    onChange((s) =>
      s.map((x) =>
        x.id === step.id && x.fix ? { ...x, fix: { ...x.fix, collapsed: false } } : x
      )
    )
  }

  function changeStepApp(step: EditorStep, app: StepApp) {
    if (isAppSlotLabel(step.title)) {
      // Slot step: swap the chip; keep "Open … in" wording (chip shows the app).
      const title = withAppSlotBlank(step.title).replace(/\s*___+\s*$/, '').trim()
      onChange((s) => s.map((x) => (x.id === step.id ? { ...x, app, title } : x)))
      return
    }
    // Unique-to-app: changing the chip rewrites the whole event (open edit).
    onChange((s) => s.map((x) => (x.id === step.id ? { ...x, app } : x)))
    beginEdit({ ...step, app })
  }

  function removeStepApp(step: EditorStep) {
    if (isAppSlotLabel(step.title)) {
      onChange((s) =>
        s.map((x) =>
          x.id === step.id
            ? { ...x, app: undefined, title: withAppSlotBlank(x.title) }
            : x
        )
      )
      return
    }
    // Unique-to-app: removing the chip opens a whole-event edit.
    onChange((s) => s.map((x) => (x.id === step.id ? { ...x, app: undefined } : x)))
    beginEdit({ ...step, app: undefined })
  }

  function pickSlotApp(step: EditorStep, app: StepApp) {
    const title = withAppSlotBlank(step.title).replace(/\s*___+\s*$/, '').trim()
    onChange((s) => s.map((x) => (x.id === step.id ? { ...x, app, title } : x)))
  }

  return (
    <div className="step-list">
      {steps.map((step) => {
        // Amber question card, inline at its step number.
        if (step.fix && !step.fix.collapsed) {
          return (
            <div className="fix-step-row" key={step.id}>
              <span className="step-num fix-num">{step.index}</span>
              <div className="fix-step">
                <div className="fix-step-title">
                  {step.intent && (
                    <span className="step-intent-badge" title={`Intent: ${step.intent}`}>
                      {step.intent}
                    </span>
                  )}
                  {step.title}
                </div>
                <div className="fix-step-prompt">{step.fix.prompt}</div>
                <div className="fix-options">
                  {step.fix.options.map((opt) => {
                    if (opt.kind === 'other' && customFixId === step.id) {
                      return (
                        <input
                          key={opt.id}
                          className="fix-custom-input"
                          autoFocus
                          placeholder="Type a value…"
                          value={customFixText}
                          onChange={(e) => setCustomFixText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && customFixText.trim())
                              pickFixOption(step, opt.id, customFixText.trim())
                            if (e.key === 'Escape') setCustomFixId(null)
                          }}
                        />
                      )
                    }
                    const selected = step.fix!.selectedOptionId === opt.id
                    return (
                      <button
                        key={opt.id}
                        className={`fix-option ${
                          selected
                            ? 'fix-option-selected'
                            : opt.kind === 'suggested'
                              ? 'fix-option-suggested'
                              : ''
                        }`}
                        onClick={() =>
                          opt.kind === 'other' ? setCustomFixId(step.id) : pickFixOption(step, opt.id)
                        }
                      >
                        {opt.kind === 'suggested' && <SparkIcon />}
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        }

        const isHovered = hoveredId === step.id
        const isEditing = editingId === step.id
        const isForming = step.phase === 'forming'
        const isResolved = step.phase === 'resolved'
        const fixToken =
          step.fix && step.fix.collapsed
            ? step.fix.customValue ??
              step.fix.options.find((o) => o.id === step.fix!.selectedOptionId)?.label
            : undefined

        const lowConfidence =
          typeof step.confidence === 'number' && step.confidence < 0.6

        return (
          <div key={step.id}>
            <div
              className={`step ${isHovered && !isForming ? 'step-hovered' : ''} ${
                isResolved ? 'step-flash' : ''
              } ${lowConfidence ? 'step-low-confidence' : ''}`}
              onMouseEnter={() => setHoveredId(step.id)}
              onMouseLeave={() => setHoveredId(null)}
              onDoubleClick={() => !isForming && beginEdit(step)}
            >
              <span className="step-num">{step.index}</span>
              {isEditing ? (
                <input
                  className="step-edit-input"
                  autoFocus
                  placeholder="Describe the step in plain language"
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  onBlur={() => commitEdit(step)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit(step)
                    if (e.key === 'Escape') cancelEdit(step)
                  }}
                />
              ) : isForming ? (
                <span className="step-title step-forming">Forming new step…</span>
              ) : (
                <span className="step-title">
                  {step.intent && (
                    <span className="step-intent-badge" title={`Intent: ${step.intent}`}>
                      {step.intent}
                    </span>
                  )}
                  {step.title.replace(/\s*___+\s*$/, '').trim()}
                  {step.app ? (
                    <AppChip
                      app={step.app}
                      editable
                      onChangeApp={(app) => changeStepApp(step, app)}
                      onRemoveApp={() => removeStepApp(step)}
                    />
                  ) : isAppSlotLabel(step.title) ? (
                    <AppChipBlank onPick={(app) => pickSlotApp(step, app)} />
                  ) : null}
                </span>
              )}
              {fixToken && !isEditing && !isForming && (
                <button className="fix-token" onClick={() => reopenFix(step)}>
                  {fixToken}
                  <ChevronTiny />
                </button>
              )}
              {isResolved && !isEditing && (
                <span className="step-check">
                  <CheckIcon />
                </span>
              )}
              {isHovered && !isEditing && !isForming && (
                <span className="step-actions">
                  <button title="Edit" onClick={() => beginEdit(step)}>
                    <PencilIcon />
                  </button>
                  <button title="Delete" onClick={() => deleteStep(step.id)}>
                    <TrashIcon />
                  </button>
                </span>
              )}
            </div>
            {step.requiresSummary && !isEditing && (
              <div className="step-requires-summary">{step.requiresSummary}</div>
            )}
            {step.voiceNote && !isEditing && (
              <div className="step-voice-note">
                <MicIcon size={8} />
                <span className="step-voice-note-text">
                  <Transcript text={step.voiceNote.text} />
                </span>
              </div>
            )}
          </div>
        )
      })}
      <button className="add-step" onClick={addStep}>
        + Add a step
      </button>
    </div>
  )
}

function SparkIcon() {
  return (
    <svg width="10" height="9" viewBox="0 0 10 9" fill="currentColor">
      <path d="M5 0l1.1 2.9L9 4 6.1 5.1 5 8 3.9 5.1 1 4l2.9-1.1z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function ChevronTiny() {
  return (
    <svg width="7" height="4" viewBox="0 0 7 4" fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M0.5 0.5 3.5 3.5 6.5 0.5" />
    </svg>
  )
}

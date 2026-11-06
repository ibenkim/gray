import { useEffect, useRef, useState } from 'react'
import type { EditorStep, StepApp } from '../../state/types'
import AppChip, { AppChipBlank, isAppSlotLabel, withAppSlotBlank } from './AppChip'
import { EnterIcon, PencilIcon } from './TriggerSection'
import RailCell, { type WorkflowRailState } from './RailCell'
import RichText from './RichText'

function renumber(steps: EditorStep[]): EditorStep[] {
  return steps.map((s, i) => ({ ...s, index: i + 1 }))
}

/** Renders a transcript with operator words (Only / Skip / Never) bolded. */
export function Transcript({ text }: { text: string }) {
  const parts = text.split(/\b(Only|Skip|Never)\b/)
  return (
    <>
      {parts.map((part, i) =>
        ['Only', 'Skip', 'Never'].includes(part) ? (
          <span className="transcript-op" key={i}>
            {part}
          </span>
        ) : (
          part
        )
      )}
    </>
  )
}

type StepListProps = {
  steps: EditorStep[]
  onChange: (updater: (steps: EditorStep[]) => EditorStep[]) => void
  /** Deep-link from run detail "fix a step" — opens that row in edit mode. */
  initialEditStepId?: string | null
  /** Stagger the rows in (first open of the editor / overview). */
  animateIn?: boolean
}

const FORMING_MS = 1100
const RESOLVED_MS = 900

/**
 * STEPS ledger — identical rows and behaviour on every surface (editor, workflow detail).
 * Hover shows the pencil; editing is a paper field with an Enter action; a commit shows the
 * accent "Interpreting..." wash, then the resolved row settles. Questions render as the
 * accent decision card whose choices are never terminal (a chosen value re-opens).
 */
export default function StepList({ steps, onChange, initialEditStepId, animateIn = false }: StepListProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [customFixId, setCustomFixId] = useState<string | null>(null)
  const [customFixText, setCustomFixText] = useState('')
  const newStepIds = useRef(new Set<string>())
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const openedEditRef = useRef<string | null>(null)

  useEffect(() => {
    const list = timers.current
    return () => list.forEach(clearTimeout)
  }, [])

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

  /** Commit an edit: "Interpreting..." → brief resolved settle → normal. */
  function runFormingPipeline(id: string) {
    setPhase(id, 'forming')
    timers.current.push(
      setTimeout(() => {
        setPhase(id, 'resolved')
        timers.current.push(setTimeout(() => setPhase(id, 'normal'), RESOLVED_MS))
      }, FORMING_MS)
    )
  }

  function beginEdit(step: EditorStep) {
    setEditingId(step.id)
    setDraftText(step.title.replace(/\s*___+\s*$/, '').trim())
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
      s.map((x) => {
        if (x.id !== step.id || !x.fix) return x
        const opt = x.fix.options.find((o) => o.id === optionId)
        const applyTitle =
          optionId !== 'ask-each-time' &&
          (custom?.trim() || (opt && opt.kind !== 'other' ? opt.label : undefined))
        return {
          ...x,
          title: applyTitle ? applyTitle.slice(0, 400) : x.title,
          fix: {
            ...x.fix,
            selectedOptionId: optionId,
            customValue: custom,
            collapsed: true
          }
        }
      })
    )
    setCustomFixId(null)
    setCustomFixText('')
  }

  function reopenFix(step: EditorStep) {
    onChange((s) =>
      s.map((x) => (x.id === step.id && x.fix ? { ...x, fix: { ...x.fix, collapsed: false } } : x))
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
        s.map((x) => (x.id === step.id ? { ...x, app: undefined, title: withAppSlotBlank(x.title) } : x))
      )
      return
    }
    onChange((s) => s.map((x) => (x.id === step.id ? { ...x, app: undefined } : x)))
    beginEdit({ ...step, app: undefined })
  }

  function pickSlotApp(step: EditorStep, app: StepApp) {
    const title = withAppSlotBlank(step.title).replace(/\s*___+\s*$/, '').trim()
    onChange((s) => s.map((x) => (x.id === step.id ? { ...x, app, title } : x)))
  }

  const isOpenDecision = (s: EditorStep | undefined) => !!s?.fix && !s.fix.collapsed

  return (
    <div className="step-list">
      {steps.map((step, i) => {
        const leading = i > 0
        const trailing = i < steps.length - 1
        const enter = animateIn ? { className: 'enter-rise', style: { ['--i' as string]: i } } : null

        if (isOpenDecision(step)) {
          const fix = step.fix!
          return (
            <div
              key={step.id}
              className={`decision ${enter?.className ?? ''}`}
              style={enter?.style}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <RailCell anchor="decision" state="forming" leading={leading} trailing={trailing} />
              <div className="decision-body">
                <div className="decision-title">
                  {step.intent && (
                    <span className="step-intent-badge" title={`Intent: ${step.intent}`}>
                      {step.intent}
                    </span>
                  )}
                  <RichText text={step.title} />
                </div>
                <div className="decision-prompt">{fix.prompt}</div>
                {fix.context && <div className="decision-context">{fix.context}</div>}
                <div className="decision-options">
                  {fix.options.map((opt) => {
                    if (opt.kind === 'other' && customFixId === step.id) {
                      return (
                        <input
                          key={opt.id}
                          className="chip-input"
                          autoFocus
                          placeholder="Type a value…"
                          value={customFixText}
                          onChange={(e) => setCustomFixText(e.target.value)}
                          onBlur={() => !customFixText.trim() && setCustomFixId(null)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && customFixText.trim())
                              pickFixOption(step, opt.id, customFixText.trim())
                            if (e.key === 'Escape') setCustomFixId(null)
                          }}
                        />
                      )
                    }
                    const selected = fix.selectedOptionId === opt.id && fix.collapsed
                    return (
                      <button
                        key={opt.id}
                        className={`chip ${selected ? 'chip-selected' : ''}`}
                        onClick={() =>
                          opt.kind === 'other' ? setCustomFixId(step.id) : pickFixOption(step, opt.id)
                        }
                      >
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
            ? step.fix.customValue ?? step.fix.options.find((o) => o.id === step.fix!.selectedOptionId)?.label
            : undefined
        const lowConfidence = typeof step.confidence === 'number' && step.confidence < 0.6
        const hasVoice = !!step.voiceNote && !isEditing
        const railState: WorkflowRailState = isOpenDecision(steps[i + 1])
          ? 'before-forming'
          : isOpenDecision(steps[i - 1])
            ? 'after-forming'
            : 'formed'

        return (
          <div
            key={step.id}
            className={[
              'step-row',
              enter?.className ?? '',
              hasVoice ? 'step-row-voice' : '',
              isHovered && !isForming ? 'step-row-hover' : '',
              isEditing ? 'step-row-editing' : '',
              isForming ? 'step-row-forming' : '',
              isResolved ? 'step-row-resolved' : '',
              lowConfidence ? 'step-low-confidence' : ''
            ].join(' ')}
            style={enter?.style}
            onMouseEnter={() => setHoveredId(step.id)}
            onMouseLeave={() => setHoveredId(null)}
            onDoubleClick={() => !isForming && !isEditing && beginEdit(step)}
            onMouseDown={(e) => isEditing && e.stopPropagation()}
          >
            <RailCell
              anchor={hasVoice ? 'voice' : 'standard'}
              state={railState}
              leading={leading}
              trailing={trailing}
            />
            <div className="step-row-body">
              {isEditing ? (
                <div className="step-edit-field">
                  <input
                    className="step-edit-input"
                    autoFocus
                    placeholder="Describe the step in plain language"
                    value={draftText}
                    onChange={(e) => setDraftText(e.target.value)}
                    onBlur={() => commitEdit(step)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit(step)
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        cancelEdit(step)
                      }
                    }}
                  />
                  <button
                    className="enter-btn enter-btn-on"
                    aria-label="Save step"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitEdit(step)}
                  >
                    <EnterIcon />
                  </button>
                </div>
              ) : (
                <div className="step-line">
                  {isForming ? (
                    <span className="step-forming breathe-soft">Interpreting...</span>
                  ) : (
                    <span className="step-title">
                      {step.intent && (
                        <span className="step-intent-badge" title={`Intent: ${step.intent}`}>
                          {step.intent}
                        </span>
                      )}
                      <RichText text={step.title.replace(/\s*___+\s*$/, '').trim()} />
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
                  {fixToken && !isForming && (
                    <button
                      className="fix-token"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => reopenFix(step)}
                      title="Change this answer"
                    >
                      {fixToken}
                      <ChevronTiny />
                    </button>
                  )}
                  {isResolved && (
                    <span className="step-check">
                      <CheckIcon />
                    </span>
                  )}
                  {isHovered && !isForming && !isResolved && (
                    <span className="step-actions" onMouseDown={(e) => e.stopPropagation()}>
                      <button title="Edit step" aria-label="Edit step" onClick={() => beginEdit(step)}>
                        <PencilIcon />
                      </button>
                      <button title="Delete step" aria-label="Delete step" onClick={() => deleteStep(step.id)}>
                        <TrashIcon />
                      </button>
                    </span>
                  )}
                </div>
              )}
              {step.requiresSummary && !isEditing && (
                <div className="step-requires-summary">{step.requiresSummary}</div>
              )}
              {hasVoice && (
                <div className="step-voice-note">
                  <Transcript text={step.voiceNote!.text} />
                </div>
              )}
            </div>
          </div>
        )
      })}
      <button
        className={`add-step ${animateIn ? 'enter-rise' : ''}`}
        style={animateIn ? { ['--i' as string]: steps.length } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={addStep}
      >
        + Add a step
      </button>
    </div>
  )
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
      <path d="M1.5 3h8M4.2 3V1.8h2.6V3M2.6 3l.5 6.5h4.8L8.4 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 6.5L5 9L9.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronTiny() {
  return (
    <svg width="7" height="4" viewBox="0 0 7 4" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true">
      <path d="M0.5 0.5 3.5 3.5 6.5 0.5" />
    </svg>
  )
}

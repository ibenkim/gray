import { useState } from 'react'
import type { FixOption } from '../../state/types'
import RailCell from './RailCell'
import RichText from './RichText'

export type RunCardChip = {
  id: string
  label: string
  kind?: FixOption['kind']
}

type RunCardProps = {
  variant: 'question' | 'error'
  /** Step context line, e.g. "Choose a destination" / "Couldn’t continue". */
  title: string
  /** Coloured prompt / failure copy. */
  message: string
  chips: RunCardChip[]
  /** Optional quiet line under the chips. */
  footer?: string
  onSelect: (chipId: string, custom?: string) => void
  otherPlaceholder?: string
  leading?: boolean
  trailing?: boolean
}

/**
 * Mid-run hold card at the active step — accent for a question (running-question), rose for
 * a failure (Hero · Run paused "Couldn’t continue"). Same chip grammar as the editor's
 * decision card; the rail node turns into the forming spindles while the run holds.
 */
export default function RunCard({
  variant,
  title,
  message,
  chips,
  footer,
  onSelect,
  otherPlaceholder = 'Type a value…',
  leading = true,
  trailing = true
}: RunCardProps) {
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')
  const rose = variant === 'error'

  return (
    <div className={`decision ${rose ? 'decision-rose' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
      <RailCell
        anchor="decision"
        state="forming"
        formingTone={rose ? 'rose' : 'accent'}
        leading={leading}
        trailing={trailing}
      />
      <div className="decision-body" role="group" aria-label={title}>
        <div className="decision-title">
          <RichText text={title} />
        </div>
        <div className="decision-prompt">{message}</div>
        <div className="decision-options">
          {chips.map((chip) => {
            if (chip.kind === 'other' && otherOpen) {
              return (
                <input
                  key={chip.id}
                  className="chip-input"
                  autoFocus
                  placeholder={otherPlaceholder}
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && otherText.trim()) onSelect(chip.id, otherText.trim())
                    if (e.key === 'Escape') setOtherOpen(false)
                  }}
                />
              )
            }
            return (
              <button
                key={chip.id}
                className="chip"
                onClick={() => (chip.kind === 'other' ? setOtherOpen(true) : onSelect(chip.id))}
              >
                {chip.label}
              </button>
            )
          })}
        </div>
        {footer && <div className="decision-foot">{footer}</div>}
      </div>
    </div>
  )
}

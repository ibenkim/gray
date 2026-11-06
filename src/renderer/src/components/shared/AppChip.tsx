import { useEffect, useRef, useState } from 'react'
import type { StepApp } from '../../state/types'
import { PencilIcon } from './TriggerSection'
import notionLogo from '../../assets/apps/notion.svg'
import slackLogo from '../../assets/apps/slack.svg'
import figmaLogo from '../../assets/apps/figma.png'

/** Apps offered when prompting to fill / change a chip. */
export const KNOWN_APPS: StepApp[] = [
  { id: 'notion', name: 'Notion' },
  { id: 'slack', name: 'Slack' },
  { id: 'figma', name: 'Figma' },
  { id: 'chrome', name: 'Chrome' }
]

/** True when the step text is an "Open … in ___" style slot (app is separate). */
export function isAppSlotLabel(text: string): boolean {
  return /\bin(\s+___)?\s*$/i.test(text.trim())
}

/** Normalize a slot-style title to end with ` in ___`. */
export function withAppSlotBlank(text: string): string {
  const base = text
    .replace(/\s*___+\s*$/i, '')
    .replace(/\s+in\s*$/i, '')
    .trim()
  return `${base} in ___`
}

type AppChipProps = {
  app: StepApp
  muted?: boolean
  /** 14px logo for the recording ledger; 16px elsewhere. */
  small?: boolean
  /** Hover edit / delete — used on summary + StepList. */
  editable?: boolean
  onChangeApp?: (app: StepApp) => void
  onRemoveApp?: () => void
}

/** Inline app chip: icon + name, e.g. [logo] Figma. */
export default function AppChip({
  app,
  muted = false,
  small = false,
  editable = false,
  onChangeApp,
  onRemoveApp
}: AppChipProps) {
  const [hovered, setHovered] = useState(false)
  const [picking, setPicking] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!picking) return
    function onPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setPicking(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPicking(false)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [picking])

  return (
    <span
      ref={rootRef}
      className={`app-chip ${small ? 'app-chip-sm' : ''} ${muted ? 'app-chip-muted' : ''} ${editable ? 'app-chip-editable' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <AppLogo id={app.id} />
      <span className="app-chip-name">{app.name}</span>
      {editable && hovered && !picking && (
        <span className="app-chip-actions">
          <button
            type="button"
            title="Change app"
            onClick={(e) => {
              e.stopPropagation()
              setPicking(true)
            }}
          >
            <PencilIcon />
          </button>
          <button
            type="button"
            title="Remove app"
            onClick={(e) => {
              e.stopPropagation()
              onRemoveApp?.()
            }}
          >
            <TrashTiny />
          </button>
        </span>
      )}
      {picking && (
        <AppPicker
          currentId={app.id}
          onPick={(next) => {
            onChangeApp?.(next)
            setPicking(false)
          }}
        />
      )}
    </span>
  )
}

/**
 * Placeholder chip when a slot step has no app yet ("Open … in ___").
 * Click opens the same app picker.
 */
export function AppChipBlank({
  muted = false,
  onPick
}: {
  muted?: boolean
  onPick: (app: StepApp) => void
}) {
  const [picking, setPicking] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!picking) return
    function onPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setPicking(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPicking(false)
    }
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
    }
  }, [picking])

  return (
    <span
      ref={rootRef}
      className={`app-chip app-chip-blank ${muted ? 'app-chip-muted' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        setPicking(true)
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      ___
      {picking && (
        <AppPicker
          onPick={(next) => {
            onPick(next)
            setPicking(false)
          }}
        />
      )}
    </span>
  )
}

function AppPicker({
  currentId,
  onPick
}: {
  currentId?: StepApp['id']
  onPick: (app: StepApp) => void
}) {
  return (
    <span className="app-chip-picker">
      {KNOWN_APPS.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`app-chip-pick ${currentId === a.id ? 'app-chip-pick-active' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onPick(a)
          }}
        >
          <AppLogo id={a.id} />
          {a.name}
        </button>
      ))}
    </span>
  )
}

function TrashTiny() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

const LOGO_SRC: Partial<Record<StepApp['id'], string>> = {
  notion: notionLogo,
  slack: slackLogo,
  figma: figmaLogo
}

/** App logo (Figma: Logo/Notion 16, Logo/Slack 16, figma-2021-05-05). */
export function AppLogo({ id }: { id: StepApp['id'] }) {
  const src = LOGO_SRC[id]
  if (src) return <img className="app-chip-logo" src={src} alt="" draggable={false} />
  if (id === 'chrome') {
    return (
      <svg className="app-chip-logo" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7.6" fill="#fff" />
        <path d="M8 .4a7.6 7.6 0 0 1 6.58 3.8H8a3.8 3.8 0 0 0-3.3 1.9L1.42 3.65A7.6 7.6 0 0 1 8 .4Z" fill="#ea4335" />
        <path d="M1.42 3.65 4.7 9.9a3.8 3.8 0 0 0 4.06 1.82l-2.2 3.82A7.6 7.6 0 0 1 1.42 3.65Z" fill="#34a853" />
        <path d="M14.58 4.2A7.6 7.6 0 0 1 6.56 15.54l2.2-3.82a3.8 3.8 0 0 0 2.56-5.62L14.58 4.2Z" fill="#fbbc05" />
        <circle cx="8" cy="8" r="2.9" fill="#4285f4" stroke="#fff" strokeWidth="1" />
      </svg>
    )
  }
  return (
    <svg className="app-chip-logo" viewBox="0 0 16 16" aria-hidden="true">
      <rect width="16" height="16" rx="4" fill="var(--gray-color-gray-1)" />
    </svg>
  )
}

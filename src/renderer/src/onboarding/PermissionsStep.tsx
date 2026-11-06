import { useEffect, useRef, useState } from 'react'
import type { PermissionId, PermissionsState } from '../state/types'
import { useWorkspaceDrag } from '../hooks/useWorkspaceDrag'

type PermMeta = {
  id: PermissionId
  n: number
  title: string
  allow: string
  why: string
  /** Skippable: the checklist moves on and the complete card shows a dash. */
  skippable?: boolean
  /** Tagged "Optional" in the block header (narration only). */
  optional?: boolean
  deniedTitle: string
  deniedSub: string
  pane: string
  whyLine: [string, string]
}

/**
 * Screen Recording is required. Accessibility is skippable but not really optional: clicks,
 * typing and field names all come from it, and playback cannot run without it. Microphone is
 * optional — it only powers narration.
 */
const PERMISSIONS: PermMeta[] = [
  {
    id: 'screen',
    n: 1,
    title: 'See your screen',
    allow: 'Allow screen recording',
    why: 'So Gray can tell which app and window you’re in while you record. It only looks when you start a recording.',
    deniedTitle: 'Gray can’t see your screen yet',
    deniedSub: 'No pressure — you can turn it on in System Settings. Takes ten seconds.',
    pane: 'Screen Recording',
    whyLine: ['See your screen', ' — to know which app you’re in while you record']
  },
  {
    id: 'accessibility',
    n: 2,
    title: 'Move the cursor',
    allow: 'Allow accessibility',
    skippable: true,
    why: 'Lets Gray capture the buttons you click and the text you type, then click and type for you when a workflow runs.',
    deniedTitle: 'Gray can’t follow your clicks yet',
    deniedSub:
      'Until this is on, recordings only capture app switches — not the clicks and typing a workflow needs.',
    pane: 'Accessibility',
    whyLine: ['Move the cursor', ' — to capture clicks and typing, and to replay them for you']
  },
  {
    id: 'microphone',
    n: 3,
    title: 'Hear your voice',
    allow: 'Allow microphone',
    skippable: true,
    optional: true,
    why: 'Only if you narrate while recording. Your words are transcribed when you press Finish, so Gray knows what you meant.',
    deniedTitle: 'Gray can’t hear you yet',
    deniedSub: 'Narration stays off until the mic is on. You can still record without it.',
    pane: 'Microphone',
    whyLine: ['Hear your voice', ' — only when you choose to narrate a recording']
  }
]

const SETTINGS_PATH = (pane: string): string[] => [
  'Open System Settings  →  Privacy & Security',
  `Click ${pane}`,
  'Turn on Gray, then come back'
]

/** 2.x permissions checklist, 3.1 denied recovery, and 2.5 complete card. */
export default function PermissionsStep({
  permissions,
  micSkipped = false
}: {
  permissions: PermissionsState
  micSkipped?: boolean
}) {
  const [attempted, setAttempted] = useState<Partial<Record<PermissionId, boolean>>>({})
  const [skipped, setSkipped] = useState<Partial<Record<PermissionId, boolean>>>({})
  const [shakeId, setShakeId] = useState<PermissionId | null>(null)
  const [stillOff, setStillOff] = useState<PermissionId | null>(null)
  const [whyOpen, setWhyOpen] = useState(false)
  const whyRef = useRef<HTMLDivElement>(null)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  const isSkipped = (id: PermissionId): boolean => Boolean(skipped[id]) || (id === 'microphone' && micSkipped)
  const resolved = (id: PermissionId): boolean => permissions[id] === 'granted' || isSkipped(id)

  const currentIndex = PERMISSIONS.findIndex((p) => !resolved(p.id))
  const complete = currentIndex === -1

  useEffect(() => {
    if (!whyOpen) return
    function onDown(e: MouseEvent) {
      if (!whyRef.current?.contains(e.target as Node)) setWhyOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setWhyOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [whyOpen])

  async function allow(id: PermissionId) {
    const next = await window.grayBridge?.requestPermission?.(id)
    setAttempted((a) => ({ ...a, [id]: true }))
    if (next?.[id] !== 'granted') setStillOff(null)
  }

  async function checkAgain(id: PermissionId) {
    const next = await window.grayBridge?.getPermissions?.()
    if (next?.[id] !== 'granted') {
      setStillOff(id)
      setShakeId(id)
      setTimeout(() => setShakeId(null), 450)
    }
  }

  function skip(id: PermissionId) {
    setSkipped((s) => ({ ...s, [id]: true }))
    setStillOff(null)
    if (id === 'microphone') void window.grayBridge?.setMicSkipped?.(true)
  }

  if (complete) {
    return (
      <CompleteCard
        axGranted={permissions.accessibility === 'granted'}
        micGranted={permissions.microphone === 'granted'}
        onDone={() => window.grayBridge?.completeOnboarding?.({})}
        onRecord={() => window.grayBridge?.completeOnboarding?.({ openRecordPanel: true })}
      />
    )
  }

  const current = PERMISSIONS[currentIndex]
  const denied = Boolean(attempted[current.id]) && !resolved(current.id)

  return (
    <div className="onb-card onb-perms-card">
      <div className="onb-step" key={denied ? `${current.id}-denied` : 'list'}>
        <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
          <div className="onb-perms-head">
            <span className="onb-eyebrow">Set up</span>
            <span className="onb-counter" aria-live="polite">
              <span key={currentIndex}>{currentIndex + 1}</span> of {PERMISSIONS.length}
            </span>
          </div>
          <div className="onb-title">{denied ? current.deniedTitle : 'Gray needs a few permissions'}</div>
        </div>
        <p className="onb-sub">
          {denied ? current.deniedSub : 'Gray only looks and acts when you tell it to.'}
        </p>

        <div className="onb-gap-sm" />

        {PERMISSIONS.map((perm, i) => {
          if (i < currentIndex) {
            return (
              <div className="onb-row onb-row-done" key={perm.id}>
                <span className="onb-row-num">{perm.n}</span>
                <span className="onb-row-title">{perm.title}</span>
                {isSkipped(perm.id) && permissions[perm.id] !== 'granted' ? (
                  <span className="onb-dash" />
                ) : (
                  <CheckGlyph />
                )}
              </div>
            )
          }
          if (i > currentIndex) {
            return (
              <div className="onb-row" key={perm.id}>
                <span className="onb-row-num">{perm.n}</span>
                <span className="onb-row-title">{perm.title}</span>
              </div>
            )
          }
          return (
            <div
              key={perm.id}
              className={`onb-block ${denied ? 'onb-block-denied' : ''} ${shakeId === perm.id ? 'onb-shake' : ''}`}
            >
              <div className="onb-block-head">
                <span className="onb-block-num">{perm.n}</span>
                <span className="onb-block-title">{perm.title}</span>
                {denied && <span className="onb-block-tag">Needs your permission</span>}
                {!denied && perm.optional && <span className="onb-block-optional">Optional</span>}
              </div>

              {denied ? (
                <>
                  {SETTINGS_PATH(perm.pane).map((line) => (
                    <div className="onb-path-line" key={line}>
                      {line}
                    </div>
                  ))}
                  {stillOff === perm.id && (
                    <div className="onb-still-off">
                      {perm.id === 'screen' ? (
                        <>
                          Still off — if the switch next to Gray is on,{' '}
                          <button
                            className="onb-inline-link"
                            onClick={() => window.grayBridge?.restartApp?.()}
                          >
                            restart Gray
                          </button>
                        </>
                      ) : (
                        'Still off — the switch next to Gray should be on'
                      )}
                    </div>
                  )}
                  <div className="onb-block-actions">
                    <button
                      className="btn btn-primary btn-md"
                      onClick={() => window.grayBridge?.openPermissionSettings?.(perm.id)}
                    >
                      Open System Settings
                    </button>
                    <button className="btn btn-secondary btn-md" onClick={() => checkAgain(perm.id)}>
                      Check again
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="onb-block-why">{perm.why}</p>
                  <div className="onb-block-actions">
                    <button className="btn btn-primary btn-md" onClick={() => allow(perm.id)}>
                      {perm.allow}
                    </button>
                    {perm.skippable ? (
                      <button className="onb-text-btn" onClick={() => skip(perm.id)}>
                        Skip for now
                      </button>
                    ) : (
                      <span className="onb-block-hint">Choose Allow when asked</span>
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}

        <div className="onb-gap-sm" />

        <div className="onb-perms-foot">
          <div className="onb-why-wrap" ref={whyRef}>
            <button className="onb-terms-link" aria-expanded={whyOpen} onClick={() => setWhyOpen((o) => !o)}>
              Why does Gray need this?
            </button>
            {whyOpen && (
              <div className="onb-why-popover" role="dialog" aria-label="Why Gray needs these permissions">
                {PERMISSIONS.map((p) => (
                  <div className="onb-why-line" key={p.id}>
                    <strong>{p.whyLine[0]}</strong>
                    {p.whyLine[1]}
                  </div>
                ))}
                <div className="onb-why-foot">
                  Nothing leaves this Mac except an optional OpenAI call when you press Finish — which
                  includes any narration.
                </div>
              </div>
            )}
          </div>
          {/* Recovering, the block's row holds Settings + Check again; skipping waits down here. */}
          {denied && current.skippable && (
            <button className="onb-text-btn" onClick={() => skip(current.id)}>
              Skip for now
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function CompleteCard({
  axGranted,
  micGranted,
  onDone,
  onRecord
}: {
  axGranted: boolean
  micGranted: boolean
  onDone: () => void
  onRecord: () => void
}) {
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()
  const sub = !axGranted
    ? 'Gray can see which app you’re in. Turn on Accessibility later so recordings capture clicks and typing.'
    : micGranted
      ? 'Gray can watch, act, and listen — only when you ask it to.'
      : 'Gray can watch and act — only when you ask it to. Turn on the mic any time to narrate.'
  const rows: { n: number; title: string; on: boolean }[] = [
    { n: 1, title: 'See your screen', on: true },
    { n: 2, title: 'Move the cursor', on: axGranted },
    { n: 3, title: 'Hear your voice', on: micGranted }
  ]

  return (
    <div className="onb-card onb-perms-card">
      <div className="onb-step" key="complete">
        <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
          <div className="onb-perms-head">
            <span className="onb-eyebrow">Set up</span>
          </div>
          <div className="onb-title">You’re all set</div>
        </div>
        <p className="onb-sub">{sub}</p>

        <div className="onb-gap-sm" />

        {rows.map((row) => (
          <div className="onb-row onb-row-done" key={row.n}>
            <span className="onb-row-num">{row.n}</span>
            <span className="onb-row-title">{row.title}</span>
            {row.on ? <CheckGlyph /> : <span className="onb-dash" />}
          </div>
        ))}

        <div className="onb-gap-sm" />

        <div className="onb-footer">
          <button className="onb-text-btn" onClick={onDone}>
            Done
          </button>
          <span className="onb-footer-spacer" />
          <button className="btn btn-primary btn-md" onClick={onRecord}>
            Record your first workflow
          </button>
        </div>
      </div>
    </div>
  )
}

function CheckGlyph() {
  return (
    <svg className="onb-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label="Allowed">
      <path
        d="M2.5 6.5L5 9L9.5 3"
        pathLength={1}
        stroke="var(--gray-color-ink)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

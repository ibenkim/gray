import { useEffect, useRef, useState } from 'react'
import type { PermissionId, PermissionsState } from '../state/types'
import { useWorkspaceDrag } from '../hooks/useWorkspaceDrag'

type PermMeta = {
  id: PermissionId
  n: number
  title: string
  allow: string
  why: string
  optional?: boolean
  deniedTitle: string
  deniedSub: string
  settingsPath: string[]
  whyLine: string
}

/**
 * Screen Recording is required. Accessibility is skippable but not really
 * optional: clicks, typing and element labels all come from it, and automated
 * playback cannot run without it. Microphone stays deferred until narration ships.
 */
const PERMISSIONS: PermMeta[] = [
  {
    id: 'screen',
    n: 1,
    title: 'See your screen',
    allow: 'Allow screen recording',
    why: 'To read which app and window are active while you record. Nothing leaves this Mac except an optional OpenAI call when you Finish.',
    deniedTitle: 'yuh can’t see your screen yet',
    deniedSub: 'No pressure — you can turn it on in System Settings. Takes ten seconds.',
    settingsPath: [
      'Open System Settings  →  Privacy & Security',
      'Click Screen Recording',
      'Turn on yuh, then come back'
    ],
    whyLine: 'See your screen — so it can watch which app you’re in while you record'
  },
  {
    id: 'accessibility',
    n: 2,
    title: 'See what you click and type',
    allow: 'Allow accessibility',
    optional: true,
    why: 'This is what makes a recording usable — the buttons you click, the text you type, and the names of the fields you type it into. Without it a recording only shows which apps you opened, and yuh cannot replay the workflow for you.',
    deniedTitle: 'yuh can’t see what you do yet',
    deniedSub:
      'Until this is on, recordings only capture app switches — not the clicks and typing needed to rebuild a workflow.',
    settingsPath: [
      'Open System Settings  →  Privacy & Security',
      'Click Accessibility',
      'Turn on yuh, then come back'
    ],
    whyLine: 'See what you click and type — the clicks, text and field names that make a workflow replayable'
  }
]

/** 2.x permissions checklist, 3.1 denied recovery, and 2.5 complete card. */
export default function PermissionsStep({
  permissions,
  axSkipped = false
}: {
  permissions: PermissionsState
  axSkipped?: boolean
}) {
  const [attempted, setAttempted] = useState<Record<string, boolean>>({})
  const [shakeId, setShakeId] = useState<PermissionId | null>(null)
  const [stillOff, setStillOff] = useState<PermissionId | null>(null)
  const [whyOpen, setWhyOpen] = useState(false)
  const [localAxSkipped, setLocalAxSkipped] = useState(axSkipped)
  const whyRef = useRef<HTMLDivElement>(null)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  const resolved = (id: PermissionId): boolean => {
    if (id === 'accessibility') {
      return permissions.accessibility === 'granted' || localAxSkipped
    }
    return permissions[id] === 'granted'
  }

  const currentIndex = PERMISSIONS.findIndex((p) => !resolved(p.id))
  const complete = currentIndex === -1

  useEffect(() => {
    if (!whyOpen) return
    function onDown(e: MouseEvent) {
      if (!whyRef.current?.contains(e.target as Node)) setWhyOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [whyOpen])

  async function allow(id: PermissionId) {
    const next = await window.ghostBridge?.requestPermission?.(id)
    setAttempted((a) => ({ ...a, [id]: true }))
    if (next?.[id] !== 'granted') setStillOff(null)
  }

  async function checkAgain(id: PermissionId) {
    const next = await window.ghostBridge?.getPermissions?.()
    if (next?.[id] !== 'granted') {
      setStillOff(id)
      setShakeId(id)
      setTimeout(() => setShakeId(null), 450)
    }
  }

  function skipAx() {
    setLocalAxSkipped(true)
  }

  if (complete) {
    return (
      <CompleteCard
        axGranted={permissions.accessibility === 'granted'}
        onDone={() => window.ghostBridge?.completeOnboarding?.({})}
        onRecord={() => window.ghostBridge?.completeOnboarding?.({ openRecordPanel: true })}
      />
    )
  }

  const current = PERMISSIONS[currentIndex]
  const denied = attempted[current.id] && !resolved(current.id)
  const requiredCount = PERMISSIONS.filter((p) => !p.optional).length
  const totalShown = PERMISSIONS.length

  return (
    <div className="onb-card onb-perms-card">
      <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
        <div className="onb-perms-head">
          <span className="onb-eyebrow">SET UP</span>
          <span className="onb-counter">
            {currentIndex + 1} of {totalShown}
          </span>
        </div>
        <div className="onb-title">
          {denied
            ? current.deniedTitle
            : requiredCount === 1 && currentIndex === 0
              ? 'yuh needs one permission'
              : 'A few more permissions'}
        </div>
      </div>
      <p className="onb-sub">
        {denied
          ? current.deniedSub
          : current.optional
            ? 'Strongly recommended — recordings capture very little without it.'
            : 'macOS asks once. yuh only looks when you start recording.'}
      </p>

      <div className="onb-gap-sm" />

      {PERMISSIONS.map((perm, i) => {
        if (i < currentIndex) {
          return <DoneRow key={perm.id} n={perm.n} title={perm.title} />
        }
        if (i > currentIndex) {
          return <PendingRow key={perm.id} n={perm.n} title={perm.title} />
        }
        return (
          <div
            key={perm.id}
            className={`onb-block ${denied ? 'onb-block-denied' : ''} ${
              shakeId === perm.id ? 'onb-shake' : ''
            }`}
          >
            <div className="onb-block-head">
              <span className="onb-block-num">{perm.n}</span>
              <span className="onb-block-title">{perm.title}</span>
              {denied && <span className="onb-block-tag">Needs your permission</span>}
              {!denied && perm.optional && (
                <span className="onb-block-optional">Recommended</span>
              )}
            </div>

            {denied ? (
              <>
                {perm.settingsPath.map((line) => (
                  <div className="onb-path-line" key={line}>
                    <span className="onb-path-dot">·</span>
                    {line}
                  </div>
                ))}
                {stillOff === perm.id && (
                  <div className="onb-still-off">Still off — the toggle next to yuh should be on</div>
                )}
                <div className="onb-block-actions">
                  <button
                    className="btn btn-primary btn-md"
                    onClick={() => window.ghostBridge?.openPermissionSettings?.(perm.id)}
                  >
                    Open System Settings
                  </button>
                  <button className="btn btn-secondary btn-md" onClick={() => checkAgain(perm.id)}>
                    Check again
                  </button>
                  {perm.id === 'screen' && (
                    <button className="onb-link" onClick={() => window.ghostBridge?.restartApp?.()}>
                      Restart yuh
                    </button>
                  )}
                  {perm.optional && (
                    <button className="onb-skip" onClick={skipAx}>
                      Skip for now
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="onb-block-why">{perm.why}</p>
                <div className="onb-block-actions">
                  <button className="btn btn-primary btn-md" onClick={() => allow(perm.id)}>
                    {perm.allow}
                  </button>
                  {perm.optional ? (
                    <button className="onb-skip" onClick={skipAx}>
                      Skip for now
                    </button>
                  ) : (
                    <span className="onb-block-hint">macOS will ask — choose Allow</span>
                  )}
                </div>
              </>
            )}
          </div>
        )
      })}

      <div className="onb-gap-sm" />

      <div className="onb-why-wrap" ref={whyRef}>
        <button className="onb-terms-link" onClick={() => setWhyOpen((o) => !o)}>
          Why does yuh need this?
        </button>
        {whyOpen && (
          <div className="onb-why-popover">
            {PERMISSIONS.map((p) => (
              <div className="onb-why-line" key={p.id}>
                {p.whyLine}
              </div>
            ))}
            <div className="onb-why-foot">
              Nothing leaves this Mac except an optional OpenAI call when you Finish.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function DoneRow({ n, title }: { n: number; title: string }) {
  return (
    <div className="onb-row onb-row-done">
      <span className="onb-row-num">{n}</span>
      <span className="onb-row-title">{title}</span>
      <CheckGlyph />
    </div>
  )
}

function PendingRow({ n, title }: { n: number; title: string }) {
  return (
    <div className="onb-row onb-row-pending">
      <span className="onb-row-num">{n}</span>
      <span className="onb-row-title">{title}</span>
    </div>
  )
}

function CompleteCard({
  axGranted,
  onDone,
  onRecord
}: {
  axGranted: boolean
  onDone: () => void
  onRecord: () => void
}) {
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()
  return (
    <div className="onb-card onb-perms-card">
      <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
        <div className="onb-perms-head">
          <span className="onb-eyebrow">SET UP</span>
        </div>
        <div className="onb-title">You’re all set</div>
      </div>
      <p className="onb-sub">
        {axGranted
          ? 'yuh can watch which app you’re in, what you click and what you type — only when you start recording.'
          : 'yuh can only see which app you’re in. Turn on Accessibility later to capture clicks and typing, which workflows need to replay.'}
      </p>

      <div className="onb-gap-sm" />

      <div className="onb-row onb-row-done">
        <span className="onb-row-num">1</span>
        <span className="onb-row-title">See your screen</span>
        <CheckGlyph />
      </div>
      <div className="onb-row onb-row-done">
        <span className="onb-row-num">2</span>
        <span className="onb-row-title">See what you click and type</span>
        {axGranted ? <CheckGlyph /> : <span className="onb-dash" />}
      </div>

      <div className="onb-gap-sm" />

      <div className="onb-footer">
        <button className="onb-link" onClick={onDone}>
          Done
        </button>
        <span className="onb-footer-spacer" />
        <button className="btn btn-primary btn-md" onClick={onRecord}>
          Record your first workflow
        </button>
      </div>
    </div>
  )
}

function CheckGlyph() {
  return (
    <svg className="onb-check" width="12" height="9" viewBox="0 0 12 9" fill="none">
      <path
        d="M1 4.5 4.5 8 11 1"
        stroke="var(--gray-color-ink)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

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

const PERMISSIONS: PermMeta[] = [
  {
    id: 'screen',
    n: 1,
    title: 'See your screen',
    allow: 'Allow screen recording',
    why: 'To watch what you do while you record, and to see your apps while workflows run. Nothing leaves this Mac.',
    deniedTitle: 'yuh can’t see your screen yet',
    deniedSub: 'No pressure — you can turn it on in System Settings. Takes ten seconds.',
    settingsPath: [
      'Open System Settings  →  Privacy & Security',
      'Click Screen Recording',
      'Turn on yuh, then come back'
    ],
    whyLine: 'See your screen — so it can record and run your workflows'
  },
  {
    id: 'accessibility',
    n: 2,
    title: 'Move the cursor',
    allow: 'Allow accessibility',
    why: 'Clicks, typing, opening apps — exactly as shown. You can take over any time.',
    deniedTitle: 'yuh can’t move the cursor yet',
    deniedSub: 'No pressure — you can turn it on in System Settings. Takes ten seconds.',
    settingsPath: [
      'Open System Settings  →  Privacy & Security',
      'Click Accessibility',
      'Turn on yuh, then come back'
    ],
    whyLine: 'Move the cursor — so it can click and type for you'
  },
  {
    id: 'microphone',
    n: 3,
    title: 'Hear your voice',
    allow: 'Allow microphone',
    optional: true,
    why: 'So you can narrate steps out loud while recording. Optional — add it whenever you like.',
    deniedTitle: 'yuh can’t hear your voice yet',
    deniedSub: 'Optional — turn it on in System Settings whenever you like.',
    settingsPath: [
      'Open System Settings  →  Privacy & Security',
      'Click Microphone',
      'Turn on yuh, then come back'
    ],
    whyLine: 'Hear your voice — so it can capture narration (optional)'
  }
]

/** 2.x permissions checklist, 3.1 denied recovery, and 2.5 complete card. */
export default function PermissionsStep({
  permissions,
  micSkipped
}: {
  permissions: PermissionsState
  micSkipped: boolean
}) {
  const [attempted, setAttempted] = useState<Record<string, boolean>>({})
  const [shakeId, setShakeId] = useState<PermissionId | null>(null)
  const [stillOff, setStillOff] = useState<PermissionId | null>(null)
  const [whyOpen, setWhyOpen] = useState(false)
  const whyRef = useRef<HTMLDivElement>(null)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  const resolved = (id: PermissionId): boolean => {
    if (id === 'microphone') return permissions.microphone === 'granted' || micSkipped
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
    const granted =
      id === 'microphone' ? next?.microphone === 'granted' : next?.[id] === 'granted'
    if (!granted) setStillOff(null)
  }

  async function checkAgain(id: PermissionId) {
    const next = await window.ghostBridge?.getPermissions?.()
    const granted =
      id === 'microphone' ? next?.microphone === 'granted' : next?.[id] === 'granted'
    if (!granted) {
      setStillOff(id)
      setShakeId(id)
      setTimeout(() => setShakeId(null), 450)
    }
  }

  function skipMic() {
    window.ghostBridge?.setMicSkipped?.(true)
  }

  if (complete) {
    return (
      <CompleteCard
        micGranted={permissions.microphone === 'granted'}
        onDone={() => window.ghostBridge?.completeOnboarding?.({})}
        onRecord={() => window.ghostBridge?.completeOnboarding?.({ openRecordPanel: true })}
      />
    )
  }

  const current = PERMISSIONS[currentIndex]
  const denied = attempted[current.id] && !resolved(current.id)

  return (
    <div className="onb-card onb-perms-card">
      <div className="onb-card-drag" onMouseDown={onDragMouseDown}>
        <div className="onb-perms-head">
          <span className="onb-eyebrow">SET UP</span>
          <span className="onb-counter">{currentIndex + 1} of 3</span>
        </div>
        <div className="onb-title">{denied ? current.deniedTitle : 'yuh needs a few permissions'}</div>
      </div>
      <p className="onb-sub">
        {denied
          ? current.deniedSub
          : 'macOS asks once for each. yuh only looks and acts when you tell it to.'}
      </p>

      <div className="onb-gap-sm" />

      {PERMISSIONS.map((perm, i) => {
        if (i < currentIndex) {
          return <DoneRow key={perm.id} n={perm.n} title={perm.title} />
        }
        if (i > currentIndex) {
          return <PendingRow key={perm.id} n={perm.n} title={perm.title} />
        }
        // Current row — normal (gray) or denied recovery (amber).
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
              {!denied && perm.optional && <span className="onb-block-optional">Optional</span>}
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
                    className="onb-btn-primary"
                    onClick={() => window.ghostBridge?.openPermissionSettings?.(perm.id)}
                  >
                    Open System Settings
                  </button>
                  <button className="onb-btn-secondary" onClick={() => checkAgain(perm.id)}>
                    Check again
                  </button>
                  {perm.id === 'screen' && (
                    <button className="onb-link" onClick={() => window.ghostBridge?.restartApp?.()}>
                      Restart yuh
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <p className="onb-block-why">{perm.why}</p>
                <div className="onb-block-actions">
                  <button className="onb-btn-primary" onClick={() => allow(perm.id)}>
                    {perm.allow}
                  </button>
                  {perm.optional ? (
                    <button className="onb-skip" onClick={skipMic}>
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
            <div className="onb-why-foot">Nothing leaves this Mac.</div>
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
  micGranted,
  onDone,
  onRecord
}: {
  micGranted: boolean
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
      <p className="onb-sub">yuh can watch, act, and listen — only when you ask it to.</p>

      <div className="onb-gap-sm" />

      <div className="onb-row onb-row-done">
        <span className="onb-row-num">1</span>
        <span className="onb-row-title">See your screen</span>
        <CheckGlyph />
      </div>
      <div className="onb-row onb-row-done">
        <span className="onb-row-num">2</span>
        <span className="onb-row-title">Move the cursor</span>
        <CheckGlyph />
      </div>
      <div className="onb-row onb-row-done">
        <span className="onb-row-num">3</span>
        <span className="onb-row-title">Hear your voice</span>
        {micGranted ? <CheckGlyph /> : <span className="onb-dash" />}
      </div>

      <div className="onb-gap-sm" />

      <div className="onb-footer">
        <button className="onb-link" onClick={onDone}>
          Done
        </button>
        <span className="onb-footer-spacer" />
        <button className="onb-btn-primary" onClick={onRecord}>
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
        stroke="var(--purple-70)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

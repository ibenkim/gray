import { useEffect, useRef, useState } from 'react'
import type { RecordDropdownCommand, RecordDropdownSnapshot } from '../../../shared/types'
import { GestureTracker } from '../hooks/useWindowDrag'
import RecordPanel from './panels/RecordPanel'

type CommandBody = RecordDropdownCommand extends infer C
  ? C extends RecordDropdownCommand
    ? Omit<C, 'id'>
    : never
  : never

/** Unique per document: a reloaded child never replays an earlier id. */
const docPrefix = Math.random().toString(36).slice(2, 10)
let seq = 0

/**
 * The Record dropdown window (M1-HF3). Renders the real RecordPanel from the pill's snapshot
 * and sends explicit commands back; the pill remains the only form, recording and narration
 * owner. No provider, capture or grayBridge exists in this window.
 */
export default function RecordDropdown() {
  const bridge = window.grayDropdown
  const [snap, setSnap] = useState<RecordDropdownSnapshot | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const readySent = useRef(false)
  /** Bumped each time the window is shown, so the panel replays its open motion. */
  const [openSeq, setOpenSeq] = useState(0)
  /** The installed apps' own icons (main caches them); null until the first answer. */
  const [icons, setIcons] = useState<Record<string, string> | null>(null)
  const iconsFor = useRef('')
  const iconsReady = useRef<Promise<void> | null>(null)

  useEffect(() => {
    const replay = () => {
      if (document.visibilityState === 'visible') setOpenSeq((n) => n + 1)
    }
    document.addEventListener('visibilitychange', replay)
    return () => document.removeEventListener('visibilitychange', replay)
  }, [])

  useEffect(() => {
    if (!bridge) return
    const off = bridge.onSnapshot(setSnap)
    bridge.hello()
    return off
  }, [bridge])

  // Ask main for the listed apps' icons whenever the list changes.
  const appIds = snap?.apps.map((a) => a.id).join(',') ?? ''
  useEffect(() => {
    if (!bridge || !appIds || iconsFor.current === appIds) return
    iconsFor.current = appIds
    const ask = bridge.appIcons?.(appIds.split(',')) ?? Promise.resolve({})
    iconsReady.current = ask.then(
      (map) => setIcons(map ?? {}),
      () => setIcons({})
    )
  }, [bridge, appIds])

  // Report the real panel's height; ready once the first snapshot has laid out with its fonts
  // and app icons (so they never pop in after the window shows; at most 300 ms of waiting).
  useEffect(() => {
    const el = panelRef.current
    if (!bridge || !snap || !el) return
    const report = () => bridge.measured(Math.ceil(el.getBoundingClientRect().height))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    if (!readySent.current) {
      readySent.current = true
      const iconsSettled = Promise.race([
        iconsReady.current ?? Promise.resolve(),
        new Promise<void>((r) => setTimeout(r, 300))
      ])
      void Promise.all([document.fonts.ready, iconsSettled]).then(() =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            report()
            bridge.ready()
          })
        )
      )
    }
    return () => observer.disconnect()
  }, [bridge, snap])

  useEffect(() => {
    if (!bridge) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') bridge.dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [bridge])

  // Header drag moves the pill + dropdown through the pill's gesture owner in main.
  const trackerRef = useRef<GestureTracker | null>(null)
  const tokenRef = useRef<Promise<number | null> | null>(null)
  if (!trackerRef.current) {
    trackerRef.current = new GestureTracker({
      start: () => {
        tokenRef.current = bridge?.dragStart() ?? null
      },
      end: () => {
        const token = tokenRef.current
        tokenRef.current = null
        void (token ?? Promise.resolve(null)).then((t) => bridge?.dragEnd(t))
      }
    })
  }
  useEffect(() => {
    const tracker = trackerRef.current!
    const onMove = (e: MouseEvent) => tracker.move(e.screenX, e.screenY)
    const onUp = () => void tracker.up()
    const onCancel = () => tracker.cancel()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('blur', onCancel)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      tracker.cancel()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [])

  const send = (body: CommandBody) => bridge?.command({ ...body, id: `${docPrefix}-${++seq}` } as RecordDropdownCommand)

  return (
    <div className="record-dropdown">
      <div ref={panelRef} className="record-dropdown-panel">
        <div key={openSeq} className={openSeq > 0 ? 'record-dropdown-open' : undefined}>
        {snap && (
          <RecordPanel
            recordMode={snap.recordMode}
            onRecordMode={(value) => send({ type: 'setRecordMode', value })}
            apps={snap.apps}
            icons={icons}
            selectedAppIds={snap.selectedAppIds?.length ? snap.selectedAppIds : [snap.selectedAppId]}
            onToggleApp={(value) => send({ type: 'toggleApp', value })}
            narrate={snap.narrate}
            onNarrate={(value) => send({ type: 'setNarrate', value })}
            screenGranted={snap.screenGranted}
            micGranted={snap.micGranted}
            busy={snap.busy}
            onRecord={() => send({ type: 'start' })}
            onScreenRecovery={() => send({ type: 'openScreenSettings' })}
            onMicSettings={() => send({ type: 'openMicSettings' })}
            onHeaderMouseDown={(e) => {
              if (e.button === 0) trackerRef.current!.down(e.screenX, e.screenY)
            }}
          />
        )}
        </div>
      </div>
    </div>
  )
}

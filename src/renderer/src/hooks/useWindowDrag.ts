import { useEffect, useRef } from 'react'
import { useWorkflow } from '../state/WorkflowContext'

const DRAG_THRESHOLD_PX = 4

/**
 * Press → drag/tap state for one native window gesture (M1-HF2). Pure so it can be tested:
 * a drag ends exactly once on release, cancel, blur or unmount, and the click a completed
 * drag would generate is suppressed (normal taps and button clicks are untouched).
 */
export class GestureTracker {
  private state: 'idle' | 'pressed' | 'dragging' = 'idle'
  private start: { x: number; y: number } | null = null
  private suppressClick = false

  constructor(
    private readonly io: {
      start: (x: number, y: number) => void
      end: () => void
      tap?: () => void
    },
    private readonly threshold = DRAG_THRESHOLD_PX
  ) {}

  get dragging(): boolean {
    return this.state === 'dragging'
  }

  down(x: number, y: number): void {
    this.state = 'pressed'
    this.start = { x, y }
    this.suppressClick = false
  }

  move(x: number, y: number): void {
    if (this.state !== 'pressed' || !this.start) return
    const dx = x - this.start.x
    const dy = y - this.start.y
    if (dx * dx + dy * dy < this.threshold * this.threshold) return
    this.state = 'dragging'
    this.io.start(x, y)
  }

  /** Release: 'drag' (gesture ended), 'tap' (no movement) or 'none'. */
  up(): 'drag' | 'tap' | 'none' {
    const was = this.state
    this.state = 'idle'
    this.start = null
    if (was === 'dragging') {
      this.io.end()
      this.suppressClick = true
      return 'drag'
    }
    if (was === 'pressed') {
      this.io.tap?.()
      return 'tap'
    }
    return 'none'
  }

  /** Blur / pointercancel / unmount: end an active drag without a tap. */
  cancel(): void {
    const was = this.state
    this.state = 'idle'
    this.start = null
    if (was === 'dragging') {
      this.io.end()
      this.suppressClick = true
    }
  }

  /** True when this click is the tail of a completed drag and must not activate. */
  consumeClick(): boolean {
    const s = this.suppressClick
    this.suppressClick = false
    return s
  }
}

/**
 * Shared pill-window drag (pill, record/learning/editor/running/summary panels). Callers
 * attach `onMouseDown` to a drag surface; interactive children should `stopPropagation`
 * on their own mousedown so they stay clickable. `onTap` fires for a press without drag.
 */
export function useWindowDrag(opts: { onTap?: () => void; preventDefault?: boolean } = {}) {
  const { beginDrag, endDrag } = useWorkflow()
  const onTapRef = useRef(opts.onTap)
  onTapRef.current = opts.onTap
  const tokenRef = useRef<Promise<number | null> | null>(null)
  const trackerRef = useRef<GestureTracker | null>(null)
  if (!trackerRef.current) {
    trackerRef.current = new GestureTracker({
      start: (x, y) => {
        const { collapseToPill } = beginDrag()
        tokenRef.current = window.ghostBridge?.dragStart?.(x, y, { collapseToPill }) ?? null
      },
      end: () => {
        const token = tokenRef.current
        tokenRef.current = null
        endDrag()
        // Only this gesture's owner/token can end it in main.
        void (token ?? Promise.resolve(null)).then((t) => window.ghostBridge?.dragEnd?.(t))
      },
      tap: () => onTapRef.current?.()
    })
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if (opts.preventDefault) e.preventDefault()
    trackerRef.current!.down(e.clientX, e.clientY)
  }

  useEffect(() => {
    const tracker = trackerRef.current!
    const onMove = (e: MouseEvent) => tracker.move(e.clientX, e.clientY)
    const onUp = () => void tracker.up()
    const onCancel = () => tracker.cancel()
    const onClick = (e: MouseEvent) => {
      if (tracker.consumeClick()) {
        e.stopPropagation()
        e.preventDefault()
      }
    }
    const onNativeDragStart = (e: DragEvent) => e.preventDefault()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('dragend', onUp)
    window.addEventListener('blur', onCancel)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('click', onClick, true)
    window.addEventListener('dragstart', onNativeDragStart, true)
    return () => {
      tracker.cancel()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('dragend', onUp)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('dragstart', onNativeDragStart, true)
    }
  }, [])

  return { onMouseDown }
}

import { useEffect, useRef } from 'react'
import { useWorkflow } from '../state/WorkflowContext'

/**
 * Shared pill-window drag — same `pill:dragStart` path GhostPill uses.
 * Callers attach `onMouseDown` to a drag surface; interactive children should
 * `stopPropagation` on their own mousedown so they stay clickable.
 */
export function useWindowDrag() {
  const { beginDrag, endDrag } = useWorkflow()
  const dragging = useRef(false)
  const pressStart = useRef<{ x: number; y: number } | null>(null)

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    pressStart.current = { x: e.clientX, y: e.clientY }
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!pressStart.current || dragging.current) return
      const dx = e.clientX - pressStart.current.x
      const dy = e.clientY - pressStart.current.y
      if (dx * dx + dy * dy < 16) return
      dragging.current = true
      const { collapseToPill } = beginDrag()
      window.ghostBridge?.dragStart?.(e.clientX, e.clientY, { collapseToPill })
    }
    function onUp() {
      pressStart.current = null
      if (!dragging.current) return
      dragging.current = false
      endDrag()
      window.ghostBridge?.dragEnd?.()
    }
    function onNativeDragStart(e: DragEvent) {
      e.preventDefault()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('dragend', onUp)
    window.addEventListener('dragstart', onNativeDragStart, true)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('dragend', onUp)
      window.removeEventListener('dragstart', onNativeDragStart, true)
    }
  }, [beginDrag, endDrag])

  return { onMouseDown }
}

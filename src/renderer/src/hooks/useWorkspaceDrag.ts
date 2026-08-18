import { useEffect, useRef } from 'react'

/**
 * Library window drag — reuses the shared `pill:dragStart` IPC path.
 * Main skips pill collapse/anchor when the sender is the workspace window.
 * Interactive chrome (traffic lights) should `stopPropagation` on mousedown.
 */
export function useWorkspaceDrag() {
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
      window.ghostBridge?.dragStart?.(e.clientX, e.clientY, { collapseToPill: false })
    }
    function onUp() {
      pressStart.current = null
      if (!dragging.current) return
      dragging.current = false
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
  }, [])

  return { onMouseDown }
}

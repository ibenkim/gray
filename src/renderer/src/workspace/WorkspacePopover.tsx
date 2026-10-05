import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * The workspace card's overlay layer (HF4): menus and dialogs render here, above the content
 * column and drag strip, so scrolling lists and nested stacking contexts cannot clip them.
 * Null outside WorkspaceApp (static renders), where overlays render in place.
 */
export const OverlayHostContext = createContext<HTMLElement | null>(null)

const EDGE = 8
const GAP = 4

/**
 * A menu anchored to an opener, kept inside the card: right-aligned (or left-aligned) to the
 * anchor, flipped above when below does not fit, clamped to the card, and scrolling within its
 * available height. Listeners exist only while it is open. Scrolling an ancestor closes it.
 */
export function WorkspacePopover({
  anchor,
  onClose,
  className,
  align = 'right',
  matchAnchorWidth = false,
  children
}: {
  anchor: HTMLElement | null
  onClose: () => void
  className: string
  align?: 'left' | 'right'
  matchAnchorWidth?: boolean
  children: ReactNode
}) {
  const host = useContext(OverlayHostContext)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number; width?: number } | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const place = useCallback(() => {
    const el = ref.current
    if (!el || !host || !anchor) return
    if (!anchor.isConnected) {
      onCloseRef.current()
      return
    }
    const card = host.getBoundingClientRect()
    const a = anchor.getBoundingClientRect()
    const width = matchAnchorWidth ? a.width : el.offsetWidth
    const natural = el.scrollHeight
    const below = card.bottom - EDGE - (a.bottom + GAP)
    const above = a.top - GAP - (card.top + EDGE)
    const placeBelow = natural <= below || below >= above
    const maxHeight = Math.max(0, placeBelow ? below : above)
    const height = Math.min(natural, maxHeight)
    const top = placeBelow ? a.bottom + GAP : a.top - GAP - height
    const preferred = align === 'right' ? a.right - width : a.left
    const left = Math.min(Math.max(preferred, card.left + EDGE), card.right - EDGE - width)
    setPos((p) => {
      const next = { left: left - card.left, top: top - card.top, maxHeight, ...(matchAnchorWidth ? { width } : {}) }
      return p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight && p.width === next.width ? p : next
    })
  }, [align, anchor, host, matchAnchorWidth])

  useLayoutEffect(() => {
    place()
    const el = ref.current
    if (!el) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (el!.contains(t) || anchor?.contains(t)) return
      onCloseRef.current()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      onCloseRef.current()
      anchor?.focus()
    }
    // The menu's own scroll is not an outside interaction; an ancestor scroll moves the anchor.
    function onScroll(e: Event) {
      if (el!.contains(e.target as Node)) return
      onCloseRef.current()
    }
    const observer = new ResizeObserver(() => place())
    observer.observe(el)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [anchor, place])

  const node = (
    <div
      ref={ref}
      className={`${className} ws-popover`}
      style={
        host
          ? {
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              maxHeight: pos?.maxHeight,
              width: pos?.width,
              visibility: pos ? 'visible' : 'hidden'
            }
          : undefined
      }
    >
      {children}
    </div>
  )
  return host ? createPortal(node, host) : node
}

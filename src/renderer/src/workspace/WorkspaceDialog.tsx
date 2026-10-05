import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { OverlayHostContext } from './WorkspacePopover'

/**
 * Bounded confirmation inside the workspace card (HF4): a short static title, a body that
 * scrolls and holds the complete target text and consequence, and a footer whose Cancel and
 * confirm buttons always stay visible. Cancel, Escape and a backdrop press never confirm;
 * confirm runs once. Focus starts on Cancel, Tab stays inside, and focus returns afterwards.
 */
export function WorkspaceDialog({
  title,
  confirmLabel,
  onCancel,
  onConfirm,
  returnFocusTo,
  children
}: {
  title: string
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
  /** Used when the element focused at open is gone (e.g. a menu item). */
  returnFocusTo?: HTMLElement | null
  children: ReactNode
}) {
  const host = useContext(OverlayHostContext)
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const confirmed = useRef(false)
  const pressOnScrim = useRef(false)
  const [opener] = useState(() =>
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  )
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
  const returnRef = useRef(returnFocusTo)
  returnRef.current = returnFocusTo

  useEffect(() => {
    cancelRef.current?.focus()
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancelRef.current()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const back = [opener, returnRef.current].find((el) => el?.isConnected)
      back?.focus({ preventScroll: true })
    }
  }, [opener])

  const node = (
    <div
      className="ws-scrim"
      onMouseDown={(e) => {
        pressOnScrim.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressOnScrim.current) onCancel()
      }}
    >
      <div className="delete-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="delete-dialog-title" id={titleId}>
          {title}
        </div>
        <div className="delete-dialog-body" tabIndex={0}>
          {children}
        </div>
        <div className="delete-dialog-actions">
          <button ref={cancelRef} className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              if (confirmed.current) return
              confirmed.current = true
              onConfirm()
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
  return host ? createPortal(node, host) : node
}

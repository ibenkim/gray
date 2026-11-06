export type ToastTone = 'apricot' | 'info' | 'success' | 'error'

type ToastProps = {
  tone?: ToastTone
  title: string
  body?: string
  actionLabel?: string
  onAction?: () => void
  dismissLabel?: string
  onDismiss?: () => void
}

/**
 * Toast above the pill (Figma: revoked-toast) — what changed, the concrete stake, then
 * one primary fix and a quiet Dismiss. The card chrome and its rise-in come from the shell.
 */
export default function Toast({
  tone = 'info',
  title,
  body,
  actionLabel,
  onAction,
  dismissLabel = 'Dismiss',
  onDismiss
}: ToastProps) {
  return (
    <div className={`toast toast-${tone}`} role="status">
      <div className="toast-title">{title}</div>
      {body && <div className="toast-body">{body}</div>}
      {(actionLabel || onDismiss) && (
        <div className="toast-actions">
          {actionLabel && (
            <button className="btn btn-primary" onClick={onAction}>
              {actionLabel}
            </button>
          )}
          {onDismiss && (
            <button className="btn btn-quiet" onClick={onDismiss}>
              {dismissLabel}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

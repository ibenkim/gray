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
 * Shared toast — a paper card that slides in above the pill. First consumer is
 * the permission-revoked notice. The saved confirmation stays a status-pill.
 */
export default function Toast({
  title,
  body,
  actionLabel,
  onAction,
  dismissLabel = 'Dismiss',
  onDismiss
}: ToastProps) {
  return (
    <div className="toast">
      <div className="toast-title type-label">{title}</div>
      {body && <div className="toast-body type-meta">{body}</div>}
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

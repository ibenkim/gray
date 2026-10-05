import { useCallback, useEffect, useState } from 'react'
import type { RecordingSummary, ReviewPreview } from '../../../shared/types'

/** Toast state after Finish. Derived only from what main reported. */
export type RecordingNotice = {
  tone: 'success' | 'info' | 'error'
  title: string
  body: string
  sessionId: string | null
  action: 'review' | 'retrySave' | 'library' | null
  actionLabel?: string
}

type StopLike = {
  ok: boolean
  sessionId?: string | null
  error?: string
  recording?: RecordingSummary
}

export function noticeForStopResult(
  result: StopLike | undefined,
  fallbackSessionId: string | null
): RecordingNotice {
  const r = result?.recording
  const sessionId = result?.sessionId ?? r?.sessionId ?? fallbackSessionId
  if (r?.saveState === 'complete') {
    if (r.reviewState === 'unavailable') {
      return {
        tone: 'info',
        title: 'Recording saved; couldn’t prepare review',
        body: r.reviewMessage ?? 'The recording is saved on this Mac. Nothing has been sent.',
        sessionId,
        action: 'library',
        actionLabel: 'Open in Library'
      }
    }
    return {
      tone: 'success',
      title: 'Recording saved',
      body: 'Saved on this Mac. Nothing has been sent. Review exactly what would be sent before interpreting it.',
      sessionId,
      action: 'review',
      actionLabel: 'Review upload'
    }
  }
  if (!result) {
    return {
      tone: 'error',
      title: 'Couldn’t confirm the recording was saved',
      body: 'The app did not confirm the save. Check the recording in Library.',
      sessionId,
      action: sessionId ? 'library' : null,
      actionLabel: sessionId ? 'Open in Library' : undefined
    }
  }
  return {
    tone: 'error',
    title: 'Recording incomplete',
    body: r?.saveMessage ?? result.error ?? 'The recording could not be saved completely.',
    sessionId,
    action: r?.canRetrySave ? 'retrySave' : sessionId ? 'library' : null,
    actionLabel: r?.canRetrySave ? 'Retry save' : sessionId ? 'Open in Library' : undefined
  }
}

/** One-line Library status. Transfer history is only claimed from approval receipts. */
export function recordingStatusLabel(r: RecordingSummary): string {
  if (r.saveState === 'recording') return 'Recording'
  if (r.saveState === 'saving') return 'Saving…'
  if (r.saveState === 'incomplete') return `Incomplete — ${r.saveMessage ?? 'not fully saved'}`
  switch (r.interpretationState) {
    case 'sending':
      return 'Sending for interpretation…'
    case 'complete':
      return r.partial ? 'Interpreted (partial)' : 'Interpreted'
    case 'failed':
      return 'Interpretation failed'
    case 'interrupted_unknown':
      return 'Interrupted — outcome unknown'
  }
  if (r.reviewState === 'unavailable') return 'Saved · review unavailable'
  return r.saveState === 'legacy_unverified'
    ? 'Saved earlier · completeness unverified'
    : 'Saved · not sent'
}

function formatWhen(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export type UploadReviewViewProps = {
  summary: RecordingSummary | null
  preview: ReviewPreview | null
  error: string | null
  needsAck: boolean
  busy: boolean
  onApprove: () => void
  onSendAgain: () => void
  onKeepLocal: () => void
  onClose: () => void
  onOpenResult: () => void
  onRetrySave: () => void
}

/** Presentational review surface (no IPC) so its states are testable. */
export function UploadReviewView({
  summary,
  preview,
  error,
  needsAck,
  busy,
  onApprove,
  onSendAgain,
  onKeepLocal,
  onClose,
  onOpenResult,
  onRetrySave
}: UploadReviewViewProps) {
  const interp = summary?.interpretationState ?? 'not_started'
  const sending = interp === 'sending'
  const unknownOutcome = interp === 'interrupted_unknown'
  return (
    <div className="ws-view upload-review">
      <div className="ws-header">
        <div>
          <div className="ws-header-title">Review upload</div>
          <div className="ws-header-sub">
            Recording {summary ? formatWhen(summary.startedAt) : ''}
            {summary ? ` · ${recordingStatusLabel(summary)}` : ''}
          </div>
        </div>
        <button className="btn btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="ws-home-body scroll">
        {summary?.saveState === 'legacy_unverified' && (
          <p className="review-warning">
            Saved files found; capture completeness cannot be verified. Any earlier transfer
            of this recording is unknown.
          </p>
        )}
        {summary?.saveState === 'incomplete' && (
          <div className="review-block">
            <p className="review-warning">
              {summary.saveMessage ?? 'This recording is not completely saved.'} It cannot be sent.
            </p>
            {summary.canRetrySave && (
              <button className="btn btn-secondary" onClick={onRetrySave} disabled={busy}>
                Retry save
              </button>
            )}
          </div>
        )}

        {summary && (
          <p className="review-status">
            {summary.screenshotCapture === 'disabled_privacy'
              ? 'Screenshots were disabled for this recording. Interpretation uses the reviewed text.'
              : 'Screenshot capture status is unknown for this recording. Images are excluded from interpretation.'}
          </p>
        )}

        {sending && (
          <p className="review-status">
            Sending for interpretation…
            {summary?.stage ? ` (${summary.stage} request in progress)` : ''}
          </p>
        )}
        {interp === 'complete' && (
          <div className="review-block">
            <p className="review-status">
              Interpreted{summary?.approvedModel ? ` with ${summary.approvedModel}` : ''} after your
              approval{summary?.approvedAt ? ` on ${formatWhen(summary.approvedAt)}` : ''}.
              {summary?.partial ? ' The detailed stage was invalid, so this is a partial result.' : ''}
            </p>
            <button className="btn btn-primary" onClick={onOpenResult}>
              Open interpretation
            </button>
          </div>
        )}
        {(interp === 'failed' || unknownOutcome) && (
          <p className="review-warning">
            {unknownOutcome
              ? 'The app closed while a request was in flight. Its outcome is unknown and it was not resent.'
              : summary?.interpretationMessage ?? 'Interpretation failed.'}{' '}
            The recording and your approval are kept.
          </p>
        )}
        {error && <p className="review-warning">{error}</p>}
        {needsAck && (
          <div className="review-block">
            <p className="review-warning">
              The provider may already have processed the earlier request. Sending again may
              repeat that work.
            </p>
            <button className="btn btn-primary" onClick={onSendAgain} disabled={busy}>
              Send again
            </button>
          </div>
        )}

        {preview && !sending && interp !== 'complete' && (
          <div className="review-block">
            {summary?.approvedAt && summary.approvalCurrent === false && (
              <p className="review-warning">
                Your earlier approval covered a previous version of this review (the interpretation
                format changed). Nothing is sent until you approve this version. The recording does
                not need to be made again.
              </p>
            )}
            <dl className="review-facts">
              <dt>Destination</dt>
              <dd>
                {preview.provider === 'openai' ? 'OpenAI' : preview.provider} · {preview.model}
              </dd>
              <dt>Purpose</dt>
              <dd>{preview.purpose}</dd>
              <dt>Requests</dt>
              <dd>{preview.stages}</dd>
            </dl>
            <div className="section-label">INCLUDED</div>
            <ul className="review-list">
              {preview.categories.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="section-label">NOT INCLUDED</div>
            <ul className="review-list">
              {preview.exclusions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="review-note">
              Redaction rules mask common secrets (keys, emails, tokens, file paths), but cannot
              guarantee every secret is caught. Keep it local if anything below should not be sent.
            </p>
            <details className="review-payload">
              <summary>
                Exact text that will be sent — {preview.actionCount} actions, {preview.bytes} bytes
                {preview.elided ? ', lower-value actions left out' : ''}
              </summary>
              <pre>{preview.payloadText}</pre>
            </details>
            <div className="review-actions">
              <button className="btn btn-quiet" onClick={onKeepLocal} disabled={busy}>
                Keep local
              </button>
              <button className="btn btn-primary" onClick={onApprove} disabled={busy}>
                Approve and send for interpretation
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Review Upload: main prepares the payload; approval binds to its revision + digest. */
export default function UploadReview({
  sessionId,
  onClose,
  onOpenResult
}: {
  sessionId: string
  onClose: () => void
  onOpenResult: (sessionId: string) => void
}) {
  const [summary, setSummary] = useState<RecordingSummary | null>(null)
  const [preview, setPreview] = useState<ReviewPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [needsAck, setNeedsAck] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const bridge = window.ghostBridge
    setError(null)
    const current = await bridge?.telemetryGetRecording?.(sessionId)
    const rec = current?.recording ?? null
    setSummary(rec)
    // An in-flight or finished interpretation is shown as-is; no re-preparation.
    if (rec && (rec.interpretationState === 'sending' || rec.interpretationState === 'complete')) {
      return
    }
    const prepared = await bridge?.telemetryPrepareReview?.(sessionId)
    if (prepared?.recording) setSummary(prepared.recording)
    setPreview(prepared?.ok ? (prepared.preview ?? null) : null)
    if (!prepared?.ok) setError(prepared?.error ?? 'Review is unavailable.')
  }, [sessionId])

  useEffect(() => {
    void load()
    const off = window.ghostBridge?.onRecordingChanged?.((s) => {
      if (s.sessionId === sessionId) setSummary(s)
    })
    return () => off?.()
  }, [load, sessionId])

  async function approve(acknowledgeUnknownOutcome: boolean) {
    if (!preview) return
    setBusy(true)
    setError(null)
    const r = await window.ghostBridge?.telemetryApproveInterpretation?.({
      sessionId,
      revision: preview.revision,
      digest: preview.digest,
      acknowledgeUnknownOutcome
    })
    setBusy(false)
    if (r?.recording) setSummary(r.recording)
    setNeedsAck(r?.errorCode === 'UNKNOWN_OUTCOME_ACK_REQUIRED')
    if (!r?.ok && r?.errorCode !== 'UNKNOWN_OUTCOME_ACK_REQUIRED') {
      setError(r?.error ?? 'Could not start interpretation.')
      if (r?.errorCode === 'REVIEW_STALE') void load()
    }
  }

  async function keepLocal() {
    await window.ghostBridge?.telemetryCancelReview?.(sessionId)
    onClose()
  }

  async function retrySave() {
    setBusy(true)
    const r = await window.ghostBridge?.telemetryRetrySave?.(sessionId)
    setBusy(false)
    if (r?.recording) setSummary(r.recording)
    if (r?.ok) void load()
    else setError(r?.error ?? 'The save could not be retried.')
  }

  return (
    <UploadReviewView
      summary={summary}
      preview={preview}
      error={error}
      needsAck={needsAck}
      busy={busy}
      onApprove={() => void approve(false)}
      onSendAgain={() => void approve(true)}
      onKeepLocal={() => void keepLocal()}
      onClose={onClose}
      onOpenResult={() => onOpenResult(sessionId)}
      onRetrySave={() => void retrySave()}
    />
  )
}

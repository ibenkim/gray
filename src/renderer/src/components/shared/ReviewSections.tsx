import type { Workflow, WorkflowQuestionRef, WorkflowRunContract } from '../../state/types'

/** Plain-language job summary (§9.1). */
export function WorkflowSummary({
  summary,
  goal
}: {
  summary?: string
  goal?: string
}) {
  if (!summary && !goal) return null
  return (
    <div className="review-summary">
      {summary && <p className="review-summary-text">{summary}</p>}
      {goal && goal !== summary && <p className="review-goal">{goal}</p>}
    </div>
  )
}

/** Dedicated list of all interpretation questions (§9.3). */
export function QuestionsSection({ questions }: { questions?: WorkflowQuestionRef[] }) {
  if (!questions?.length) return null
  return (
    <div className="ledger-section">
      <div className="section-label">QUESTIONS</div>
      <ul className="review-questions">
        {questions.map((q) => (
          <li key={q.id} className="review-question">
            {q.prompt}
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatAuthLevel(level?: string): string {
  if (!level) return 'unspecified'
  return level.replace(/_/g, ' ')
}

function formatExpiry(expires?: string | null): string {
  if (!expires) return 'until you revoke it'
  try {
    const d = new Date(expires)
    if (Number.isNaN(d.getTime())) return expires
    return d.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  } catch {
    return expires
  }
}

/** Whether this workflow should gate Run behind a contract confirm. */
export function needsRunContract(workflow: Workflow): boolean {
  return Boolean(workflow.sessionId && workflow.runContract && !workflow.contractAccepted)
}

/**
 * Local redaction preview before anything leaves the machine (capture-spec §5).
 * Surfaces what Gray kept vs masked for the recorded session.
 */
export function RedactionPreview({
  sessionId,
  notes
}: {
  sessionId?: string
  notes?: string[]
}) {
  if (!sessionId) return null
  const items =
    notes && notes.length
      ? notes
      : [
          'Secure fields were recorded as events without values.',
          'Clipboard secrets and credential-bearing URLs were rejected.',
          'Typed text was scanned for emails, tokens, and long numbers.'
        ]
  return (
    <div className="ledger-section redaction-preview">
      <div className="section-label">REDACTION</div>
      <p className="review-summary-text">
        Nothing leaves this Mac until you continue. Review what was masked in this
        session.
      </p>
      <ul className="review-questions">
        {items.map((n) => (
          <li key={n} className="review-question">
            {n}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Lightweight pre-run authorization panel (§9.4). */
export function RunContractPanel({
  contract,
  onConfirm,
  onCancel
}: {
  contract: WorkflowRunContract
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="run-contract" role="region" aria-label="Run contract">
      <div className="run-contract-title">Before Gray runs</div>
      <p className="run-contract-lead">
        Confirm what this workflow may use and change on this Mac.
      </p>
      <dl className="run-contract-list">
        {contract.inputs.length > 0 && (
          <>
            <dt>Inputs</dt>
            <dd>{contract.inputs.join(', ')}</dd>
          </>
        )}
        {contract.writes.length > 0 && (
          <>
            <dt>Writes</dt>
            <dd>{contract.writes.join(', ')}</dd>
          </>
        )}
        {contract.commits.length > 0 && (
          <>
            <dt>Commit steps</dt>
            <dd>{contract.commits.join(', ')}</dd>
          </>
        )}
        {contract.destinations.length > 0 && (
          <>
            <dt>Destinations</dt>
            <dd>{contract.destinations.join(', ')}</dd>
          </>
        )}
        <dt>Authorization</dt>
        <dd>
          {formatAuthLevel(contract.authorizationLevel)} · expires{' '}
          {formatExpiry(contract.authorizationExpires)}
        </dd>
      </dl>
      <div className="run-contract-actions">
        <button className="btn btn-quiet" type="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" type="button" onClick={onConfirm}>
          Confirm
        </button>
      </div>
    </div>
  )
}

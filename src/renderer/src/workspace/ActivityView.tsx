import { formatWaitingSince } from '../../../shared/runFormat'
import type { ActivityEntry } from '../state/types'
import { ChevronRight } from './WorkflowsHome'

const GROUPS: { key: ActivityEntry['group']; label: string }[] = [
  { key: 'coming-up', label: 'Coming up' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' }
]

/**
 * Activity (Figma: workspace/activity): COMING UP from the schedule model, TODAY / YESTERDAY
 * from persisted runs, plus live holds mirrored from the pill ("Action Required").
 */
export default function ActivityView({
  entries,
  onOpenWorkflow,
  onOpenRun,
  onSkip,
  onAnswerHold
}: {
  entries: ActivityEntry[]
  onOpenWorkflow: (workflowId: string) => void
  onOpenRun: (workflowId: string, runId: string) => void
  onSkip: (entryId: string) => void
  onAnswerHold: () => void
}) {
  const scheduledCount = new Set(
    entries.filter((e) => e.kind === 'scheduled' && !e.skipped).map((e) => e.workflowId)
  ).size
  let row = 0

  return (
    <div className="ws-view">
      <div className="ws-header">
        <div>
          <div className="ws-header-title">Activity</div>
          <div className="ws-header-sub">
            {scheduledCount} active automation{scheduledCount === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      <div className="ws-home-body scroll">
        {entries.length === 0 && <div className="log-empty">Runs will show up here</div>}
        <div className="activity-groups">
          {GROUPS.map((group) => {
            const rows = entries.filter((e) => e.group === group.key)
            if (rows.length === 0) return null
            return (
              <div className="activity-group" key={group.key}>
                <div className="manage-section-label">{group.label}</div>
                <div className="ws-rows">
                  {rows.map((entry, i) => (
                    <ActivityRow
                      key={entry.id}
                      index={row++}
                      first={group.key === 'coming-up' && i === 0}
                      entry={entry}
                      onOpen={() => {
                        if (entry.kind === 'run' && entry.runId && entry.outcome === 'done') {
                          onOpenRun(entry.workflowId, entry.runId)
                        } else if (entry.needsYou || entry.outcome === 'paused') {
                          onAnswerHold()
                        } else {
                          onOpenWorkflow(entry.workflowId)
                        }
                      }}
                      onSkip={() => onSkip(entry.id)}
                      onAnswer={onAnswerHold}
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function ActivityRow({
  index,
  first,
  entry,
  onOpen,
  onSkip,
  onAnswer
}: {
  index: number
  first: boolean
  entry: ActivityEntry
  onOpen: () => void
  onSkip: () => void
  onAnswer: () => void
}) {
  const isScheduled = entry.kind === 'scheduled'
  const needsAnswer = entry.needsYou === 'answer'
  const needsHelp = entry.needsYou === 'help'
  const stoppedHelp = Boolean(entry.stopReason) && entry.outcome === 'stopped'
  const style = { ['--i' as string]: index }

  if (needsAnswer || needsHelp) {
    const since = formatWaitingSince(entry.waitingSince)
    return (
      <div
        className={`ws-row activity-row ${needsHelp ? 'activity-row-help' : 'activity-row-needs'}`}
        style={style}
        onClick={onOpen}
        title={
          needsHelp
            ? `Needs help${entry.heldStepIndex ? ` at step ${entry.heldStepIndex}` : ''}`
            : `Waiting on your answer since ${since}`
        }
      >
        <span className="ws-row-name">
          <span>{entry.name}</span>
          <span className="ws-row-schedule">{needsHelp ? 'needs help' : `waiting since ${since}`}</span>
        </span>
        <span className="ws-row-right">
          <button
            className={`status-chip ${needsHelp ? 'status-chip-help' : 'status-chip-answer'}`}
            onClick={(e) => {
              e.stopPropagation()
              onAnswer()
            }}
          >
            {needsHelp ? 'Needs help' : 'Action Required'}
          </button>
          <ChevronRight />
        </span>
      </div>
    )
  }

  if (stoppedHelp) {
    return (
      <div className="ws-row activity-row activity-row-help" style={style} onClick={onOpen}>
        <span className="ws-row-name">
          <span>{entry.name}</span>
          <span className="ws-row-schedule">{entry.stopReason}</span>
        </span>
        <span className="ws-row-right">
          <span className="status-word status-plain">Stopped</span>
          <ChevronRight />
        </span>
      </div>
    )
  }

  const past = entry.kind === 'run'

  return (
    <div
      className={`ws-row activity-row ${first && !entry.skipped ? 'activity-row-first' : ''} ${
        entry.skipped ? 'activity-row-skipped' : ''
      }`}
      style={style}
      onClick={onOpen}
    >
      <span className={`ws-row-name ${entry.skipped || past ? 'ws-row-name-off' : ''}`}>
        <span>{entry.name}</span>
        <span className="ws-row-schedule">{entry.timeLabel}</span>
      </span>
      <span className="ws-row-right">
        {isScheduled ? (
          entry.skipped ? (
            <span className="status-word status-plain">Skipped</span>
          ) : (
            <>
              <span className="status-chip">Scheduled</span>
              <button
                className="skip-link"
                onClick={(e) => {
                  e.stopPropagation()
                  onSkip()
                }}
              >
                Skip
              </button>
            </>
          )
        ) : entry.outcome === 'paused' ? (
          <button
            className="status-chip status-chip-paused"
            onClick={(e) => {
              e.stopPropagation()
              onAnswer()
            }}
          >
            Paused
          </button>
        ) : (
          <span className="status-word status-plain">{entry.outcome === 'stopped' ? 'Stopped' : 'Done'}</span>
        )}
        <ChevronRight />
      </span>
    </div>
  )
}

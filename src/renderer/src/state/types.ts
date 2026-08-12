/**
 * Renderer state types. Domain entities live in `src/shared/types` so the
 * main-process store and both windows share one model.
 */

export type AppState =
  | 'idle'
  | 'hover'
  | 'recording'
  | 'organizing'
  | 'editor'
  | 'running'
  | 'summary'

export type RecordableApp = {
  id: string
  name: string
  detail: string
}

export type {
  ActivityEntry,
  EditorStep,
  FixOption,
  FixStep,
  OnboardingStep,
  PermissionId,
  PermissionsState,
  PermissionStatus,
  QuestionReceipt,
  RecordMode,
  RecordSettings,
  Run,
  RunError,
  RunOutcome,
  RunQuestion,
  RunStep,
  RunStepResult,
  RunStepStatus,
  ScheduleCadence,
  Invite,
  Member,
  Session,
  StepApp,
  Team,
  TeamRole,
  StepPhase,
  StoreSnapshot,
  Suggestion,
  SummaryOutcome,
  TimeOfDay,
  Trigger,
  VoiceNote,
  Weekday,
  Workflow,
  WorkflowQuestionRef,
  WorkflowRunContract,
  WorkflowScope,
  WorkflowStatus,
  WorkspaceFocus
} from '../../../shared/types'

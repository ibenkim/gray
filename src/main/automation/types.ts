import type {
  AutomationOp,
  IntentVerb,
  RunFailureCode,
  RunMode,
  WaitForCondition
} from '../../shared/telemetry/schema'

export type { RunFailureCode, RunMode }

export type ActuatorResult = {
  ok: boolean
  error?: string
  matched?: string
  matchedLabel?: string
  matchedRole?: string
  /** Optional field value from readback. */
  value?: string
}

export type QueryParams = {
  waitCondition: WaitForCondition
  waitValue?: string | null
  appName?: string | null
  appBundleId?: string | null
  elementRole?: string | null
  elementLabel?: string | null
}

/** Platform actuation surface — JXA in prod, fake in tests. */
export interface Actuator {
  start(): Promise<void>
  stop(): void
  activateApp(appName: string | null, appBundleId: string | null): Promise<ActuatorResult>
  openUrl(url: string, appName?: string | null): Promise<ActuatorResult>
  pressElement(params: {
    appName: string | null
    appBundleId: string | null
    elementRole: string | null
    elementLabel: string
    elementPath?: string[] | null
  }): Promise<ActuatorResult>
  keystroke(chord: string): Promise<ActuatorResult>
  query(params: QueryParams): Promise<ActuatorResult>
  typeText?(text: string): Promise<ActuatorResult>
  setClipboard?(text: string): ActuatorResult
  clickAt?(x: number, y: number, button?: 'left' | 'right'): Promise<ActuatorResult>
  /** Optional readback — stub may always return ok. */
  readField?(params: QueryParams): Promise<ActuatorResult>
}

export type ResolutionStats = {
  /** open_url successes */
  tier1: number
  /** open_app / activate_element successes */
  tier2: number
}

export type RunEvent =
  | {
      type: 'stepStarted'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      op: AutomationOp['op']
    }
  | {
      type: 'stepDone'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      /** True when the op was skipped as a no-op under simulated mode. */
      simulated?: boolean
    }
  | {
      type: 'stepFailed'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      message: string
      /** Typed failure code for repair / UI. */
      code?: RunFailureCode
      /** True when the op is `manual` (expected take-over). */
      manual?: boolean
    }
  | {
      type: 'question'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      prompt: string
      variableKey: string | null
    }
  | {
      type: 'navigating'
      runId: string
      stepOrder: number
      opIndex: number
      /** Destination shown in the pill (app name or URL host). */
      destination: string
    }
  | {
      type: 'finished'
      runId: string
      outcome: 'done' | 'stopped'
      resolution?: ResolutionStats
    }

export type RunnerControl =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'retry' }
  | { kind: 'skip' }
  | { kind: 'takeOver' }
  | { kind: 'answer'; value: string; variableKey?: string | null }

/** Optional per-step intent metadata from the extracted workflow. */
export type StepMeta = {
  order: number
  intent?: IntentVerb | null
  authorization?: string | null
  summary?: string | null
}

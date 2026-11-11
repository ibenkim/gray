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
  /** Window frame from windowBounds query. */
  bounds?: { x: number; y: number; width: number; height: number }
}

export type QueryParams = {
  waitCondition: WaitForCondition
  waitValue?: string | null
  appName?: string | null
  appBundleId?: string | null
  elementRole?: string | null
  elementLabel?: string | null
}

export type ClickAtOptions = {
  button?: 'left' | 'right'
  count?: number
  modifiers?: {
    cmd?: boolean
    opt?: boolean
    ctrl?: boolean
    shift?: boolean
  }
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
    windowTitle?: string | null
  }): Promise<ActuatorResult>
  keystroke(chord: string): Promise<ActuatorResult>
  query(params: QueryParams): Promise<ActuatorResult>
  typeText?(text: string): Promise<ActuatorResult>
  setClipboard?(text: string): ActuatorResult
  clickAt?(
    x: number,
    y: number,
    options?: ClickAtOptions
  ): Promise<ActuatorResult>
  scrollAt?(
    x: number,
    y: number,
    axis: 'vertical' | 'horizontal',
    delta: number
  ): Promise<ActuatorResult>
  windowBounds?(
    appName: string | null,
    appBundleId: string | null,
    windowTitle?: string | null
  ): Promise<ActuatorResult>
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
      /** True when the op was not run under simulated mode. */
      simulated?: boolean
      /** True when the user skipped the op; it did not run. */
      skipped?: boolean
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
      /** `incomplete`: reached the end, but a step was skipped or not run. */
      outcome: 'done' | 'incomplete' | 'stopped'
      resolution?: ResolutionStats
    }

export type RunnerControl =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'retry' }
  | { kind: 'skip' }
  | { kind: 'takeOver' }
  | { kind: 'approve' }
  | { kind: 'answer'; value: string; variableKey?: string | null }

/** Optional per-step intent metadata from the extracted workflow. */
export type StepMeta = {
  order: number
  intent?: IntentVerb | null
  authorization?: string | null
  summary?: string | null
}

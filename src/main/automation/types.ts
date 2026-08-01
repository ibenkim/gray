import type { AutomationOp, WaitForCondition } from '../../shared/telemetry/schema'

export type ActuatorResult = {
  ok: boolean
  error?: string
  matched?: string
  matchedLabel?: string
  matchedRole?: string
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
    }
  | {
      type: 'stepFailed'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      message: string
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
      type: 'finished'
      runId: string
      outcome: 'done' | 'stopped'
    }

export type RunnerControl =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'retry' }
  | { kind: 'skip' }
  | { kind: 'takeOver' }
  | { kind: 'answer'; value: string; variableKey?: string | null }

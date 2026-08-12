import type { IntentVerb, PositionStrategy } from '../../../shared/telemetry/schema'

export type GroundTruthStep = {
  intent: IntentVerb | string
  summary: string
  /** Optional — used for positionAccuracy when present (JSON ground truth). */
  position?: { strategy: PositionStrategy | string } | null
}

export type GroundTruth = {
  steps: GroundTruthStep[]
  variables: string[]
  branches: string[]
  questions: string[]
}

export type StepAccuracyByVerb = Partial<Record<IntentVerb, number | null>>

export type InterpretationMetrics = {
  /** Per IntentVerb: fraction of GT steps with that intent matched at the same index. */
  stepAccuracy: StepAccuracyByVerb
  /** Overall index-aligned intent match rate. */
  overallStepAccuracy: number | null
  variableRecall: number | null
  branchRecall: number | null
  /** Among GT steps that declare position.strategy, fraction matching predicted strategy. */
  positionAccuracy: number | null
  questionPrecision: number | null
  questionRecall: number | null
}

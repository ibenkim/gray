import {
  IntentVerbSchema,
  type ExtractedWorkflow,
  type IntentVerb
} from '../../../shared/telemetry/schema'
import type { GroundTruth, InterpretationMetrics, StepAccuracyByVerb } from './types'

const INTENTS = IntentVerbSchema.options as IntentVerb[]

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w.\s>→-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function softMatch(a: string, b: string): boolean {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}

function predictedVariables(workflow: ExtractedWorkflow): string[] {
  const keys = new Set<string>()
  for (const v of workflow.variables ?? []) {
    if (v.key) keys.add(v.key)
  }
  for (const step of workflow.steps) {
    if (step.inputVariableKey) keys.add(step.inputVariableKey)
  }
  return [...keys]
}

function predictedBranches(workflow: ExtractedWorkflow): string[] {
  return (workflow.branches ?? []).map((b) => b.condition)
}

function predictedQuestions(workflow: ExtractedWorkflow): string[] {
  return (workflow.questions ?? []).map((q) => q.prompt)
}

function recall(predicted: string[], expected: string[]): number | null {
  if (expected.length === 0) return null
  let hit = 0
  for (const e of expected) {
    if (predicted.some((p) => softMatch(p, e))) hit += 1
  }
  return hit / expected.length
}

function precision(predicted: string[], expected: string[]): number | null {
  if (predicted.length === 0) return expected.length === 0 ? null : 0
  let hit = 0
  for (const p of predicted) {
    if (expected.some((e) => softMatch(p, e))) hit += 1
  }
  return hit / predicted.length
}

/**
 * Compare an extracted workflow against ground truth.
 * Step accuracy is index-aligned and reported per IntentVerb.
 */
export function compareWorkflowToGroundTruth(
  workflow: ExtractedWorkflow,
  groundTruth: GroundTruth
): InterpretationMetrics {
  const predSteps = workflow.steps
  const gtSteps = groundTruth.steps
  const n = Math.min(predSteps.length, gtSteps.length)

  const stepAccuracy: StepAccuracyByVerb = {}
  for (const verb of INTENTS) {
    let denom = 0
    let hit = 0
    for (let i = 0; i < gtSteps.length; i++) {
      if (gtSteps[i]!.intent !== verb) continue
      denom += 1
      const pred = predSteps[i]
      if (pred && pred.intent === verb) hit += 1
    }
    stepAccuracy[verb] = denom === 0 ? null : hit / denom
  }

  let overallHit = 0
  for (let i = 0; i < n; i++) {
    const gtIntent = gtSteps[i]!.intent
    const predIntent = predSteps[i]?.intent
    if (gtIntent && predIntent && gtIntent === predIntent) overallHit += 1
  }
  const overallStepAccuracy =
    gtSteps.length === 0 && predSteps.length === 0
      ? null
      : gtSteps.length === 0
        ? 0
        : overallHit / gtSteps.length

  let posDenom = 0
  let posHit = 0
  for (let i = 0; i < gtSteps.length; i++) {
    const gtPos = gtSteps[i]?.position?.strategy
    if (!gtPos) continue
    posDenom += 1
    const predPos = predSteps[i]?.position?.strategy
    if (predPos && String(predPos) === String(gtPos)) posHit += 1
  }
  const positionAccuracy = posDenom === 0 ? null : posHit / posDenom

  const predVars = predictedVariables(workflow)
  const predBranches = predictedBranches(workflow)
  const predQuestions = predictedQuestions(workflow)

  return {
    stepAccuracy,
    overallStepAccuracy,
    variableRecall: recall(predVars, groundTruth.variables),
    branchRecall: recall(predBranches, groundTruth.branches),
    positionAccuracy,
    questionPrecision: precision(predQuestions, groundTruth.questions),
    questionRecall: recall(predQuestions, groundTruth.questions)
  }
}

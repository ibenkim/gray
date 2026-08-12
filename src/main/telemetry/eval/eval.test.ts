import { describe, expect, it } from 'vitest'
import {
  withWorkflowStepDefaults,
  type ExtractedWorkflow
} from '../../../shared/telemetry/schema'
import { compareWorkflowToGroundTruth } from './compare'
import { parseGroundTruth } from './parseGroundTruth'
import { aggregateRunMetrics } from './runMetrics'

const SAMPLE_MD = `# Ground truth
## Steps
1. Locate — Find the invoice email
2. Read — Extract vendor and amount
## Variables
- invoice.vendor
- invoice.amount
## Branches
- amount > 500 → Maria
## Questions
- What happens when amount is under 500?
`

function step(
  partial: {
    order: number
    action: string
    intent?: ExtractedWorkflow['steps'][number]['intent']
    summary?: string | null
    inputVariableKey?: string | null
    position?: ExtractedWorkflow['steps'][number]['position']
  }
): ExtractedWorkflow['steps'][number] {
  return withWorkflowStepDefaults({
    order: partial.order,
    action: partial.action,
    category: 'interaction',
    appName: 'Mail',
    evidenceEventIds: [`tevt_${partial.order}`],
    confidence: 0.9,
    intent: partial.intent ?? null,
    summary: partial.summary ?? null,
    inputVariableKey: partial.inputVariableKey ?? null,
    position: partial.position ?? null
  })
}

describe('parseGroundTruth', () => {
  it('parses the markdown fixture format', () => {
    const gt = parseGroundTruth(SAMPLE_MD)
    expect(gt.steps).toEqual([
      { intent: 'Locate', summary: 'Find the invoice email' },
      { intent: 'Read', summary: 'Extract vendor and amount' }
    ])
    expect(gt.variables).toEqual(['invoice.vendor', 'invoice.amount'])
    expect(gt.branches).toEqual(['amount > 500 → Maria'])
    expect(gt.questions).toEqual(['What happens when amount is under 500?'])
  })

  it('parses JSON ground truth', () => {
    const gt = parseGroundTruth(
      JSON.stringify({
        steps: [
          { intent: 'Fill', summary: 'Type amount', position: { strategy: 'first_empty_row' } }
        ],
        variables: ['invoice.amount'],
        branches: [],
        questions: ['Which column?']
      })
    )
    expect(gt.steps[0]?.intent).toBe('Fill')
    expect(gt.steps[0]?.position?.strategy).toBe('first_empty_row')
    expect(gt.variables).toEqual(['invoice.amount'])
    expect(gt.questions).toHaveLength(1)
  })
})

describe('compareWorkflowToGroundTruth', () => {
  const groundTruth = parseGroundTruth(SAMPLE_MD)

  it('scores step accuracy per IntentVerb and recalls', () => {
    const workflow: ExtractedWorkflow = {
      title: 'Invoice',
      goal: null,
      summary: 'Process invoice',
      outcome: 'completed',
      steps: [
        step({
          order: 1,
          action: 'Find invoice',
          intent: 'Locate',
          summary: 'Find the invoice email'
        }),
        step({
          order: 2,
          action: 'Extract fields',
          intent: 'Read',
          summary: 'Extract vendor and amount',
          inputVariableKey: 'invoice.vendor'
        })
      ],
      warnings: [],
      variables: [
        {
          key: 'invoice.vendor',
          label: 'Vendor',
          kind: 'text',
          exampleSanitized: 'Acme'
        },
        {
          key: 'invoice.amount',
          label: 'Amount',
          kind: 'text',
          exampleSanitized: '120'
        }
      ],
      addresses: null,
      commits: null,
      writes: null,
      inputs: null,
      authorizationScope: null,
      branches: [
        {
          id: 'b1',
          atStepId: 's2',
          condition: 'amount > 500 → Maria',
          source: 'narration',
          confidence: 0.8
        }
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'What happens when amount is under 500?',
          relatedStepId: null,
          kind: 'branch'
        }
      ]
    }

    const m = compareWorkflowToGroundTruth(workflow, groundTruth)
    expect(m.stepAccuracy.Locate).toBe(1)
    expect(m.stepAccuracy.Read).toBe(1)
    expect(m.stepAccuracy.Fill).toBeNull()
    expect(m.overallStepAccuracy).toBe(1)
    expect(m.variableRecall).toBe(1)
    expect(m.branchRecall).toBe(1)
    expect(m.questionPrecision).toBe(1)
    expect(m.questionRecall).toBe(1)
  })

  it('penalizes mismatched intents and missing variables', () => {
    const workflow: ExtractedWorkflow = {
      title: 'Invoice',
      goal: null,
      summary: 'Wrong',
      outcome: 'partial',
      steps: [
        step({ order: 1, action: 'Click', intent: 'Fill', summary: 'wrong' }),
        step({ order: 2, action: 'Type', intent: 'Fill', summary: 'wrong' })
      ],
      warnings: [],
      variables: null,
      addresses: null,
      commits: null,
      writes: null,
      inputs: null,
      authorizationScope: null,
      branches: null,
      questions: [{ id: 'q1', prompt: 'Unrelated?', relatedStepId: null, kind: 'other' }]
    }

    const m = compareWorkflowToGroundTruth(workflow, groundTruth)
    expect(m.stepAccuracy.Locate).toBe(0)
    expect(m.stepAccuracy.Read).toBe(0)
    expect(m.variableRecall).toBe(0)
    expect(m.branchRecall).toBe(0)
    expect(m.questionPrecision).toBe(0)
    expect(m.questionRecall).toBe(0)
  })

  it('computes positionAccuracy when strategy is present', () => {
    const gt = parseGroundTruth(
      JSON.stringify({
        steps: [
          {
            intent: 'Fill',
            summary: 'Enter amount',
            position: { strategy: 'first_empty_row' }
          }
        ],
        variables: [],
        branches: [],
        questions: []
      })
    )
    const good: ExtractedWorkflow = {
      title: 'Sheet',
      goal: null,
      summary: 'Fill',
      outcome: 'completed',
      steps: [
        step({
          order: 1,
          action: 'Fill amount',
          intent: 'Fill',
          position: { strategy: 'first_empty_row', column: 'B', matchValue: null }
        })
      ],
      warnings: [],
      variables: null,
      addresses: null,
      commits: null,
      writes: null,
      inputs: null,
      authorizationScope: null,
      branches: null,
      questions: null
    }
    expect(compareWorkflowToGroundTruth(good, gt).positionAccuracy).toBe(1)

    const bad: ExtractedWorkflow = {
      ...good,
      steps: [
        step({
          order: 1,
          action: 'Fill amount',
          intent: 'Fill',
          position: { strategy: 'absolute', column: null, matchValue: null }
        })
      ]
    }
    expect(compareWorkflowToGroundTruth(bad, gt).positionAccuracy).toBe(0)
  })
})

describe('aggregateRunMetrics', () => {
  it('aggregates success, tiers, repair, failures, and address health', () => {
    const metrics = aggregateRunMetrics([
      {
        success: true,
        resolution: { tier1: 2, tier2: 1 },
        repairAttempts: 0,
        addresses: [
          {
            id: 'addr_sheet',
            health: { attempts: 2, successes: 2, lastOk: '2026-08-12T12:00:00.000Z' }
          }
        ]
      },
      {
        success: false,
        resolution: { tier1: 0, tier2: 1 },
        repaired: true,
        failureCode: 'target_not_found',
        addresses: [
          {
            id: 'addr_sheet',
            health: { attempts: 1, successes: 0, lastOk: null }
          }
        ]
      },
      {
        success: true,
        resolution: { tier1: 1, tier2: 0 },
        repairAttempts: 1,
        failureCode: null
      }
    ])

    expect(metrics.successRate).toBeCloseTo(2 / 3)
    expect(metrics.tierDistribution).toEqual({ tier1: 3, tier2: 2, total: 5 })
    expect(metrics.repairRate).toBeCloseTo(2 / 3)
    expect(metrics.failureDistribution).toEqual({ target_not_found: 1 })
    expect(metrics.addressHealth.addr_sheet?.attempts).toBe(3)
    expect(metrics.addressHealth.addr_sheet?.successes).toBe(2)
    expect(metrics.addressHealth.addr_sheet?.successRate).toBeCloseTo(2 / 3)
  })

  it('returns null rates for an empty batch', () => {
    const metrics = aggregateRunMetrics([])
    expect(metrics.successRate).toBeNull()
    expect(metrics.repairRate).toBeNull()
    expect(metrics.tierDistribution.total).toBe(0)
  })
})

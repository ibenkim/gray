import { describe, expect, it, vi } from 'vitest'
import {
  SCHEMA_VERSION,
  withWorkflowStepDefaults,
  type AutomationOp,
  type ExtractedWorkflow,
  type PolishedSession
} from '../../../shared/telemetry/schema'
import { InMemoryTelemetryStore } from '../store/InMemoryTelemetryStore'
import {
  applyEditorIntentToOps,
  collapseRedundantBrowserNav,
  compileAutomationScript,
  ensureBrowserNewTab,
  injectClickOpsFromEvidence,
  injectScrollOpsFromEvidence,
  injectTypeTextOpsFromEvidence,
  injectKeystrokeOpsFromEvidence,
  injectWaitOpsFromStepSemantics,
  isCreateSheetIntent,
  ensureCreateRenameFromEvidence,
  hoistCreateSheetBeforeMisplacedWaits,
  orderCreateSheetSequences,
  polishedImpliesCreateSheet,
  preferAddressNavigation,
  preferClickAtWhenGrounded,
  recoverInferredActions,
  renameNameFromPolishedTitleChange,
  rewriteCreateSheetClicks,
  validateAndGroundScript
} from './compile'

function wfStep(
  step: {
    order: number
    action: string
    category: ExtractedWorkflow['steps'][number]['category']
    appName: string | null
    evidenceEventIds: string[]
    confidence: number
  } & Partial<ExtractedWorkflow['steps'][number]>
): ExtractedWorkflow['steps'][number] {
  return withWorkflowStepDefaults(step)
}

const polished: PolishedSession = {
  sessionId: 'tsess_auto',
  schemaVersion: SCHEMA_VERSION,
  polishedAt: '2026-07-29T04:28:48.452Z',
  sequenceRange: { min: 0, max: 4 },
  actions: [
    {
      order: 1,
      text: 'Opened Messages',
      category: 'navigation',
      timestamp: '2026-07-29T04:28:46.548Z',
      sourceEventIds: ['tevt_nav'],
      appName: 'Messages'
    },
    {
      order: 2,
      text: 'Clicked Send',
      category: 'interaction',
      timestamp: '2026-07-29T04:28:47.000Z',
      sourceEventIds: ['tevt_click'],
      appName: 'Messages',
      elementLabel: 'Send',
      elementRole: 'AXButton'
    }
  ]
}

const workflow: ExtractedWorkflow = {
  title: 'Send a message',
  goal: null,
  summary: 'Open Messages and send.',
  outcome: 'completed',
  steps: [
    wfStep({
      order: 1,
      action: 'Open Messages',
      category: 'navigation',
      appName: 'Messages',
      evidenceEventIds: ['tevt_nav'],
      confidence: 0.9
    }),
    wfStep({
      order: 2,
      action: 'Click Send',
      category: 'interaction',
      appName: 'Messages',
      evidenceEventIds: ['tevt_click'],
      confidence: 0.85
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

describe('preferAddressNavigation', () => {
  it('emits open_url from address template instead of click paths', () => {
    const warnings: string[] = []
    const wf: ExtractedWorkflow = {
      ...workflow,
      addresses: [
        {
          id: 'addr_1',
          kind: 'url',
          template: 'https://docs.google.com/spreadsheets/d/{sheet_id}/edit',
          params: [{ key: 'sheet_id', value: 'SHEET123' }],
          identityAccount: null,
          identityProvider: 'google',
          stability: 'medium',
          verify: {
            urlMatches: 'https://docs.google.com/spreadsheets/d/*/edit',
            elementPresent: { text: 'Invoices', role: null },
            accountIndicator: null
          },
          fallback: null,
          health: null,
          policy: 'auto',
          needsReview: null
        }
      ],
      steps: [
        wfStep({
          order: 1,
          id: 'step_1',
          intent: 'Locate',
          summary: 'Open invoice sheet',
          action: 'Open the invoice spreadsheet',
          category: 'navigation',
          appName: 'Google Chrome',
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.9,
          requires: [
            {
              ref: 'addr_1',
              account: null,
              noModal: null,
              policy: 'auto',
              description: 'Invoice sheet'
            }
          ]
        })
      ]
    }
    const ops = preferAddressNavigation(
      [
        {
          op: 'click_at',
          stepOrder: 1,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.6,
          timeoutMs: 10_000,
          label: 'Click Drive folder',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: 100,
          clickY: 200
        }
      ],
      wf,
      warnings
    )
    expect(ops[0]?.op).toBe('open_url')
    expect(ops[0]?.url).toBe('https://docs.google.com/spreadsheets/d/SHEET123/edit')
    expect(warnings.some((w) => /Address addr_1/.test(w))).toBe(true)
  })
})

describe('injectWaitOpsFromStepSemantics', () => {
  it('injects wait_for from completionCheck when missing', () => {
    const warnings: string[] = []
    const wf: ExtractedWorkflow = {
      ...workflow,
      steps: [
        wfStep({
          order: 1,
          action: 'Open Messages',
          category: 'navigation',
          appName: 'Messages',
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.9,
          completionCheck: 'Messages is frontmost',
          expectedChange: 'App ready'
        })
      ]
    }
    const ops = injectWaitOpsFromStepSemantics(
      [
        {
          op: 'open_app',
          stepOrder: 1,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.9,
          timeoutMs: 10_000,
          label: 'Open Messages',
          appName: 'Messages',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      wf,
      polished,
      warnings
    )
    expect(ops.some((o) => o.op === 'wait_for' && o.waitCondition === 'app_frontmost')).toBe(true)
    expect(warnings.some((w) => /Injected wait_for/.test(w))).toBe(true)
  })

  it('injects wait_for from polished waitedMs', () => {
    const warnings: string[] = []
    const waitedPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          ...polished.actions[0],
          waitedMs: 12_000
        }
      ]
    }
    const ops = injectWaitOpsFromStepSemantics(
      [
        {
          op: 'open_app',
          stepOrder: 1,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.9,
          timeoutMs: 10_000,
          label: 'Open Messages',
          appName: 'Messages',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      {
        ...workflow,
        steps: [workflow.steps[0]]
      },
      waitedPolished,
      warnings
    )
    expect(ops.some((o) => o.op === 'wait_for')).toBe(true)
  })
})

describe('recoverInferredActions', () => {
  it('turns Google Drive manual into open_url', () => {
    const warnings: string[] = []
    const ops = recoverInferredActions(
      [
        {
          op: 'manual',
          stepOrder: 1,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.5,
          timeoutMs: 10000,
          label: 'Navigate to Google Drive',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: 'Could not ground navigation',
          clickX: null,
          clickY: null
        }
      ],
      {
        ...workflow,
        steps: [
          {
            order: 1,
            action: 'Open a new Chrome tab and navigate to Google Drive.',
            category: 'navigation',
            appName: 'Google Chrome',
            evidenceEventIds: ['tevt_nav'],
            confidence: 0.9
          }
        ]
      },
      polished,
      warnings
    )
    expect(ops[0]?.op).toBe('open_url')
    expect(ops[0]?.url).toBe('https://drive.google.com/')
    expect(warnings.some((w) => /Inferred open_url/i.test(w))).toBe(true)
  })

  it('rewrites Drive homepage open_url into create-doc when step says create', () => {
    const warnings: string[] = []
    const ops = recoverInferredActions(
      [
        {
          op: 'open_url',
          stepOrder: 2,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.8,
          timeoutMs: 10000,
          label: 'Open Google Drive',
          appName: 'Google Chrome',
          appBundleId: null,
          url: 'https://drive.google.com/',
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      {
        ...workflow,
        steps: [
          workflow.steps[0]!,
          {
            order: 2,
            action: 'Navigate to Google Drive and Create a new Google Docs document titling "Untitled"',
            category: 'navigation',
            appName: 'Google Chrome',
            evidenceEventIds: ['tevt_nav'],
            confidence: 0.9
          }
        ]
      },
      polished,
      warnings
    )
    expect(ops[0]?.op).toBe('open_url')
    expect(ops[0]?.url).toBe('https://docs.google.com/document/create')
  })

  it('rewrites open-document ops into click+rename when step says rename', () => {
    const warnings: string[] = []
    const renamePolished: PolishedSession = {
      ...polished,
      actions: [
        ...polished.actions,
        {
          order: 3,
          text: 'Clicked document title',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:48.000Z',
          sourceEventIds: ['tevt_title'],
          appName: 'Google Chrome',
          documentTitle: 'Untitled document - Google Docs',
          clickX: 120,
          clickY: 48
        }
      ]
    }
    const ops = recoverInferredActions(
      [
        {
          op: 'type_text',
          stepOrder: 4,
          evidenceEventIds: ['tevt_title'],
          confidence: 0.8,
          timeoutMs: 10000,
          label: 'Open “workflow logs”',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: 'workflow logs',
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        },
        {
          op: 'keystroke',
          stepOrder: 4,
          evidenceEventIds: ['tevt_title'],
          confidence: 0.8,
          timeoutMs: 3000,
          label: 'Open selected document',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: 'Enter',
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      {
        ...workflow,
        steps: [
          ...workflow.steps,
          {
            order: 4,
            action: 'Rename to workflow logs document in Google Docs.',
            category: 'data_entry',
            appName: 'Google Chrome',
            evidenceEventIds: ['tevt_title'],
            confidence: 0.9
          }
        ]
      },
      renamePolished,
      warnings
    )
    expect(ops.map((o) => o.op)).toEqual(['click_at', 'type_text', 'keystroke'])
    expect(ops[0]?.clickX).toBe(120)
    expect(ops[0]?.clickY).toBe(48)
    expect(ops[1]?.literalText).toBe('workflow logs')
    expect(ops[2]?.label).toMatch(/confirm rename/i)
  })

  it('injectClickOpsFromEvidence inserts missing click_at into the owning step', () => {
    const warnings: string[] = []
    const clickPolished: PolishedSession = {
      ...polished,
      actions: [
        ...polished.actions,
        {
          order: 3,
          text: 'Clicked New',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:48.000Z',
          sourceEventIds: ['tevt_new'],
          appName: 'Google Chrome',
          targetWindowTitle: 'Recorded document',
          elementLabel: 'New',
          clickX: 80,
          clickY: 200
        },
        {
          order: 4,
          text: 'Clicked cell A1',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:49.000Z',
          sourceEventIds: ['tevt_cell'],
          appName: 'Google Chrome',
          elementLabel: 'A1',
          clickX: 240,
          clickY: 320
        }
      ]
    }
    const ops = injectClickOpsFromEvidence(
      [
        {
          op: 'open_url',
          stepOrder: 2,
          evidenceEventIds: ['tevt_click'],
          confidence: 0.9,
          timeoutMs: 10000,
          label: 'Create sheet',
          appName: 'Google Chrome',
          appBundleId: null,
          url: 'https://docs.google.com/spreadsheets/create',
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        },
        {
          op: 'wait_for',
          stepOrder: 2,
          evidenceEventIds: ['tevt_click'],
          confidence: 0.8,
          timeoutMs: 10000,
          label: 'Wait',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: 'window_title_contains',
          waitValue: 'Sheet',
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      {
        ...workflow,
        steps: [
          workflow.steps[0]!,
          {
            order: 2,
            action: 'Create a new Google Sheets and create a table',
            category: 'data_entry',
            appName: 'Google Chrome',
            evidenceEventIds: ['tevt_click', 'tevt_new', 'tevt_cell'],
            confidence: 0.9
          }
        ]
      },
      clickPolished,
      warnings
    )
    expect(ops.filter((o) => o.op === 'click_at')).toHaveLength(2)
    expect(ops.map((o) => o.op)).toEqual(['open_url', 'click_at', 'click_at', 'wait_for'])
    expect(warnings.some((w) => /Injected 2 click_at/i.test(w))).toBe(true)
    // M9 R4: the recorded window identity travels with the point; none is invented.
    expect(ops.filter((o) => o.op === 'click_at').map((o) => o.windowTitle)).toEqual(['Recorded document', null])
  })

  it('isCreateSheetIntent matches spreadsheet create but not create columns', () => {
    expect(isCreateSheetIntent('Create Data Collection spreadsheet')).toBe(true)
    expect(isCreateSheetIntent('Create an Untitled spreadsheet')).toBe(true)
    expect(isCreateSheetIntent('Opened an untitled spreadsheet.')).toBe(true)
    expect(
      isCreateSheetIntent(
        'Open the Data Logs spreadsheet in Google Sheets, passing through the untitled spreadsheet view.'
      )
    ).toBe(false)
    expect(isCreateSheetIntent('Inspect or select content in Data Collection')).toBe(false)
    expect(isCreateSheetIntent('Create columns x, y, and time on the spreadsheet')).toBe(false)
  })

  it('ensureCreateRenameFromEvidence replaces Drive New click and infers rename from title change', () => {
    const warnings: string[] = []
    const seed = {
      op: 'click_at' as const,
      stepOrder: 2,
      evidenceEventIds: ['tevt_new'],
      confidence: 0.9,
      timeoutMs: 5000,
      label: 'Select creation option',
      appName: 'Google Chrome',
      appBundleId: null,
      url: null,
      urlVariableKey: null,
      elementRole: null,
      elementLabel: null,
      elementPath: null,
      chord: null,
      variableKey: null,
      literalText: null,
      waitCondition: null,
      waitValue: null,
      prompt: null,
      clickX: 62 as number | null,
      clickY: 210 as number | null
    }
    const polishedCreate: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Clicked New',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:47.000Z',
          sourceEventIds: ['tevt_new'],
          appName: 'Google Chrome',
          documentTitle: 'https://drive.google.com/drive/home',
          clickX: 62,
          clickY: 210
        },
        {
          order: 2,
          text: 'Opened Untitled',
          category: 'navigation',
          timestamp: '2026-07-29T04:28:48.000Z',
          sourceEventIds: ['tevt_create'],
          appName: 'Google Chrome',
          documentTitle: 'Untitled',
          screenAfter: {
            documentTitle: 'Untitled',
            urlHost: 'docs.google.com',
            stateChangeKind: 'url_changed',
            stateChangeDetail: 'URL → docs.google.com/spreadsheets/create'
          }
        },
        {
          order: 3,
          text: 'Clicked title',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:49.000Z',
          sourceEventIds: ['tevt_title'],
          appName: 'Google Chrome',
          documentTitle:
            'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit',
          clickX: 145,
          clickY: 135
        },
        {
          order: 4,
          text: 'Opened Data Collection',
          category: 'navigation',
          timestamp: '2026-07-29T04:28:50.000Z',
          sourceEventIds: ['tevt_named'],
          appName: 'Google Chrome',
          documentTitle: 'Data Collection - Google Sheets',
          screenAfter: {
            documentTitle: 'Data Collection - Google Sheets',
            stateChangeKind: 'title_changed',
            stateChangeDetail:
              'Title: Untitled spreadsheet - Google Sheets → Data Collection - Google Sheets'
          }
        }
      ]
    }
    expect(polishedImpliesCreateSheet(polishedCreate)).toBe(true)
    expect(renameNameFromPolishedTitleChange(polishedCreate)).toBe('Data Collection')

    const ops = ensureCreateRenameFromEvidence(
      [
        { ...seed, op: 'click_at', clickX: 62, clickY: 210 },
        {
          ...seed,
          stepOrder: 3,
          op: 'wait_for',
          waitCondition: 'window_title_contains',
          waitValue: 'Untitled spreadsheet',
          clickX: null,
          clickY: null,
          evidenceEventIds: ['tevt_create']
        },
        {
          ...seed,
          stepOrder: 3,
          op: 'click_at',
          clickX: 145,
          clickY: 135,
          evidenceEventIds: ['tevt_title']
        },
        {
          ...seed,
          stepOrder: 4,
          op: 'open_url',
          url: null,
          urlVariableKey: 'file',
          clickX: null,
          clickY: null,
          evidenceEventIds: ['tevt_named']
        }
      ],
      {
        ...workflow,
        variables: [
          {
            key: 'file',
            kind: 'document',
            label: 'sheet',
            exampleSanitized:
              'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit'
          }
        ]
      },
      polishedCreate,
      warnings
    )

    expect(ops.some((o) => o.op === 'open_url' && /spreadsheets\/create/i.test(o.url ?? ''))).toBe(
      true
    )
    expect(ops.some((o) => o.op === 'type_text' && o.literalText === 'Data Collection')).toBe(true)
    expect(ops.some((o) => o.op === 'open_url' && o.urlVariableKey === 'file')).toBe(false)
    expect(ops.findIndex((o) => o.op === 'open_url' && /create/i.test(o.url ?? ''))).toBeLessThan(
      ops.findIndex((o) => o.op === 'wait_for' && /untitled/i.test(o.waitValue ?? ''))
    )
  })

  it('hoistCreateSheetBeforeMisplacedWaits moves Untitled wait before create URL', () => {
    const warnings: string[] = []
    const seed = {
      op: 'click_at' as const,
      stepOrder: 1,
      evidenceEventIds: ['tevt_a'],
      confidence: 0.9,
      timeoutMs: 5000,
      label: 'x',
      appName: 'Google Chrome',
      appBundleId: null,
      url: null,
      urlVariableKey: null,
      elementRole: null,
      elementLabel: null,
      elementPath: null,
      chord: null,
      variableKey: null,
      literalText: null,
      waitCondition: null,
      waitValue: null,
      prompt: null,
      clickX: null as number | null,
      clickY: null as number | null
    }
    const ops = hoistCreateSheetBeforeMisplacedWaits(
      [
        {
          ...seed,
          op: 'wait_for',
          waitCondition: 'window_title_contains',
          waitValue: 'Untitled spreadsheet'
        },
        {
          ...seed,
          stepOrder: 2,
          op: 'open_url',
          url: 'https://docs.google.com/spreadsheets/create'
        },
        { ...seed, stepOrder: 2, op: 'click_at', clickX: 10, clickY: 20 }
      ],
      warnings
    )
    expect(ops[0]?.op).toBe('open_url')
    expect(ops[1]?.op).toBe('wait_for')
    expect(ops[2]?.op).toBe('click_at')
  })

  it('orderCreateSheetSequences puts create URL before Untitled wait and rename clicks', () => {
    const warnings: string[] = []
    const seed = {
      op: 'click_at' as const,
      stepOrder: 2,
      evidenceEventIds: ['tevt_a'],
      confidence: 0.9,
      timeoutMs: 5000,
      label: 'x',
      appName: 'Google Chrome',
      appBundleId: null,
      url: null,
      urlVariableKey: null,
      elementRole: null,
      elementLabel: null,
      elementPath: null,
      chord: null,
      variableKey: null,
      literalText: null,
      waitCondition: null,
      waitValue: null,
      prompt: null,
      clickX: 10,
      clickY: 20
    }
    const ops = orderCreateSheetSequences(
      [
        {
          ...seed,
          op: 'wait_for',
          waitCondition: 'window_title_contains',
          waitValue: 'Untitled spreadsheet',
          clickX: null,
          clickY: null
        },
        { ...seed, op: 'click_at', clickX: 168, clickY: 132 },
        {
          ...seed,
          op: 'open_url',
          url: 'https://docs.google.com/spreadsheets/create',
          clickX: null,
          clickY: null
        },
        {
          ...seed,
          op: 'wait_for',
          waitCondition: 'window_title_contains',
          waitValue: 'Data Logs - Google Sheets',
          clickX: null,
          clickY: null
        }
      ],
      warnings
    )
    expect(ops.map((o) => o.op)).toEqual(['open_url', 'wait_for', 'click_at', 'wait_for'])
    expect(ops[0]?.url).toContain('spreadsheets/create')
    expect(ops[1]?.waitValue).toMatch(/untitled/i)
  })

  it('rewriteCreateSheetClicks turns Drive New-menu click_at into create URL', () => {
    const warnings: string[] = []
    const ops = rewriteCreateSheetClicks(
      [
        {
          op: 'click_at',
          stepOrder: 3,
          evidenceEventIds: ['tevt_new'],
          confidence: 0.9,
          timeoutMs: 5000,
          label: 'Create Data Collection spreadsheet.',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: 140,
          clickY: 372
        },
        {
          op: 'wait_for',
          stepOrder: 3,
          evidenceEventIds: ['tevt_new'],
          confidence: 0.9,
          timeoutMs: 20000,
          label: 'Create Data Collection spreadsheet.',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: 'window_title_contains',
          waitValue: 'Untitled',
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      {
        ...workflow,
        steps: [
          workflow.steps[0]!,
          {
            order: 3,
            action: 'Create Data Collection spreadsheet.',
            category: 'navigation',
            appName: 'Google Chrome',
            evidenceEventIds: ['tevt_new'],
            confidence: 0.9
          }
        ]
      },
      {
        ...polished,
        actions: [
          ...polished.actions,
          {
            order: 10,
            text: 'Opened window Untitled spreadsheet - Google Sheets in Google Chrome',
            category: 'navigation',
            timestamp: '2026-07-29T04:28:50.000Z',
            sourceEventIds: ['tevt_new'],
            appName: 'Google Chrome',
            documentTitle: 'Untitled spreadsheet - Google Sheets'
          }
        ]
      },
      warnings
    )
    expect(ops[0]?.op).toBe('open_url')
    expect(ops[0]?.url).toBe('https://docs.google.com/spreadsheets/create')
    expect(ops[1]?.op).toBe('wait_for')
    expect(warnings.some((w) => /Rewrote create-sheet click_at/i.test(w))).toBe(true)
  })

  it('applyEditorIntentToOps forces “Rename the document to X” over Untitled literal', () => {
    const warnings: string[] = []
    const ops = applyEditorIntentToOps(
      [
        {
          op: 'type_text',
          stepOrder: 4,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.8,
          timeoutMs: 10000,
          label: 'Rename to “Untitled,”',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: 'Untitled,',
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        },
        {
          op: 'keystroke',
          stepOrder: 4,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.8,
          timeoutMs: 3000,
          label: 'Confirm rename',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: 'Enter',
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      {
        ...workflow,
        steps: [
          ...workflow.steps,
          {
            order: 4,
            action: 'Rename the document to Workflow Logs.',
            category: 'data_entry',
            appName: 'Google Chrome',
            evidenceEventIds: ['tevt_nav'],
            confidence: 0.9
          }
        ]
      },
      polished,
      warnings
    )
    const typed = ops.find((o) => o.op === 'type_text')
    expect(typed?.literalText).toBe('Workflow Logs')
    expect(typed?.label).toBe('Rename the document to Workflow Logs.')
    expect(warnings.some((w) => /Applied editor rename/i.test(w))).toBe(true)
  })

  it('drops Cmd+T and Cmd+L before open_url to avoid double tabs', () => {
    const warnings: string[] = []
    const ops = collapseRedundantBrowserNav(
      [
        {
          op: 'keystroke',
          stepOrder: 1,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.9,
          timeoutMs: 3000,
          label: 'Open a new tab',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: 'Cmd+T',
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        },
        {
          op: 'keystroke',
          stepOrder: 2,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.9,
          timeoutMs: 3000,
          label: 'Focus the address bar',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: 'Cmd+L',
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        },
        {
          op: 'open_url',
          stepOrder: 2,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.9,
          timeoutMs: 10000,
          label: 'Open Google Drive',
          appName: 'Google Chrome',
          appBundleId: null,
          url: 'https://drive.google.com/',
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      warnings
    )
    expect(ops.map((o) => o.op)).toEqual(['open_url'])
    expect(warnings.some((w) => /two tabs/i.test(w))).toBe(true)
  })

  it('converts address-bar activate_element to Cmd+L', () => {
    const warnings: string[] = []
    const ops = recoverInferredActions(
      [
        {
          op: 'activate_element',
          stepOrder: 1,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.8,
          timeoutMs: 10000,
          label: 'Focus the address bar',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: 'AXTextField',
          elementLabel: 'Address and search bar',
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      workflow,
      polished,
      warnings
    )
    expect(ops[0]?.op).toBe('keystroke')
    expect(ops[0]?.chord).toBe('Cmd+L')
  })
})

describe('ensureBrowserNewTab', () => {
  it('injects Cmd+T after open_app when the recording used a New Tab', () => {
    const browserPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Opened New Tab in Google Chrome',
          category: 'navigation',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_nav'],
          appName: 'Google Chrome',
          documentTitle: 'New Tab'
        }
      ]
    }
    const ops = ensureBrowserNewTab(
      [
        {
          op: 'open_app',
          stepOrder: 1,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.9,
          timeoutMs: 10000,
          label: 'Open Chrome',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        },
        {
          op: 'type_text',
          stepOrder: 1,
          evidenceEventIds: ['tevt_nav'],
          confidence: 0.8,
          timeoutMs: 10000,
          label: 'Type query',
          appName: 'Google Chrome',
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: 'how to use ai',
          waitCondition: null,
          waitValue: null,
          prompt: null,
          clickX: null,
          clickY: null
        }
      ],
      browserPolished,
      []
    )
    expect(ops.map((o) => o.op)).toEqual(['open_app', 'keystroke', 'type_text'])
    expect(ops[1]?.chord).toBe('Cmd+T')
  })
})

describe('validateAndGroundScript', () => {
  it('replaces invented type_text literal with searchQuery from evidence', () => {
    const searchPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Typed ai',
          category: 'input',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_type'],
          appName: 'Google Chrome',
          documentTitle: 'how to use ai - Google Search',
          typedText: 'ai'
        }
      ]
    }
    const searchWorkflow: ExtractedWorkflow = {
      ...workflow,
      steps: [
        {
          order: 1,
          action: 'Type the search query',
          category: 'data_entry',
          appName: 'Google Chrome',
          evidenceEventIds: ['tevt_type'],
          confidence: 0.8
        }
      ]
    }
    const script = validateAndGroundScript(
      {
        ops: [
          {
            op: 'type_text',
            stepOrder: 1,
            evidenceEventIds: ['tevt_type'],
            confidence: 0.8,
            timeoutMs: 10000,
            label: 'Type query',
            appName: 'Google Chrome',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: null,
            elementLabel: null,
            elementPath: null,
            chord: null,
            variableKey: null,
            literalText: 'aiaiai',
            waitCondition: null,
            waitValue: null,
            prompt: null,
            clickX: null,
            clickY: null,
          }
        ],
        warnings: []
      },
      searchWorkflow,
      searchPolished
    )
    expect(script.ops[0]?.op).toBe('type_text')
    expect(script.ops[0]?.literalText).toBe('how to use ai')
  })

  it.each([
    ['uncertain', 'uncertain' as const, null],
    ['exact', 'exact' as const, 'quarterly report']
  ])('M8-B: %s typed text %s', (_n, textQuality, expected) => {
    const typedPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Typed into Name',
          category: 'input',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_t'],
          appName: 'TextEdit',
          typedText: 'quarterly report',
          textQuality
        }
      ]
    }
    // The extracted step quotes the captured text, as an interpretation model would.
    const wf: ExtractedWorkflow = {
      ...workflow,
      variables: [],
      steps: [{ order: 1, action: 'Type "quarterly report" into Name', category: 'data_entry', appName: 'TextEdit', evidenceEventIds: ['tevt_t'], confidence: 0.8 }]
    }
    const op = {
      op: 'type_text' as const, stepOrder: 1, evidenceEventIds: ['tevt_t'], confidence: 0.8, timeoutMs: 10000,
      label: 'Type name', appName: 'TextEdit', appBundleId: null, url: null, urlVariableKey: null, elementRole: null,
      elementLabel: null, elementPath: null, chord: null, variableKey: null, literalText: 'quarterly report',
      waitCondition: null, waitValue: null, prompt: null, clickX: null, clickY: null
    }
    const script = validateAndGroundScript({ ops: [op], warnings: [] }, wf, typedPolished)
    if (expected) {
      expect(script.ops[0]).toMatchObject({ op: 'type_text', literalText: expected })
    } else {
      // Never replayed as a literal (model-proposed or recovered); the user confirms it instead.
      expect(script.ops[0]).toMatchObject({ op: 'manual', prompt: expect.stringContaining('Confirm the text') })
      expect(script.ops.some((o) => o.op === 'type_text' || o.op === 'set_clipboard' || o.literalText)).toBe(false)
    }
  })

  it('M9 R4: every point op takes geometry and window identity from its own click evidence', () => {
    const clickPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Clicked Share',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_c'],
          appName: 'Figma',
          elementLabel: 'Share',
          elementRole: 'AXButton',
          clickX: 140,
          clickY: 180,
          clickWindowX: 40,
          clickWindowY: 80,
          windowWidth: 800,
          windowHeight: 600,
          targetWindowTitle: 'Recorded document',
          clickButton: 'middle',
          clickCount: 1
        },
        { order: 2, text: 'Pressed Escape', category: 'interaction', timestamp: '2026-07-29T04:28:47.548Z', sourceEventIds: ['tevt_k'], appName: 'Figma' }
      ]
    }
    const wf: ExtractedWorkflow = {
      ...workflow,
      variables: [],
      steps: [{ order: 1, action: 'Click Share', category: 'navigation', appName: 'Figma', evidenceEventIds: ['tevt_c', 'tevt_k'], confidence: 0.8 }]
    }
    const base = {
      stepOrder: 1, confidence: 0.8, timeoutMs: 10000, appName: 'Figma', appBundleId: null, url: null,
      urlVariableKey: null, elementRole: null, elementPath: null, chord: null, variableKey: null, literalText: null,
      waitCondition: null, waitValue: null, prompt: null
    }
    const script = validateAndGroundScript(
      {
        ops: [
          // Proposed with another window and other coordinates: grounded to the evidence.
          { ...base, op: 'click_at' as const, evidenceEventIds: ['tevt_c'], label: 'Click', elementLabel: null, clickX: 1, clickY: 2, clickWindowX: 1, clickWindowY: 2, windowWidth: 10, windowHeight: 10, windowTitle: 'Other document', clickButton: 'left' as const, clickCount: 2 },
          { ...base, op: 'activate_element' as const, evidenceEventIds: ['tevt_c'], label: 'Press', elementLabel: 'Share', clickX: null, clickY: null },
          // No click evidence: no point and no window survive.
          { ...base, op: 'click_at' as const, evidenceEventIds: ['tevt_k'], label: 'Invented', elementLabel: null, clickX: 7, clickY: 8, windowTitle: 'Other document' }
        ],
        warnings: []
      },
      wf,
      clickPolished
    )
    const points = script.ops.filter((o) => o.op === 'click_at' || o.op === 'activate_element')
    expect(points[0]).toMatchObject({ clickWindowX: 40, clickWindowY: 80, windowWidth: 800, windowTitle: 'Recorded document' })
    // R2: the observed middle button and count win over the proposal.
    expect(points[0]).toMatchObject({ clickButton: 'middle', clickCount: 1 })
    expect(points[1]).toMatchObject({ windowTitle: 'Recorded document' })
    // The op with only non-click evidence (labels are normalised, so by position).
    expect(script.ops[2]).toMatchObject({ op: 'click_at', clickX: null, clickY: null, windowTitle: null, clickButton: null })
  })

  it('fills set_clipboard literalText from in-memory clipboard map', () => {
    const clipPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Copied text',
          category: 'clipboard',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_clip'],
          clipboard: {
            contentType: 'text',
            charCount: 11,
            contentHash: 'abc123'
          }
        }
      ]
    }
    const clipWorkflow: ExtractedWorkflow = {
      ...workflow,
      steps: [
        {
          order: 1,
          action: 'Copy text',
          category: 'interaction',
          appName: null,
          evidenceEventIds: ['tevt_clip'],
          confidence: 0.7
        }
      ]
    }
    const script = validateAndGroundScript(
      {
        ops: [
          {
            op: 'set_clipboard',
            stepOrder: 1,
            evidenceEventIds: ['tevt_clip'],
            confidence: 0.7,
            timeoutMs: 5000,
            label: 'Set clipboard',
            appName: null,
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: null,
            elementLabel: null,
            elementPath: null,
            chord: null,
            variableKey: null,
            literalText: null,
            waitCondition: null,
            waitValue: null,
            prompt: null,
            clickX: null,
            clickY: null,
          }
        ],
        warnings: []
      },
      clipWorkflow,
      clipPolished,
      new Map([['abc123', 'hello world']])
    )
    expect(script.ops[0]?.op).toBe('set_clipboard')
    expect(script.ops[0]?.literalText).toBe('hello world')
  })

  it('keeps grounded activate_element ops', () => {
    const script = validateAndGroundScript(
      {
        ops: [
          {
            op: 'open_app',
            stepOrder: 1,
            evidenceEventIds: ['tevt_nav'],
            confidence: 0.9,
            timeoutMs: 10000,
            label: 'Open Messages',
            appName: 'Messages',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: null,
            elementLabel: null,
            elementPath: null,
            chord: null,
            variableKey: null,
            literalText: null,
            waitCondition: null,
            waitValue: null,
            prompt: null,
            clickX: null,
            clickY: null,
          },
          {
            op: 'activate_element',
            stepOrder: 2,
            evidenceEventIds: ['tevt_click'],
            confidence: 0.85,
            timeoutMs: 10000,
            label: 'Click Send',
            appName: 'Messages',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: 'AXButton',
            elementLabel: 'Send',
            elementPath: null,
            chord: null,
            variableKey: null,
            literalText: null,
            waitCondition: null,
            waitValue: null,
            prompt: null,
            clickX: null,
            clickY: null,
          }
        ],
        warnings: []
      },
      workflow,
      polished
    )
    expect(script.ops[1].op).toBe('activate_element')
    expect(script.ops[1].elementLabel).toBe('Send')
  })

  it('downgrades hallucinated activate_element to manual', () => {
    const script = validateAndGroundScript(
      {
        ops: [
          {
            op: 'activate_element',
            stepOrder: 2,
            evidenceEventIds: ['tevt_click'],
            confidence: 0.9,
            timeoutMs: 10000,
            label: 'Click Invented',
            appName: 'Messages',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: 'AXButton',
            elementLabel: 'Completely Fake Button',
            elementPath: null,
            chord: null,
            variableKey: null,
            literalText: null,
            waitCondition: null,
            waitValue: null,
            prompt: null,
            clickX: null,
            clickY: null,
          }
        ],
        warnings: []
      },
      workflow,
      polished
    )
    expect(script.ops[0].op).toBe('manual')
    expect(script.warnings.some((w) => /ungrounded/i.test(w))).toBe(true)
  })

  it('rejects unknown stepOrder', () => {
    expect(() =>
      validateAndGroundScript(
        {
          ops: [
            {
              op: 'open_app',
              stepOrder: 99,
              evidenceEventIds: ['tevt_nav'],
              confidence: 0.9,
              timeoutMs: 10000,
              label: 'Bad',
              appName: 'Messages',
              appBundleId: null,
              url: null,
              urlVariableKey: null,
              elementRole: null,
              elementLabel: null,
              elementPath: null,
              chord: null,
              variableKey: null,
              literalText: null,
              waitCondition: null,
              waitValue: null,
              prompt: null,
              clickX: null,
              clickY: null,
            }
          ],
          warnings: []
        },
        workflow,
        polished
      )
    ).toThrow()
  })
})

describe('compileAutomationScript', () => {
  it('calls OpenAI and saves through TelemetryStore', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_auto' })
    await store.stopSession('tsess_auto')
    await store.savePolishedSession('tsess_auto', polished)

    const parse = vi.fn(async () => ({
      output_parsed: {
        ops: [
          {
            op: 'open_app',
            stepOrder: 1,
            evidenceEventIds: ['tevt_nav'],
            confidence: 0.9,
            timeoutMs: 10000,
            label: 'Open Messages',
            appName: 'Messages',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: null,
            elementLabel: null,
            elementPath: null,
            chord: null,
            variableKey: null,
            literalText: null,
            waitCondition: null,
            waitValue: null,
            prompt: null,
            clickX: null,
            clickY: null,
          }
        ],
        warnings: []
      }
    }))

    const stored = await compileAutomationScript(
      store,
      {
        storage: 'file',
        devDir: '/tmp',
        openaiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz12',
        openaiModel: 'gpt-test',
        isDev: true,
        isPackaged: false
      },
      'tsess_auto',
      workflow,
      polished,
      { createClient: () => ({ responses: { parse } }) }
    )

    expect(parse).toHaveBeenCalledTimes(1)
    expect(stored.script.ops).toHaveLength(1)
    expect(stored.script.ops[0].op).toBe('open_app')
    expect(store.automation.get('tsess_auto')).toBeTruthy()
  })
})

describe('preferClickAtWhenGrounded / inject recorded inputs', () => {
  const seed = {
    stepOrder: 1,
    evidenceEventIds: ['tevt_g'],
    confidence: 0.7,
    timeoutMs: 10_000,
    label: 'Click',
    appName: 'Figma',
    appBundleId: null,
    url: null,
    urlVariableKey: null,
    elementRole: null as string | null,
    elementLabel: null as string | null,
    elementPath: null,
    chord: null,
    variableKey: null,
    literalText: null,
    waitCondition: null,
    waitValue: null,
    prompt: null,
    clickX: null as number | null,
    clickY: null as number | null
  }

  it('rewrites AXGroup activate_element to click_at when coords exist', () => {
    const warnings: string[] = []
    const groupPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Clicked point (62,210)',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:47.000Z',
          sourceEventIds: ['tevt_g'],
          appName: 'Figma',
          elementRole: 'AXGroup',
          targetResolution: 'coords',
          clickX: 62,
          clickY: 210,
          clickWindowX: 12,
          clickWindowY: 40,
          windowWidth: 800,
          windowHeight: 600
        }
      ]
    }
    const byEvent = new Map(groupPolished.actions.flatMap((a) => a.sourceEventIds.map((id) => [id, a] as const)))
    const ops = preferClickAtWhenGrounded(
      [
        {
          ...seed,
          op: 'activate_element',
          elementRole: 'AXGroup',
          elementLabel: 'Figma'
        }
      ],
      groupPolished,
      byEvent,
      warnings
    )
    expect(ops[0]?.op).toBe('click_at')
    expect(ops[0]?.clickX).toBe(62)
    expect(ops[0]?.clickWindowX).toBe(12)
    expect(ops[0]?.windowWidth).toBe(800)
  })

  it('still injects click_at when a weak activate_element covered the event', () => {
    const warnings: string[] = []
    const groupPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Clicked point (10,20)',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:47.000Z',
          sourceEventIds: ['tevt_g'],
          appName: 'Figma',
          elementRole: 'AXGroup',
          clickX: 10,
          clickY: 20
        }
      ]
    }
    const ops = injectClickOpsFromEvidence(
      [
        {
          ...seed,
          op: 'activate_element',
          elementRole: 'AXGroup',
          elementLabel: null
        }
      ],
      {
        ...workflow,
        steps: [
          wfStep({
            order: 1,
            action: 'Click canvas',
            category: 'interaction',
            appName: 'Figma',
            evidenceEventIds: ['tevt_g'],
            confidence: 0.7
          })
        ]
      },
      groupPolished,
      warnings
    )
    expect(ops.some((o) => o.op === 'click_at' && o.clickX === 10)).toBe(true)
  })

  it('injects type_text and keystroke from polished evidence', () => {
    const warnings: string[] = []
    const typedPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Typed "hello"',
          category: 'input',
          timestamp: '2026-07-29T04:28:47.000Z',
          sourceEventIds: ['tevt_type'],
          appName: 'Notes',
          typedText: 'hello',
          textQuality: 'exact'
        },
        {
          order: 2,
          text: 'Pressed Escape',
          category: 'shortcut',
          timestamp: '2026-07-29T04:28:48.000Z',
          sourceEventIds: ['tevt_esc'],
          appName: 'Notes'
        }
      ]
    }
    const wf: ExtractedWorkflow = {
      ...workflow,
      steps: [
        wfStep({
          order: 1,
          action: 'Type a note',
          category: 'input',
          appName: 'Notes',
          evidenceEventIds: ['tevt_type', 'tevt_esc'],
          confidence: 0.8
        })
      ]
    }
    const base = [
      {
        ...seed,
        op: 'open_app' as const,
        evidenceEventIds: ['tevt_type'],
        appName: 'Notes',
        label: 'Open Notes'
      }
    ]
    const withType = injectTypeTextOpsFromEvidence(base, wf, typedPolished, warnings)
    const withKeys = injectKeystrokeOpsFromEvidence(withType, wf, typedPolished, warnings)
    expect(withKeys.some((o) => o.op === 'type_text' && o.literalText === 'hello')).toBe(true)
    expect(withKeys.some((o) => o.op === 'keystroke' && o.chord === 'Escape')).toBe(true)
  })

  it('injects scroll ahead of click_at', () => {
    const warnings: string[] = []
    const scrollPolished: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Scrolled',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:47.000Z',
          sourceEventIds: ['tevt_scroll'],
          appName: 'Figma',
          l1Op: 'reveal',
          scrollAxis: 'vertical',
          scrollDelta: 120,
          clickX: 200,
          clickY: 300
        },
        {
          order: 2,
          text: 'Clicked point (200,400)',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:48.000Z',
          sourceEventIds: ['tevt_click'],
          appName: 'Figma',
          clickX: 200,
          clickY: 400
        }
      ]
    }
    const wf: ExtractedWorkflow = {
      ...workflow,
      steps: [
        wfStep({
          order: 1,
          action: 'Scroll then click',
          category: 'interaction',
          appName: 'Figma',
          evidenceEventIds: ['tevt_scroll', 'tevt_click'],
          confidence: 0.8
        })
      ]
    }
    const withClicks = injectClickOpsFromEvidence(
      [{ ...seed, op: 'open_app', appName: 'Figma', label: 'Open' }],
      wf,
      scrollPolished,
      warnings
    )
    const withScroll = injectScrollOpsFromEvidence(withClicks, wf, scrollPolished, warnings)
    const scrollIdx = withScroll.findIndex((o) => o.op === 'scroll')
    const clickIdx = withScroll.findIndex((o) => o.op === 'click_at')
    expect(scrollIdx).toBeGreaterThanOrEqual(0)
    expect(clickIdx).toBeGreaterThan(scrollIdx)
    expect(withScroll[scrollIdx]?.scrollDelta).toBe(120)
  })
})

describe('M8-B literal provenance through compile and save', () => {
  const CONFIG = {
    storage: 'file' as const,
    devDir: '/tmp',
    openaiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz12',
    openaiModel: 'gpt-test',
    isDev: true,
    isPackaged: false
  }
  const NULLS = {
    confidence: 0.8, timeoutMs: 10000, appBundleId: null, url: null, urlVariableKey: null, elementRole: null,
    elementLabel: null, elementPath: null, chord: null, variableKey: null, waitCondition: null, waitValue: null,
    prompt: null, clickX: null, clickY: null
  }

  async function compileWith(opts: {
    typedText: string
    textQuality?: 'exact' | 'uncertain'
    stepAction: string
    op: 'type_text' | 'set_clipboard'
    proposed: string
  }) {
    const p: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1, text: 'Typed into Name', category: 'input', timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_t'], appName: 'TextEdit', typedText: opts.typedText,
          ...(opts.textQuality ? { textQuality: opts.textQuality } : {})
        }
      ]
    }
    const wf: ExtractedWorkflow = {
      ...workflow,
      variables: [],
      steps: [wfStep({ order: 1, action: opts.stepAction, category: 'data_entry', appName: 'TextEdit', evidenceEventIds: ['tevt_t'], confidence: 0.8 })]
    }
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_auto' })
    await store.stopSession('tsess_auto')
    await store.savePolishedSession('tsess_auto', p)
    const parse = vi.fn(async () => ({
      output_parsed: {
        ops: [{ ...NULLS, op: opts.op, stepOrder: 1, evidenceEventIds: ['tevt_t'], label: 'Enter', appName: 'TextEdit', literalText: opts.proposed }],
        warnings: []
      }
    }))
    await compileAutomationScript(store, CONFIG, 'tsess_auto', wf, p, { createClient: () => ({ responses: { parse } }) })
    return store.automation.get('tsess_auto')!.script.ops
  }
  const literals = (ops: AutomationOp[]) => ops.filter((o) => o.literalText).map((o) => o.literalText)

  it.each([
    ['uncertain, generated quote changed', { textQuality: 'uncertain' as const, stepAction: 'Type "quarterly reports" into Name', op: 'type_text' as const, proposed: 'quarterly reports' }],
    ['uncertain, changed quote as clipboard', { textQuality: 'uncertain' as const, stepAction: 'Type "quarterly reports" into Name', op: 'set_clipboard' as const, proposed: 'quarterly reports' }],
    ['legacy (no quality), changed quote', { stepAction: 'Type "quarterly reports" into Name', op: 'type_text' as const, proposed: 'quarterly reports' }],
    ['uncertain, rename recovery from step text', { textQuality: 'uncertain' as const, stepAction: 'Rename document to "quarterly report"', op: 'type_text' as const, proposed: 'quarterly report' }]
  ])('R3 %s: no literal is saved; the step asks for confirmation', async (_n, o) => {
    const ops = await compileWith({ typedText: 'quarterly report', ...o })
    expect(literals(ops)).toEqual([])
    expect(ops.some((op) => op.op === 'manual' && /Confirm the text/.test(op.prompt ?? ''))).toBe(true)
  })

  it.each([
    ['newline changed', 'one\ntwo', 'one two'],
    ['casing changed', 'CaseSensitive', 'casesensitive'],
    ['trailing newline added', 'CaseSensitive', 'CaseSensitive\n'],
    ['leading space added', 'CaseSensitive', ' CaseSensitive'],
    ['control: exact proposal', 'one\ntwo', 'one\ntwo']
  ])('R4 %s: the saved literal is the authoritative exact value', async (_n, typed, proposed) => {
    for (const op of ['type_text', 'set_clipboard'] as const) {
      const ops = await compileWith({ typedText: typed, textQuality: 'exact', stepAction: 'Enter Name', op, proposed })
      expect(new Set(literals(ops)), op).toEqual(new Set([typed]))
    }
  })
})

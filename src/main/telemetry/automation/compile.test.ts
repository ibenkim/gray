import { describe, expect, it, vi } from 'vitest'
import {
  SCHEMA_VERSION,
  withWorkflowStepDefaults,
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
  injectWaitOpsFromStepSemantics,
  preferAddressNavigation,
  recoverInferredActions,
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
          params: { sheet_id: 'SHEET123' },
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

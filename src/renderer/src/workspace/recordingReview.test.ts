import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RecordingSummary, ReviewPreview } from '../../../shared/types'
import { privacyStatusText } from '../components/shared/ReviewSections'
import {
  noticeForStopResult,
  recordingStatusLabel,
  UploadReviewView,
  type UploadReviewViewProps
} from './UploadReview'
import WorkflowsHome from './WorkflowsHome'

// Synthetic summaries only. Static rendering + element-tree action wiring; no DOM/Electron.

function summary(overrides: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    sessionId: 'tsess_ui_fixture',
    startedAt: '2026-01-01T12:00:00.000Z',
    saveState: 'complete',
    canRetrySave: false,
    reviewState: 'pending',
    interpretationState: 'not_started',
    ...overrides
  }
}

const preview: ReviewPreview = {
  sessionId: 'tsess_ui_fixture',
  revision: 2,
  digest: 'a'.repeat(64),
  provider: 'openai',
  model: 'test-model',
  purpose: 'Interpret this recording into a draft workflow',
  stages: 'Classify, then extract.',
  payloadText: '{\n  "acts": [{ "i": 1, "e": "Submit" }]\n}',
  bytes: 42,
  actionCount: 1,
  elided: false,
  categories: ['Recorded actions: app names, element labels and roles, action types'],
  exclusions: ['Screenshots and screen video', 'Raw microphone audio', 'Raw clipboard contents'],
  legacyUnverified: false
}

function viewProps(overrides: Partial<UploadReviewViewProps> = {}): UploadReviewViewProps {
  return {
    summary: summary(),
    preview,
    error: null,
    needsAck: false,
    busy: false,
    onApprove: vi.fn(),
    onSendAgain: vi.fn(),
    onKeepLocal: vi.fn(),
    onClose: vi.fn(),
    onOpenResult: vi.fn(),
    onRetrySave: vi.fn(),
    ...overrides
  }
}

function render(props: UploadReviewViewProps): string {
  return renderToStaticMarkup(createElement(UploadReviewView, props))
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** Find a <button> by its text in the (hook-free) view's element tree. */
function findButton(node: ReactNode, label: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findButton(n, label)
      if (hit) return hit
    }
    return null
  }
  if (!isValidElement(node)) return null
  const props = node.props as { children?: ReactNode }
  if (node.type === 'button' && textOf(props.children).trim() === label) return node
  return findButton(props.children, label)
}

describe('Finish notice', () => {
  it('complete save is a neutral success with Review upload and the retained session id', () => {
    const n = noticeForStopResult(
      { ok: true, sessionId: 'tsess_ui_fixture', recording: summary() },
      'tsess_ui_fixture'
    )
    expect(n).toMatchObject({
      tone: 'success',
      title: 'Recording saved',
      action: 'review',
      actionLabel: 'Review upload',
      sessionId: 'tsess_ui_fixture'
    })
    expect(n.body).toMatch(/Nothing has been sent/)
  })

  it('incomplete save is distinct, with local retry only when it can help', () => {
    const retryable = noticeForStopResult(
      {
        ok: true,
        recording: summary({
          saveState: 'incomplete',
          canRetrySave: true,
          saveMessage: 'Some recorded steps are not written to disk yet.'
        })
      },
      'tsess_ui_fixture'
    )
    expect(retryable).toMatchObject({ tone: 'error', title: 'Recording incomplete', action: 'retrySave' })
    const permanent = noticeForStopResult(
      { ok: true, recording: summary({ saveState: 'incomplete', canRetrySave: false }) },
      'tsess_ui_fixture'
    )
    expect(permanent.action).toBe('library')
  })

  it('saved-but-unprepared and unconfirmed outcomes have their own truthful messages', () => {
    const unprepared = noticeForStopResult(
      {
        ok: true,
        recording: summary({ reviewState: 'unavailable', reviewMessage: 'The recording is saved, but…' })
      },
      'tsess_ui_fixture'
    )
    expect(unprepared).toMatchObject({ tone: 'info', title: 'Recording saved; couldn’t prepare review' })
    const ipcRejected = noticeForStopResult(undefined, 'tsess_ui_fixture')
    expect(ipcRejected.title).toMatch(/Couldn’t confirm/)
    expect(ipcRejected.sessionId).toBe('tsess_ui_fixture')
    for (const n of [unprepared, ipcRejected]) expect(n.title).not.toMatch(/organize/i)
  })
})

describe('Library saved recordings', () => {
  const noop = () => {}
  const baseProps = {
    workflows: [],
    hoursLine: '0 h',
    suggestion: null,
    onOpen: noop,
    onToggleStatus: noop,
    onDiscardSuggestion: noop,
    onRename: noop,
    onDuplicate: noop,
    onDelete: noop
  }

  it('shows a pending recording even when there are zero workflows', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowsHome, { ...baseProps, recordings: [summary()] })
    )
    expect(html).toContain('Saved recordings')
    expect(html).toContain('Saved · not sent')
    expect(html).toContain('Review upload')
    expect(html).not.toContain('Record your first workflow')
  })

  it('empty Library without recordings keeps the first-run state', () => {
    const html = renderToStaticMarkup(createElement(WorkflowsHome, { ...baseProps, recordings: [] }))
    expect(html).toContain('Record your first workflow')
    expect(html).not.toContain('Saved recordings')
  })

  it('row labels reflect reload states honestly', () => {
    expect(recordingStatusLabel(summary({ interpretationState: 'sending' }))).toBe(
      'Sending for interpretation…'
    )
    expect(recordingStatusLabel(summary({ interpretationState: 'failed' }))).toBe(
      'Interpretation failed'
    )
    expect(recordingStatusLabel(summary({ interpretationState: 'interrupted_unknown' }))).toBe(
      'Interrupted — outcome unknown'
    )
    expect(recordingStatusLabel(summary({ interpretationState: 'complete', partial: true }))).toBe(
      'Interpreted (partial)'
    )
    expect(recordingStatusLabel(summary({ saveState: 'legacy_unverified' }))).toBe(
      'Saved earlier · completeness unverified'
    )
    expect(recordingStatusLabel(summary({ reviewState: 'cancelled' }))).toBe('Saved · not sent')
  })
})

describe('Review upload view', () => {
  it('shows the actual payload, destination and exclusions, with explicit (unchecked) consent', () => {
    const html = render(viewProps())
    expect(html).toContain('&quot;acts&quot;')
    expect(html).toContain('OpenAI · test-model')
    expect(html).toContain('Raw microphone audio')
    expect(html).toContain('Approve and send for interpretation')
    expect(html).toContain('Keep local')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toMatch(/upload succeeded|uploaded/i)
  })

  it('wires Approve and Keep local to their handlers only', () => {
    const props = viewProps()
    const tree = UploadReviewView(props)
    ;(findButton(tree, 'Approve and send for interpretation')!.props as { onClick: () => void }).onClick()
    expect(props.onApprove).toHaveBeenCalledTimes(1)
    expect(props.onKeepLocal).not.toHaveBeenCalled()
    ;(findButton(tree, 'Keep local')!.props as { onClick: () => void }).onClick()
    expect(props.onKeepLocal).toHaveBeenCalledTimes(1)
  })

  it('sending shows honest request state and no approve button', () => {
    const html = render(
      viewProps({ summary: summary({ interpretationState: 'sending', stage: 'classify' }) })
    )
    expect(html).toContain('Sending for interpretation…')
    expect(html).toContain('classify request in progress')
    expect(html).not.toContain('Approve and send')
  })

  it('complete result offers Open interpretation; failure and unknown outcome are explicit', () => {
    const complete = viewProps({
      summary: summary({
        interpretationState: 'complete',
        approvedModel: 'test-model',
        approvedAt: '2026-01-01T12:05:00.000Z'
      })
    })
    expect(render(complete)).toContain('Open interpretation')
    ;(findButton(UploadReviewView(complete), 'Open interpretation')!.props as { onClick: () => void }).onClick()
    expect(complete.onOpenResult).toHaveBeenCalled()

    expect(
      render(
        viewProps({
          summary: summary({
            interpretationState: 'failed',
            interpretationMessage: 'Workflow processing is unavailable because the OpenAI API configuration is invalid.'
          })
        })
      )
    ).toContain('configuration is invalid')
    const unknown = render(
      viewProps({ summary: summary({ interpretationState: 'interrupted_unknown' }), needsAck: true })
    )
    expect(unknown).toContain('outcome is unknown')
    expect(unknown).toContain('Send again')
  })

  it('legacy and incomplete saves are labelled; incomplete offers Retry save when possible', () => {
    expect(render(viewProps({ summary: summary({ saveState: 'legacy_unverified' }) }))).toContain(
      'capture completeness cannot be verified'
    )
    const incomplete = viewProps({
      preview: null,
      summary: summary({ saveState: 'incomplete', canRetrySave: true, saveMessage: 'Not all saved.' })
    })
    expect(render(incomplete)).toContain('Retry save')
    expect(render(incomplete)).not.toContain('Approve and send')
  })
})

describe('re-review after a changed digest (M1-HF2)', () => {
  it('explains that the earlier approval covered a previous version and nothing is sent', () => {
    const html = render(
      viewProps({
        summary: summary({
          reviewState: 'prepared',
          approvedAt: '2026-01-01T12:05:00.000Z',
          approvalCurrent: false,
          interpretationState: 'failed',
          interpretationMessage: 'Workflow processing returned unsupported evidence references.'
        })
      })
    )
    expect(html).toContain('previous version of this review')
    expect(html).toContain('Nothing is sent until you approve this version')
    expect(html).toContain('does not need to be made again')
    expect(html).toContain('Approve and send for interpretation')
  })

  it('a current approval shows no re-review warning', () => {
    const html = render(
      viewProps({ summary: summary({ approvedAt: '2026-01-01T12:05:00.000Z', approvalCurrent: true }) })
    )
    expect(html).not.toContain('previous version of this review')
  })
})

describe('privacy panel', () => {
  it('claims transfer history only from an approval receipt', () => {
    expect(privacyStatusText(null)).toMatch(/unknown/)
    expect(privacyStatusText(summary())).toMatch(/unknown/)
    expect(
      privacyStatusText(summary({ approvedAt: '2026-01-01T12:05:00.000Z', approvedModel: 'm' }))
    ).toMatch(/sent to OpenAI \(m\) for interpretation after your approval/)
  })
})

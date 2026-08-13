import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type PolishedSession, type TelemetryEvent } from '../../shared/telemetry/schema'
import { extractAddresses, parameterizePath, resolveAddressTemplate } from './addresses'

function evt(
  partial: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'type' | 'eventId' | 'sequence'>
): TelemetryEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: 'tsess_addr',
    timestamp: new Date(Date.UTC(2026, 6, 29, 12, 0, partial.sequence)).toISOString(),
    elapsedMs: partial.sequence * 1000,
    ...partial
  }
}

const emptyPolished: PolishedSession = {
  sessionId: 'tsess_addr',
  schemaVersion: SCHEMA_VERSION,
  polishedAt: '2026-07-29T12:00:00.000Z',
  sequenceRange: { min: 0, max: 0 },
  actions: []
}

describe('parameterizePath', () => {
  it('slots Google Sheet ids as {sheet_id}', () => {
    const r = parameterizePath('/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit')
    expect(r.templatePath).toBe('/spreadsheets/d/{sheet_id}/edit')
    expect(r.params.sheet_id).toMatch(/^1Bxi/)
    expect(r.needsReview).toBe(false)
  })

  it('slots Figma design ids', () => {
    const r = parameterizePath('/design/abc123XYZ999/Gray-UI')
    expect(r.templatePath).toBe('/design/{file_id}/Gray-UI')
    expect(r.params.file_id).toBe('abc123XYZ999')
  })

  it('flags high-entropy unclassified segments for review', () => {
    const r = parameterizePath('/widget/a1b2c3d4e5f6g7h8i9j0k1l2/view')
    expect(r.needsReview).toBe(true)
    expect(r.templatePath).toContain('a1b2c3d4e5f6g7h8i9j0k1l2')
  })
})

describe('extractAddresses', () => {
  it('extracts navigation URLs with verify predicates and auto policy for docs.google.com', () => {
    const events = [
      evt({
        type: 'navigation',
        eventId: 'e1',
        sequence: 1,
        data: {
          appName: 'Google Chrome',
          urlHost: 'docs.google.com',
          urlPath: '/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit',
          documentTitle: 'Invoices',
          headings: ['Invoices', 'Sheet1'],
          buttons: ['Share', 'Export']
        }
      })
    ]
    const addrs = extractAddresses(events, emptyPolished)
    expect(addrs).toHaveLength(1)
    expect(addrs[0]!.kind).toBe('url')
    expect(addrs[0]!.template).toContain('/spreadsheets/d/{sheet_id}/edit')
    expect(addrs[0]!.params?.find((p) => p.key === 'sheet_id')?.value).toBeTruthy()
    expect(addrs[0]!.policy).toBe('auto')
    expect(addrs[0]!.verify.urlMatches).toContain('docs.google.com')
    expect(addrs[0]!.verify.elementPresent?.text).toBe('Invoices')
  })

  it('uses assist policy for auth-likely hosts', () => {
    const events = [
      evt({
        type: 'navigation',
        eventId: 'e1',
        sequence: 1,
        data: {
          urlHost: 'accounts.google.com',
          urlPath: '/signin/v2/identifier',
          headings: ['Sign in']
        }
      })
    ]
    const addrs = extractAddresses(events, emptyPolished)
    expect(addrs[0]!.policy).toBe('assist')
  })

  it('never stores rejected credential URLs', () => {
    const events = [
      evt({
        type: 'download',
        eventId: 'e1',
        sequence: 1,
        data: {
          downloadSourceUrl: 'https://example.com/callback?access_token=secrettokenvalue1234567890'
        }
      })
    ]
    expect(extractAddresses(events, emptyPolished)).toHaveLength(0)
  })

  it('extracts file paths from downloads and file dialogs', () => {
    const events = [
      evt({
        type: 'file_dialog',
        eventId: 'e1',
        sequence: 1,
        data: {
          filePath: '/Users/ben/Downloads/report.csv',
          fileName: 'report.csv',
          fileDialogKind: 'open'
        }
      }),
      evt({
        type: 'download',
        eventId: 'e2',
        sequence: 2,
        data: {
          filePath: '/Users/ben/Downloads/out.pdf',
          fileName: 'out.pdf',
          downloadSourceUrl: 'https://drive.google.com/uc?id=1safexampleid0001&export=download'
        }
      })
    ]
    const addrs = extractAddresses(events, emptyPolished)
    expect(addrs.some((a) => a.kind === 'file')).toBe(true)
    expect(addrs.some((a) => a.kind === 'url' && a.template.includes('drive.google.com'))).toBe(true)
    for (const a of addrs) {
      expect(a.verify).toBeTruthy()
      expect(a.verify.urlMatches != null || a.verify.elementPresent != null).toBe(true)
    }
  })

  it('extracts urlHost from documentTitle when urlHost is missing', () => {
    const events = [
      evt({
        type: 'click',
        eventId: 'e1',
        sequence: 1,
        data: {
          appName: 'Google Chrome',
          documentTitle: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit'
        }
      })
    ]
    const addrs = extractAddresses(events, emptyPolished)
    expect(addrs).toHaveLength(1)
    expect(addrs[0]!.template).toContain('docs.google.com')
    expect(addrs[0]!.template).toContain('{sheet_id}')
  })

  it('dedupes identical templates', () => {
    const events = [
      evt({
        type: 'navigation',
        eventId: 'e1',
        sequence: 1,
        data: { urlHost: 'figma.com', urlPath: '/design/abc123XYZ999/File' }
      }),
      evt({
        type: 'app_switch',
        eventId: 'e2',
        sequence: 2,
        data: { urlHost: 'figma.com', urlPath: '/design/abc123XYZ999/File' }
      })
    ]
    expect(extractAddresses(events, emptyPolished)).toHaveLength(1)
  })
})

describe('resolveAddressTemplate', () => {
  it('fills param slots', () => {
    expect(
      resolveAddressTemplate('https://docs.google.com/spreadsheets/d/{sheet_id}/edit', {
        sheet_id: 'ABC'
      })
    ).toBe('https://docs.google.com/spreadsheets/d/ABC/edit')
  })
})

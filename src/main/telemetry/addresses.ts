import {
  type Address,
  type AddressKind,
  type AddressVerify,
  type PolishedSession,
  type ResolutionPolicy,
  type TelemetryEvent
} from '../../shared/telemetry/schema'
import { sanitizeUrl, truncate } from '../../shared/telemetry/sanitize'

const MAX_ADDRESSES = 20

/** Hosts where navigation is usually safe to auto-resolve. */
const AUTO_HOSTS = new Set([
  'docs.google.com',
  'drive.google.com',
  'sheets.google.com',
  'slides.google.com',
  'calendar.google.com',
  'www.notion.so',
  'notion.so',
  'www.figma.com',
  'figma.com',
  'github.com',
  'www.github.com',
  'linear.app',
  'www.linear.app',
  'app.slack.com'
])

/** Host / path patterns that imply auth / identity — prefer assist. */
const AUTH_HOST_RE =
  /^(accounts\.|login\.|auth\.|sso\.|signin\.|id\.|oauth\.)|(^|\.)okta\.com$|(^|\.)auth0\.com$|login\.microsoftonline\.com|github\.com\/login|accounts\.google\.com/i

/** Known path ID slots — segment immediately after the marker becomes a named param. */
const KNOWN_ID_MARKERS: Array<{ marker: string; param: string }> = [
  { marker: 'spreadsheets/d', param: 'sheet_id' },
  { marker: 'document/d', param: 'doc_id' },
  { marker: 'presentation/d', param: 'slide_id' },
  { marker: 'file/d', param: 'file_id' },
  { marker: 'design', param: 'file_id' },
  { marker: 'file', param: 'file_id' },
  { marker: 'board', param: 'board_id' },
  { marker: 'issue', param: 'issue_id' },
  { marker: 'issues', param: 'issue_id' },
  { marker: 'pull', param: 'pr_id' },
  { marker: 'pulls', param: 'pr_id' }
]

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MONGO_OID_RE = /^[0-9a-f]{24}$/i
/** Alphanumeric id-like tokens (mixed charset or long hex). */
const ID_LIKE_RE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{8,}$|^[A-Fa-f0-9]{16,}$/

type RawCandidate = {
  kind: AddressKind
  host?: string
  path?: string
  query?: string
  filePath?: string
  eventId: string
  appName?: string
  documentTitle?: string
  headings: string[]
  buttons: string[]
}

/**
 * Deterministic address extraction from L0 events (+ polished context for labels).
 * Never stores rejected URLs. Every address includes a verify predicate.
 */
export function extractAddresses(
  events: TelemetryEvent[],
  polished: PolishedSession
): Address[] {
  const candidates: RawCandidate[] = []

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!
    if (e.type === 'navigation' || e.type === 'app_switch') {
      const host = e.data?.urlHost
      const path = e.data?.urlPath
      // Host/path were already sanitized at capture — do not re-reject stable record ids.
      if (host) {
        candidates.push({
          kind: 'url',
          host,
          path,
          query: e.data?.urlQuery,
          eventId: e.eventId,
          appName: e.data?.appName,
          documentTitle: e.data?.documentTitle ?? e.data?.windowTitle,
          headings: nearbyHeadings(events, i),
          buttons: nearbyButtons(events, i)
        })
      }
    }

    if (e.type === 'download') {
      const source = e.data?.downloadSourceUrl
      if (source) {
        const sanitized = sanitizeUrl(source)
        if (!sanitized.rejected && sanitized.urlHost) {
          candidates.push({
            kind: 'url',
            host: sanitized.urlHost,
            path: sanitized.urlPath,
            query: sanitized.urlQuery,
            eventId: e.eventId,
            appName: e.data?.appName,
            documentTitle: e.data?.documentTitle,
            headings: nearbyHeadings(events, i),
            buttons: nearbyButtons(events, i)
          })
        }
      }
      if (e.data?.filePath) {
        candidates.push({
          kind: 'file',
          filePath: e.data.filePath,
          eventId: e.eventId,
          appName: e.data?.appName,
          documentTitle: e.data?.fileName ?? e.data?.documentTitle,
          headings: nearbyHeadings(events, i),
          buttons: nearbyButtons(events, i)
        })
      }
    }

    if (e.type === 'file_dialog' && e.data?.filePath) {
      candidates.push({
        kind: 'file',
        filePath: e.data.filePath,
        eventId: e.eventId,
        appName: e.data?.appName,
        documentTitle: e.data?.fileName ?? e.data?.documentTitle,
        headings: nearbyHeadings(events, i),
        buttons: nearbyButtons(events, i)
      })
    }
  }

  // Clipboard URL destinations are addresses when navigation missed them.
  for (const a of polished.actions) {
    if (a.category !== 'clipboard' || a.clipboard?.contentType !== 'url') continue
    const host = a.clipboard.urlHost
    if (!host) continue
    const path = a.clipboard.urlPath
    const already = candidates.some(
      (c) => c.kind === 'url' && c.host === host && (c.path ?? '/') === (path ?? '/')
    )
    if (already) continue
    candidates.push({
      kind: 'url',
      host,
      path,
      query: a.clipboard.urlQuery,
      eventId: a.sourceEventIds[0] ?? `clip_${a.order}`,
      appName: a.appName,
      documentTitle: a.documentTitle,
      headings: [],
      buttons: a.elementLabel ? [a.elementLabel] : []
    })
  }

  const out: Address[] = []
  const seen = new Set<string>()

  for (const c of candidates) {
    if (out.length >= MAX_ADDRESSES) break
    const built = c.kind === 'file' ? buildFileAddress(c, out.length) : buildUrlAddress(c, out.length)
    if (!built) continue
    const dedupeKey = `${built.kind}|${built.template}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push(built)
  }

  return out
}

function nearbyHeadings(events: TelemetryEvent[], index: number): string[] {
  const out: string[] = []
  for (let j = index; j < Math.min(events.length, index + 6); j++) {
    for (const h of events[j]?.data?.headings ?? []) {
      if (h && !out.includes(h)) out.push(h)
      if (out.length >= 4) return out
    }
  }
  return out
}

function nearbyButtons(events: TelemetryEvent[], index: number): string[] {
  const out: string[] = []
  for (let j = index; j < Math.min(events.length, index + 6); j++) {
    for (const b of events[j]?.data?.buttons ?? []) {
      if (b && !out.includes(b)) out.push(b)
      if (out.length >= 4) return out
    }
  }
  return out
}

function buildUrlAddress(c: RawCandidate, index: number): Address | null {
  if (!c.host) return null
  const path = c.path && c.path !== '/' ? c.path : ''
  const { templatePath, params, needsReview, stability } = parameterizePath(path, c.host)
  const querySuffix = c.query ? `?${stripVolatileQuery(c.query)}` : ''
  const template = truncate(`https://${c.host}${templatePath || '/'}${querySuffix}`, 500)
  if (!template) return null

  const verify = buildVerify(c, templatePath || '/')
  const policy = resolvePolicy(c.host)
  const id = `addr_${index + 1}`

  return {
    id,
    kind: 'url',
    template,
    params: Object.keys(params).length ? params : null,
    identityAccount: null,
    identityProvider: identityProviderForHost(c.host),
    stability,
    verify,
    fallback: null,
    health: null,
    policy,
    needsReview: needsReview || null
  }
}

function buildFileAddress(c: RawCandidate, index: number): Address | null {
  const raw = c.filePath
  if (!raw) return null
  const { template, params, needsReview } = parameterizeFilePath(raw)
  const truncated = truncate(template, 500)
  if (!truncated) return null

  const fileName = c.documentTitle || raw.split('/').pop() || 'file'
  const verify: AddressVerify = {
    urlMatches: null,
    elementPresent: {
      text: truncate(fileName, 120) ?? null,
      role: null
    },
    accountIndicator: null
  }

  return {
    id: `addr_${index + 1}`,
    kind: 'file',
    template: truncated,
    params: Object.keys(params).length ? params : null,
    identityAccount: null,
    identityProvider: null,
    stability: needsReview ? 'low' : 'medium',
    verify,
    fallback: null,
    health: null,
    policy: 'assist',
    needsReview: needsReview || null
  }
}

export function parameterizePath(
  path: string,
  host?: string
): {
  templatePath: string
  params: Record<string, string>
  needsReview: boolean
  stability: 'high' | 'medium' | 'low'
} {
  if (!path || path === '/') {
    return { templatePath: path || '/', params: {}, needsReview: false, stability: 'high' }
  }

  const segments = path.split('/').filter((s) => s.length > 0)
  const params: Record<string, string> = {}
  const out: string[] = []
  let needsReview = false
  let slotted = false

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!

    // Multi-segment markers: spreadsheets/d/{sheet_id}
    const pair = i + 1 < segments.length ? `${seg}/${segments[i + 1]}` : ''
    const multi = KNOWN_ID_MARKERS.find((m) => m.marker.includes('/') && pair === m.marker)
    if (multi && i + 2 < segments.length) {
      out.push(seg, segments[i + 1]!)
      const idSeg = segments[i + 2]!
      const key = uniqueParamKey(multi.param, params)
      params[key] = idSeg
      out.push(`{${key}}`)
      i += 2
      slotted = true
      continue
    }

    // Single markers: design/{file_id}
    const single = KNOWN_ID_MARKERS.find(
      (m) => !m.marker.includes('/') && seg.toLowerCase() === m.marker && i + 1 < segments.length
    )
    if (single) {
      const idSeg = segments[i + 1]!
      if (ID_LIKE_RE.test(idSeg) || UUID_RE.test(idSeg) || MONGO_OID_RE.test(idSeg) || idSeg.length >= 8) {
        out.push(seg)
        const key = uniqueParamKey(single.param, params)
        params[key] = idSeg
        out.push(`{${key}}`)
        i += 1
        slotted = true
        continue
      }
    }

    if (UUID_RE.test(seg) || MONGO_OID_RE.test(seg)) {
      const key = uniqueParamKey('id', params)
      params[key] = seg
      out.push(`{${key}}`)
      slotted = true
      continue
    }

    if (ID_LIKE_RE.test(seg) && seg.length >= 10) {
      const classified = classifyIdSegment(seg, segments[i - 1], host)
      if (classified) {
        const key = uniqueParamKey(classified, params)
        params[key] = seg
        out.push(`{${key}}`)
        slotted = true
      } else {
        out.push(seg)
        needsReview = true
      }
      continue
    }

    out.push(seg)
  }

  const templatePath = '/' + out.join('/')
  const stability: 'high' | 'medium' | 'low' = needsReview
    ? 'low'
    : slotted
      ? 'medium'
      : 'high'

  return { templatePath, params, needsReview, stability }
}

function classifyIdSegment(seg: string, prev?: string, host?: string): string | null {
  const p = (prev ?? '').toLowerCase()
  if (p === 'd' || p === 'spreadsheets') return 'sheet_id'
  if (p === 'document') return 'doc_id'
  if (p === 'design' || p === 'file') return 'file_id'
  if (host?.includes('docs.google.com') && p === 'd') return 'doc_id'
  if (host?.includes('spreadsheets') || host?.includes('sheets.google')) return 'sheet_id'
  if (UUID_RE.test(seg) || MONGO_OID_RE.test(seg)) return 'id'
  // Unclassified high-entropy segments stay literal + needsReview (caller).
  return null
}

function uniqueParamKey(base: string, params: Record<string, string>): string {
  if (!(base in params)) return base
  let n = 2
  while (`${base}_${n}` in params) n++
  return `${base}_${n}`
}

function parameterizeFilePath(path: string): {
  template: string
  params: Record<string, string>
  needsReview: boolean
} {
  const params: Record<string, string> = {}
  let needsReview = false
  let template = path

  // Parameterize home directory.
  const home = template.match(/^(\/Users\/[^/]+)(\/.*)?$/)
  if (home) {
    params.home = home[1]!
    template = `{home}${home[2] ?? ''}`
  }

  const parts = template.split('/')
  const out = parts.map((seg) => {
    if (!seg || seg.startsWith('{')) return seg
    if (UUID_RE.test(seg) || (ID_LIKE_RE.test(seg) && seg.length >= 16)) {
      const classified = classifyIdSegment(seg)
      if (classified) {
        const key = uniqueParamKey(classified, params)
        params[key] = seg
        return `{${key}}`
      }
      needsReview = true
    }
    return seg
  })
  return { template: out.join('/'), params, needsReview }
}

function stripVolatileQuery(query: string): string {
  // Already tracking-stripped by sanitizeUrl; keep as-is but bound length.
  return query.slice(0, 300)
}

function buildVerify(c: RawCandidate, templatePath: string): AddressVerify {
  const patternPath = templatePath.replace(/\{[^}]+\}/g, '*')
  const urlMatches = truncate(`https://${c.host}${patternPath}`, 300) ?? null

  const anchorText =
    c.headings[0] ||
    c.buttons.find((b) => !/^(sign in|log in|next|ok|cancel|close)$/i.test(b)) ||
    c.documentTitle ||
    null

  const elementPresent = anchorText
    ? {
        text: truncate(anchorText, 120) ?? null,
        role: c.buttons.includes(anchorText) ? 'AXButton' : null
      }
    : {
        // Mandatory verify — fall back to host label so the field is never empty of intent.
        text: truncate(c.host?.replace(/^www\./, '') ?? 'page', 120) ?? null,
        role: null
      }

  return {
    urlMatches,
    elementPresent,
    accountIndicator: null
  }
}

function resolvePolicy(host: string): ResolutionPolicy {
  const h = host.toLowerCase()
  if (AUTH_HOST_RE.test(h)) return 'assist'
  if (AUTO_HOSTS.has(h) || AUTO_HOSTS.has(h.replace(/^www\./, ''))) return 'auto'
  return 'assist'
}

function identityProviderForHost(host: string): string | null {
  const h = host.toLowerCase()
  if (h.includes('google.com')) return 'google'
  if (h.includes('github.com')) return 'github'
  if (h.includes('microsoft') || h.includes('office.com') || h.includes('live.com')) {
    return 'microsoft'
  }
  if (h.includes('okta.com')) return 'okta'
  return null
}

/** Fill `{param}` slots in an address template for compile/runtime. */
export function resolveAddressTemplate(
  template: string,
  params: Record<string, string> | null | undefined
): string {
  if (!params) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => params[key] ?? `{${key}}`)
}

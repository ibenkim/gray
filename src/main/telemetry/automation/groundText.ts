import type { PolishedAction, PolishedSession } from '../../../shared/telemetry/schema'

/** Pull the user query out of a search-results window title. */
export function searchQueryFromTitle(title?: string | null): string | null {
  if (!title) return null
  const m = title.match(
    /^(.*?)\s+-\s+(Google Search|Bing|DuckDuckGo|Yahoo Search|Search)\s*$/i
  )
  const q = m?.[1]?.trim()
  return q || null
}

export function normalizeLiteral(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Typed text that may be replayed: the committed field value, never key reconstruction. */
export function exactTypedText(a: PolishedAction): string | null {
  return a.textQuality === 'exact' && a.typedText?.trim() ? a.typedText.trim() : null
}

/** Literals the compiler may replay — only exact evidence, never model invention. */
export function allowedLiteralsFromPolished(polished: PolishedSession): Set<string> {
  const out = new Set<string>()
  for (const a of polished.actions) {
    const typed = exactTypedText(a)
    if (typed) out.add(typed)
    const q = searchQueryFromTitle(a.documentTitle)
    if (q) out.add(q)
  }
  return out
}

export function isAllowedLiteral(text: string, allowed: Set<string>): boolean {
  if (allowed.has(text)) return true
  const n = normalizeLiteral(text)
  for (const a of allowed) {
    if (normalizeLiteral(a) === n) return true
  }
  return false
}

/**
 * Prefer the final search query from a results-page title when present;
 * otherwise the last typedText cited by the evidence ids.
 */
export function pickLiteralFromEvidence(
  evidenceIds: string[],
  byEvent: Map<string, PolishedAction>
): string | null {
  let lastTyped: string | null = null
  let searchQuery: string | null = null
  for (const id of evidenceIds) {
    const a = byEvent.get(id)
    if (!a) continue
    const typed = exactTypedText(a)
    if (typed) lastTyped = typed
    const q = searchQueryFromTitle(a.documentTitle)
    if (q) searchQuery = q
  }
  return searchQuery ?? lastTyped
}

/** Shell valueTail / typedText that is clearly prompt or command-output noise. */
export function looksLikeShellNoise(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.length > 120) return true
  if (/@[\w.-]+/.test(t) && /(%\s*$|\$\s*$)/.test(t)) return true
  if (/\(.venv\)/i.test(t)) return true
  if (/command not found|not found:/i.test(t)) return true
  if (/^[\w.-]+@[\w.-]+\s/.test(t)) return true
  return false
}

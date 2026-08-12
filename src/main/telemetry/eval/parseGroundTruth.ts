import { IntentVerbSchema, type IntentVerb } from '../../../shared/telemetry/schema'
import type { GroundTruth, GroundTruthStep } from './types'

const INTENT_SET = new Set<string>(IntentVerbSchema.options)

function asIntent(raw: string): IntentVerb | string {
  const trimmed = raw.trim()
  if (INTENT_SET.has(trimmed)) return trimmed as IntentVerb
  // Allow "Locate — ..." style where verb is first token
  const first = trimmed.split(/\s+/)[0] ?? trimmed
  if (INTENT_SET.has(first)) return first as IntentVerb
  return trimmed
}

function emptyGroundTruth(): GroundTruth {
  return { steps: [], variables: [], branches: [], questions: [] }
}

function parseJsonGroundTruth(text: string): GroundTruth | null {
  try {
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    const stepsRaw = Array.isArray(obj.steps) ? obj.steps : []
    const steps: GroundTruthStep[] = stepsRaw.map((s) => {
      const row = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>
      const intent = typeof row.intent === 'string' ? asIntent(row.intent) : ''
      const summary = typeof row.summary === 'string' ? row.summary : ''
      const position =
        row.position && typeof row.position === 'object'
          ? {
              strategy: String(
                (row.position as { strategy?: unknown }).strategy ?? ''
              )
            }
          : null
      return { intent, summary, position }
    })
    const list = (key: string): string[] =>
      Array.isArray(obj[key])
        ? (obj[key] as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
    return {
      steps,
      variables: list('variables'),
      branches: list('branches'),
      questions: list('questions')
    }
  } catch {
    return null
  }
}

/**
 * Parse ground_truth.md (simple headings) or a JSON document with the same shape.
 */
export function parseGroundTruth(text: string): GroundTruth {
  const trimmed = text.trim()
  if (!trimmed) return emptyGroundTruth()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const fromJson = parseJsonGroundTruth(trimmed)
    if (fromJson) return fromJson
  }

  const gt = emptyGroundTruth()
  type Section = 'steps' | 'variables' | 'branches' | 'questions' | null
  let section: Section = null

  for (const line of trimmed.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(Steps|Variables|Branches|Questions)\s*$/i)
    if (heading) {
      const name = heading[1]!.toLowerCase()
      section =
        name === 'steps'
          ? 'steps'
          : name === 'variables'
            ? 'variables'
            : name === 'branches'
              ? 'branches'
              : 'questions'
      continue
    }
    if (!section) continue
    const content = line.trim()
    if (!content || content.startsWith('#')) continue

    if (section === 'steps') {
      // "1. Locate — Find the invoice email" or "1. Locate - Find..."
      const m = content.match(/^\d+\.\s*(.+)$/)
      const body = (m?.[1] ?? content).trim()
      const split = body.match(/^([A-Za-z]+)\s*[—–\-:]\s*(.+)$/)
      if (split) {
        gt.steps.push({
          intent: asIntent(split[1]!),
          summary: split[2]!.trim()
        })
      } else {
        const parts = body.split(/\s+/)
        const intent = asIntent(parts[0] ?? body)
        const summary = parts.slice(1).join(' ').trim() || body
        gt.steps.push({ intent, summary })
      }
      continue
    }

    const bullet = content.replace(/^[-*]\s+/, '').trim()
    if (!bullet) continue
    if (section === 'variables') gt.variables.push(bullet)
    else if (section === 'branches') gt.branches.push(bullet)
    else if (section === 'questions') gt.questions.push(bullet)
  }

  return gt
}

import type { AddressHealth, RunFailureCode } from '../../../shared/telemetry/schema'

export type RunMetricRecord = {
  /** True when the run finished with outcome done / success. */
  success: boolean
  resolution?: { tier1: number; tier2: number }
  /** Number of auto-repair attempts used during the run (0 if none). */
  repairAttempts?: number
  /** True when the run held for user repair or exhausted the repair budget. */
  repaired?: boolean
  failureCode?: RunFailureCode | string | null
  addresses?: Array<{ id: string; health: AddressHealth | null | undefined }>
}

export type AggregatedRunMetrics = {
  successRate: number | null
  tierDistribution: { tier1: number; tier2: number; total: number }
  /** Fraction of runs that used at least one repair (or repaired=true). */
  repairRate: number | null
  failureDistribution: Record<string, number>
  addressHealth: Record<
    string,
    { attempts: number; successes: number; successRate: number | null; lastOk: string | null }
  >
}

/**
 * Aggregate automation run metrics across a batch of eval runs.
 */
export function aggregateRunMetrics(runs: RunMetricRecord[]): AggregatedRunMetrics {
  if (runs.length === 0) {
    return {
      successRate: null,
      tierDistribution: { tier1: 0, tier2: 0, total: 0 },
      repairRate: null,
      failureDistribution: {},
      addressHealth: {}
    }
  }

  let successes = 0
  let tier1 = 0
  let tier2 = 0
  let repairedRuns = 0
  const failureDistribution: Record<string, number> = {}
  const addressHealth: AggregatedRunMetrics['addressHealth'] = {}

  for (const run of runs) {
    if (run.success) successes += 1
    if (run.resolution) {
      tier1 += run.resolution.tier1
      tier2 += run.resolution.tier2
    }
    const usedRepair =
      run.repaired === true || (typeof run.repairAttempts === 'number' && run.repairAttempts > 0)
    if (usedRepair) repairedRuns += 1
    if (run.failureCode) {
      const key = String(run.failureCode)
      failureDistribution[key] = (failureDistribution[key] ?? 0) + 1
    }
    for (const addr of run.addresses ?? []) {
      if (!addr.id) continue
      const h = addr.health
      const prev = addressHealth[addr.id] ?? {
        attempts: 0,
        successes: 0,
        successRate: null,
        lastOk: null
      }
      const attempts = prev.attempts + (h?.attempts ?? 0)
      const succ = prev.successes + (h?.successes ?? 0)
      const lastOk = h?.lastOk && (!prev.lastOk || h.lastOk > prev.lastOk) ? h.lastOk : prev.lastOk
      addressHealth[addr.id] = {
        attempts,
        successes: succ,
        successRate: attempts === 0 ? null : succ / attempts,
        lastOk
      }
    }
  }

  return {
    successRate: successes / runs.length,
    tierDistribution: { tier1, tier2, total: tier1 + tier2 },
    repairRate: repairedRuns / runs.length,
    failureDistribution,
    addressHealth
  }
}

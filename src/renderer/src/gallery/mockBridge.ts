/**
 * Design-gallery bridge: a stand-in for `window.grayBridge` so real surfaces render in a
 * plain browser. Every method resolves; a few return sample data. Never loaded by the app.
 */
import { createSeedSnapshot, SEED_ACTIVITY, SEED_RUNS, SEED_SUGGESTION, SEED_WORKFLOWS } from '../../../shared/seed'
import { mergeComingUp } from '../../../shared/activity'
import type { PermissionsState, StoreSnapshot, Team } from '../../../shared/types'
import { PORTFOLIO_WORKFLOWS } from './sampleData'

type Listener = (...args: unknown[]) => void

export type MockOptions = {
  snapshot?: Partial<StoreSnapshot>
  permissions?: PermissionsState
  /** Reports the pill window bounds the renderer asks for (live pill scenarios). */
  onBounds?: (w: number, h: number) => void
}

const listeners = new Map<string, Set<Listener>>()

/** Fire a bridge event (e.g. `onOpenEditor`) from a scenario driver. */
export function emitBridge(name: string, ...args: unknown[]) {
  for (const cb of listeners.get(name) ?? []) cb(...args)
}

export const OWNER_TEAM: Team = {
  id: 'team_ghost',
  name: 'Ghost Studio',
  memberCount: 3,
  role: 'owner',
  members: [
    { id: 'm1', name: 'Ryland William Hoskins the Third', role: 'owner', isSelf: true },
    { id: 'm2', name: 'Harry Kang', role: 'member', email: 'harry@ghoststudio.co' },
    { id: 'm3', name: 'Minhyeok Benjamin Ben Kim', role: 'member' }
  ],
  invites: [
    {
      id: 'inv1',
      email: 'kate@studio.co',
      invitedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      code: 'GHOST-KATE'
    }
  ]
}

export function demoSnapshot(): StoreSnapshot {
  const base = createSeedSnapshot()
  return {
    ...base,
    workflows: [...PORTFOLIO_WORKFLOWS, ...SEED_WORKFLOWS.slice(1, 2)],
    runs: SEED_RUNS.map((r) => (r.workflowId === 'w1' ? { ...r, workflowId: 'p1' } : r)),
    activity: mergeComingUp(SEED_ACTIVITY, [...PORTFOLIO_WORKFLOWS]),
    suggestion: SEED_SUGGESTION,
    onboardingComplete: true,
    session: { email: 'harry@ghoststudio.co', displayName: 'Harry Kang' }
  }
}

export function installMockBridge(opts: MockOptions = {}) {
  const snapshot: StoreSnapshot = { ...demoSnapshot(), ...opts.snapshot }
  const permissions: PermissionsState = opts.permissions ?? {
    screen: 'granted',
    accessibility: 'granted',
    microphone: 'granted'
  }

  const known: Record<string, (...args: never[]) => unknown> = {
    getSnapshot: async () => snapshot,
    getPermissions: async () => permissions,
    requestPermission: async () => permissions,
    telemetryListRecordings: async () => [],
    getTelemetryStatus: async () => ({ recording: false }),
    getRun: async (id: string) => snapshot.runs.find((r) => r.id === id) ?? null,
    getWorkflow: async (id: string) => snapshot.workflows.find((w) => w.id === id) ?? null,
    upsertWorkflow: async () => snapshot,
    setBounds: async (w: number, h: number) => {
      opts.onBounds?.(w, h)
      return { placement: 'above', generation: 1, current: true }
    },
    openDropdown: async () => ({ generation: 1, current: true, open: false, placement: 'above', bounds: null }),
    closeDropdown: async () => null,
    setOnboardingSize: async (w: number, h: number) => opts.onBounds?.(w, h),
    dragStart: async () => null,
    dragEnd: async () => true
  }

  window.grayBridge = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in known) return known[prop]
        if (prop.startsWith('on')) {
          return (cb: Listener) => {
            if (!listeners.has(prop)) listeners.set(prop, new Set())
            listeners.get(prop)!.add(cb)
            return () => listeners.get(prop)?.delete(cb)
          }
        }
        return async () => undefined
      }
    }
  ) as typeof window.grayBridge
}

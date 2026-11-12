import { BUILD, type BuildStamp } from '../../shared/build'

/** M4: tell main this renderer's build stamp. Diagnostics never block mount (a stale preload may lack it). */
export function reportBuild(bridge: { reportBuild?: (stamp: BuildStamp) => void } | undefined, stamp: BuildStamp = BUILD): void {
  try {
    bridge?.reportBuild?.(stamp)
  } catch {
    /* identity reporting is optional */
  }
}

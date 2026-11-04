export type BuildStamp = { version: string; sha: string; dirty: boolean; builtAt: string }

/** Stamped at build time by electron.vite.config.ts into main, preload and renderer (M4). */
declare const __GRAY_BUILD__: BuildStamp | undefined

export const BUILD: BuildStamp =
  typeof __GRAY_BUILD__ === 'undefined' ? { version: 'unknown', sha: 'unbuilt', dirty: false, builtAt: '' } : __GRAY_BUILD__

export function stampLabel(b: BuildStamp): string {
  return `${b.sha.slice(0, 7)}${b.dirty ? '+dirty' : ''} built ${b.builtAt || 'unknown'}`
}

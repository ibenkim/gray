import { useEffect, useState } from 'react'
import type { RecordDropdownCommand, RecordDropdownSnapshot } from '../../../shared/types'
import RecordDropdown from '../components/RecordDropdown'

/** The installed apps' icons from the gallery dev server (vite.gallery.config.ts). */
export async function galleryAppIcons(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(`/__app-icon/${id}`)
        if (!res.ok) return
        const blob = await res.blob()
        out[id] = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      } catch {
        // Not installed or not on macOS: the row keeps its bundled logo.
      }
    })
  )
  return out
}

/** Gallery-only hook: the installed icons for a fixed list of ids (null while loading). */
export function useGalleryAppIcons(ids: string[]): Record<string, string> | null {
  const key = ids.join(',')
  const [icons, setIcons] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    let live = true
    void galleryAppIcons(key.split(',')).then((map) => live && setIcons(map))
    return () => {
      live = false
    }
  }, [key])
  return icons
}

const post = (msg: Record<string, unknown>) =>
  window.parent?.postMessage({ gallery: 'dropdown', ...msg }, '*')

/**
 * The Record dropdown as its own window, like Electron's child window: the real RecordDropdown
 * component against a stand-in for main's narrow `grayDropdown` relay. Commands update the
 * snapshot locally; Start and Esc close it through the gallery page.
 */
export function installDropdownMock(id: string): void {
  let snapshot: RecordDropdownSnapshot = {
    revision: 1,
    recordMode: 'one-app',
    selectedAppId: 'chrome',
    selectedAppIds: ['chrome', 'figma'],
    narrate: true,
    apps: [
      { id: 'chrome', name: 'Chrome', detail: 'chatgpt.com' },
      { id: 'figma', name: 'Figma', detail: 'Gray' },
      { id: 'notion', name: 'Notion', detail: 'Today’s notes' }
    ],
    screenGranted: true,
    micGranted: true,
    busy: false
  }
  const listeners = new Set<(s: RecordDropdownSnapshot) => void>()
  const publish = (next: Partial<RecordDropdownSnapshot>) => {
    snapshot = { ...snapshot, ...next, revision: snapshot.revision + 1 }
    listeners.forEach((cb) => cb(snapshot))
  }
  window.grayDropdown = {
    hello: () => listeners.forEach((cb) => cb(snapshot)),
    // Main shows the window once it is laid out; showing it is what plays the open motion.
    ready: () => setTimeout(() => document.dispatchEvent(new Event('visibilitychange')), 0),
    measured: (h: number) => window.parent?.postMessage({ gallery: 'bounds', id, w: 342, h }, '*'),
    command: (cmd: RecordDropdownCommand) => {
      if (cmd.type === 'setRecordMode') publish({ recordMode: cmd.value })
      else if (cmd.type === 'selectApp') publish({ selectedAppId: cmd.value, selectedAppIds: [cmd.value] })
      else if (cmd.type === 'toggleApp') {
        const ids = snapshot.selectedAppIds
        const next = ids.includes(cmd.value)
          ? ids.length > 1
            ? ids.filter((x) => x !== cmd.value)
            : ids
          : [...ids, cmd.value]
        publish({ selectedAppIds: next, selectedAppId: next[0] })
      } else if (cmd.type === 'setNarrate') publish({ narrate: cmd.value })
      else if (cmd.type === 'start') post({ open: false })
    },
    dismiss: () => post({ open: false }),
    dragStart: async () => null,
    dragEnd: async () => true,
    appIcons: galleryAppIcons,
    onSnapshot: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

export default function DropdownFrame() {
  return <RecordDropdown />
}

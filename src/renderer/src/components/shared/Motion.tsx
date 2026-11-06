import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/**
 * Keeps a keyed child mounted while it plays its exit animation. Returns the items to render:
 * the current key (entering/present) and, for `exitMs`, the previous one (exiting).
 */
export function usePresence<K extends string>(key: K | null, exitMs: number) {
  const [items, setItems] = useState<{ key: K; exiting: boolean }[]>(() =>
    key ? [{ key, exiting: false }] : []
  )
  const timers = useRef(new Map<K, ReturnType<typeof setTimeout>>())

  useLayoutEffect(() => {
    setItems((prev) => {
      const next: { key: K; exiting: boolean }[] = []
      for (const it of prev) {
        if (it.key === key) continue
        if (!timers.current.has(it.key)) {
          const k = it.key
          timers.current.set(
            k,
            setTimeout(() => {
              timers.current.delete(k)
              setItems((p) => p.filter((x) => !(x.key === k && x.exiting)))
            }, exitMs)
          )
        }
        next.push({ key: it.key, exiting: true })
      }
      if (key) {
        const t = timers.current.get(key)
        if (t) {
          clearTimeout(t)
          timers.current.delete(key)
        }
        next.push({ key, exiting: false })
      }
      return next
    })
  }, [key, exitMs])

  useLayoutEffect(() => {
    const map = timers.current
    return () => {
      for (const t of map.values()) clearTimeout(t)
      map.clear()
    }
  }, [])

  return items
}

/**
 * A card whose box follows its content: height (and width, when it changes) animate on the
 * Teach "Panel" curve while the content stays pinned to the bottom edge, so new rows rise in
 * from the pill side. Reports the measured content height for window sizing.
 */
export function MorphCard({
  width,
  maxHeight,
  className = '',
  style,
  onMeasure,
  children
}: {
  width: number
  maxHeight?: number
  className?: string
  style?: CSSProperties
  onMeasure?: (height: number) => void
  children: ReactNode
}) {
  const innerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)
  const onMeasureRef = useRef(onMeasure)
  onMeasureRef.current = onMeasure

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const measure = () => {
      // Layout height, not the visual rect: the card may be mid scale-in when it measures.
      const natural = Math.ceil(el.offsetHeight)
      const next = maxHeight ? Math.min(natural, maxHeight) : natural
      setHeight((h) => (h === next ? h : next))
      onMeasureRef.current?.(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [maxHeight])

  return (
    <div
      className={`morph-card ${height == null ? 'morph-card-unsized' : ''} ${className}`}
      style={{ width, height: height ?? undefined, ...style }}
    >
      <div ref={innerRef} className="morph-card-inner" style={{ width, maxHeight }}>
        {children}
      </div>
    </div>
  )
}

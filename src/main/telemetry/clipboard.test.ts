import { describe, expect, it, vi } from 'vitest'
import {
  ClipboardWatcher,
  classifyContent,
  hashContent,
  inferPaste,
  looksSensitive
} from './clipboard'

describe('clipboard helpers', () => {
  it('classifies urls and text', () => {
    expect(classifyContent('https://www.figma.com/file/abc', ['text/plain'])).toBe('url')
    expect(classifyContent('hello world', ['text/plain'])).toBe('text')
    expect(classifyContent('', ['image/png'])).toBe('image')
  })

  it('hashes content stably', () => {
    const a = hashContent('https://figma.com/file/1', ['text/plain'])
    const b = hashContent('https://figma.com/file/1', ['text/plain'])
    const c = hashContent('https://figma.com/file/2', ['text/plain'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('detects sensitive clipboard content', () => {
    expect(looksSensitive('password=hunter2')).toBe(true)
    expect(looksSensitive('sk-abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(looksSensitive('https://figma.com/file/abc')).toBe(false)
  })

  it('infers paste from field char count delta', () => {
    const clip = {
      contentType: 'url' as const,
      urlHost: 'figma.com',
      urlPath: '/file/abc',
      charCount: 40,
      contentHash: 'abc'
    }
    const ok = inferPaste({
      fieldCharCountBefore: 0,
      fieldCharCountAfter: 40,
      clipboard: clip,
      clipboardAt: 1000,
      now: 2000
    })
    expect(ok.matched).toBe(true)

    const late = inferPaste({
      fieldCharCountBefore: 0,
      fieldCharCountAfter: 40,
      clipboard: clip,
      clipboardAt: 1000,
      now: 9000
    })
    expect(late.matched).toBe(false)
  })
})

describe('ClipboardWatcher', () => {
  it('emits clipboard_changed with host/path/query and redacted text under threshold', () => {
    const watcher = new ClipboardWatcher({
      readText: () => '',
      readFormats: () => []
    })

    const first = watcher.ingestText('https://www.figma.com/design/xyz?node-id=1', [
      'text/plain'
    ])
    expect(first).not.toBeNull()
    expect(first!.clipboard.contentType).toBe('url')
    expect(first!.clipboard.urlHost).toBe('www.figma.com')
    expect(first!.clipboard.urlPath).toBe('/design/xyz')
    // Stable query params are kept for address extraction; tracking params are stripped.
    expect(first!.clipboard.urlQuery).toBe('node-id=1')
    expect(first!.clipboard.contentHash).toBeTruthy()
    expect(first!.clipboard.text).toContain('figma.com')

    // Same content → no second emit
    const second = watcher.ingestText('https://www.figma.com/design/xyz?node-id=1', [
      'text/plain'
    ])
    expect(second).toBeNull()
  })

  it('reads only when asked (M3-B): no timer, one read per call, de-duplicated, no raw value', () => {
    vi.useFakeTimers()
    try {
      let reads = 0
      let text = 'synthetic copied text'
      const watcher = new ClipboardWatcher({
        readText: () => {
          reads += 1
          return text
        },
        readFormats: () => ['text/plain']
      })
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(5000)
      expect(reads).toBe(0)
      const first = watcher.readNow()
      expect(reads).toBe(1)
      expect(first).toEqual({ clipboard: expect.objectContaining({ contentType: 'text', text: 'synthetic copied text' }) })
      expect(Object.keys(first!)).toEqual(['clipboard'])
      expect(watcher.readNow()).toBeNull() // unchanged content
      text = 'password=synthetic'
      expect(watcher.readNow()).toBeNull() // sensitive content is never recorded
      watcher.reset()
      text = 'synthetic copied text'
      expect(watcher.readNow()).not.toBeNull() // a new session starts clean
      expect(reads).toBe(4)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects credential-bearing clipboard URLs', () => {
    const watcher = new ClipboardWatcher()
    const result = watcher.ingestText(
      'https://example.com/callback?access_token=supersecrettokenvalue123456789012',
      ['text/plain']
    )
    expect(result).toBeNull()
  })

  it('skips sensitive content', () => {
    const watcher = new ClipboardWatcher()
    const result = watcher.ingestText('api_key=sk-abcdefghijklmnopqrstuvwxyz', ['text/plain'])
    expect(result).toBeNull()
  })
})

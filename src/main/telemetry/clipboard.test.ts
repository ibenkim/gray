import { describe, expect, it } from 'vitest'
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
  it('emits clipboard_changed metadata without raw value in clipboard object', () => {
    const changes: Array<ReturnType<ClipboardWatcher['ingestText']>> = []
    const watcher = new ClipboardWatcher({
      readText: () => '',
      readFormats: () => []
    })
    watcher.start((c) => changes.push(c))

    const first = watcher.ingestText('https://www.figma.com/design/xyz?node-id=1', [
      'text/plain'
    ])
    expect(first).not.toBeNull()
    expect(first!.clipboard.contentType).toBe('url')
    expect(first!.clipboard.urlHost).toBe('www.figma.com')
    expect(first!.clipboard.urlPath).toBe('/design/xyz')
    expect(first!.clipboard.contentHash).toBeTruthy()
    expect(JSON.stringify(first!.clipboard)).not.toContain('node-id')
    expect(JSON.stringify(first!.clipboard)).not.toContain('https://www.figma.com/design/xyz?')

    // Same content → no second emit
    const second = watcher.ingestText('https://www.figma.com/design/xyz?node-id=1', [
      'text/plain'
    ])
    expect(second).toBeNull()

    watcher.stop()
  })

  it('skips sensitive content', () => {
    const watcher = new ClipboardWatcher()
    const result = watcher.ingestText('api_key=sk-abcdefghijklmnopqrstuvwxyz', ['text/plain'])
    expect(result).toBeNull()
  })
})

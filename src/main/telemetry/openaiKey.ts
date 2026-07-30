/**
 * Accept only real-looking keys. Placeholders like `sk-...` count as missing.
 * Never log the key value.
 */
export function normalizeOpenAiApiKey(raw: string | undefined | null): string | null {
  if (!raw) return null
  const key = raw.trim()
  if (!key) return null
  if (/^sk-\.{2,}$/i.test(key) || key === 'sk-...' || /your[_-]?key|changeme|xxx/i.test(key)) {
    return null
  }
  if (!/^sk-[A-Za-z0-9_\-]{16,}$/.test(key)) {
    return null
  }
  return key
}

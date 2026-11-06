import { Fragment } from 'react'

/**
 * Step copy with the emphasis the portfolio uses: values the user picked and destinations
 * read semibold ("Find tasks completed **Oct 5–11**", "Slack → #team-updates").
 * Supports `**bold**` and bolds #channels; everything else is plain text.
 */
export default function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|#[\w-]+)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return <strong key={i}>{part.slice(2, -2)}</strong>
        }
        if (/^#[\w-]+$/.test(part)) return <strong key={i}>{part}</strong>
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}

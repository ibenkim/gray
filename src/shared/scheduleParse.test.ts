import { describe, expect, it } from 'vitest'
import { formatSchedule, parseScheduleText } from './schedule'

describe('parseScheduleText', () => {
  it.each([
    ['Every Monday at 9:00 AM', 'Every Monday at 9:00 A.M.'],
    ['every weekday at 4:30 pm', 'Every weekday at 4:30 P.M.'],
    ['daily at noon', 'Every day at 12:00 P.M.'],
    ['Every week on Thursday at 4:30 P.M.', 'Every Thursday at 4:30 P.M.'],
    ['monthly on the 1st at 9', '1st of each month at 9:00 A.M.'],
    ['every 3 days at 10am', 'Every 3 days at 10:00 A.M.'],
    ['mon and wed 8:15am', 'Every Monday and Wednesday at 8:15 A.M.'],
    ['weekly', 'Every Monday at 9:00 A.M.']
  ])('%s → %s', (input, expected) => {
    const cadence = parseScheduleText(input)
    expect(cadence).not.toBeNull()
    expect(formatSchedule(cadence!)).toBe(expected)
  })

  it('round-trips its own display strings', () => {
    for (const s of ['Every day at 7:00 A.M.', 'Every weekday at 9:00 A.M.', '15th of each month at 6:30 P.M.']) {
      expect(formatSchedule(parseScheduleText(s)!)).toBe(s)
    }
  })

  it('returns null when no schedule is recognised', () => {
    expect(parseScheduleText('whenever new client data is ready')).toBeNull()
    expect(parseScheduleText('')).toBeNull()
  })
})

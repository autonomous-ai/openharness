/**
 * When a search is about, read from its words: "dial last week", "yesterday", "3 days ago",
 * "on monday". The same phrases the desktop's Cmd-P reads (`desktop/lib/state/search_when.dart`);
 * keep the two in step. The phrase becomes a window and is taken out of the words.
 */

export interface SearchWhen {
  from: number
  to: number
  phrase: string
}

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

const PHRASES = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:'
  + '(?<today>today)'
  + '|(?<yesterday>yesterday)'
  + '|(?<thisweek>this week)'
  + '|(?<lastweek>last week)'
  + '|(?<thismonth>this month)'
  + '|(?<lastmonth>last month)'
  + '|(?<few>(?:a )?few days ago|(?:a )?couple(?: of)? days ago)'
  + '|(?<count>\\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (?<unit>days?|weeks?) ago'
  // A weekday only with "on" or "last": "friday deploy" is a harness's name, "on friday" is a time.
  + '|(?<last>last|on) (?<weekday>monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
  + ')(?![\\p{L}\\p{N}])',
  'iu',
)

/** The words with any time phrase taken out, and the window it names (local time). */
export function parseSearchWhen(query: string, now: Date): { words: string; when: SearchWhen | null } {
  const match = PHRASES.exec(query)
  if (!match || match.index === undefined) return { words: query, when: null }
  const groups = match.groups ?? {}
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset).getTime()
  // Monday-first weeks, as the desktop reads them.
  const weekday = (now.getDay() + 6) % 7 + 1
  let from: number
  let to: number
  if (groups.today) [from, to] = [day(0), now.getTime()]
  else if (groups.yesterday) [from, to] = [day(-1), day(0)]
  else if (groups.thisweek) [from, to] = [day(1 - weekday), now.getTime()]
  else if (groups.lastweek) [from, to] = [day(1 - weekday - 7), day(1 - weekday)]
  else if (groups.thismonth) [from, to] = [new Date(now.getFullYear(), now.getMonth()).getTime(), now.getTime()]
  else if (groups.lastmonth) [from, to] = [new Date(now.getFullYear(), now.getMonth() - 1).getTime(), new Date(now.getFullYear(), now.getMonth()).getTime()]
  else if (groups.few) [from, to] = [day(-6), day(-1)]
  else if (groups.count) {
    const parsed = Number.parseInt(groups.count, 10)
    const n = Number.isNaN(parsed) ? NUMBERS[groups.count.toLowerCase()] ?? 1 : parsed
    const weeks = groups.unit.toLowerCase().startsWith('week')
    const back = weeks ? n * 7 : n
    const slack = weeks ? 4 : 1
    ;[from, to] = [day(-back - slack), day(-back + slack + 1)]
  } else {
    const target = WEEKDAYS[groups.weekday.toLowerCase()]
    let back = (now.getDay() - target + 7) % 7
    if (back === 0 && groups.last.toLowerCase() === 'last') back = 7
    ;[from, to] = [day(-back), day(-back + 1)]
  }
  to = Math.min(to, now.getTime())
  const words = `${query.slice(0, match.index)} ${query.slice(match.index + match[0].length)}`.replace(/\s+/g, ' ').trim()
  return { words, when: { from, to, phrase: match[0] } }
}

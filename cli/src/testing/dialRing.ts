import type { DialMessage } from './dialCarousel.js'

/** The rows of `page`'s ring as the dial was last sent it: its last whole list, sent after the last `apps` frame, when
 *  that frame shows the page. */
export function ringOn(messages: DialMessage[], page: string): DialMessage[] | undefined {
  const kinds = messages.map((m) => m.t)
  const shown = kinds.lastIndexOf('apps')
  const begin = kinds.lastIndexOf('agents.begin')
  const end = kinds.lastIndexOf('agents.end')
  if (messages[shown]?.shown !== page || begin < shown || end < begin) return undefined
  return messages.slice(begin, end).filter((m) => m.t === 'agent')
}

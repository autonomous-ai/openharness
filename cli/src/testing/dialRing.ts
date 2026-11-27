import type { DialMessage } from './dialCarousel.js'

/**
 * The rows of `page`'s ring as the dial holds it: its last whole list, when the last `apps` frame shows the page and
 * the list came under a frame showing it too. An `apps` frame replaces only the pages, never the ring
 * (firmware ui_habitat.c `ui_apps_replace`), so a frame that only changed a count, sent after the list, leaves the list
 * on the page; the daemon sends the ring again only when it changed (cableSession.ts `syncAgentsNow`).
 */
export function ringOn(messages: DialMessage[], page: string): DialMessage[] | undefined {
  let shown: unknown
  let under: unknown
  let begin = -1
  let ring: { under: unknown; rows: DialMessage[] } | undefined
  messages.forEach((m, i) => {
    if (m.t === 'apps') shown = m.shown
    else if (m.t === 'agents.begin') { begin = i; under = shown }
    else if (m.t === 'agents.end' && begin >= 0) {
      ring = { under, rows: messages.slice(begin, i).filter((row) => row.t === 'agent') }
      begin = -1
    }
  })
  return shown === page && ring?.under === page ? ring.rows : undefined
}

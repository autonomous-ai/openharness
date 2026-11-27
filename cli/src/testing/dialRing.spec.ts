import { describe, expect, it } from 'vitest'
import type { DialMessage } from './dialCarousel.js'
import { ringOn } from './dialRing.js'

const apps = (shown: string, herdr: number, kitty: number): DialMessage =>
  ({ t: 'apps', shown, apps: [{ id: 'herdr', count: herdr }, { id: 'kitty', count: kitty }] })
const list = (...rows: Array<[string, string]>): DialMessage[] =>
  [{ t: 'agents.begin' }, ...rows.map(([id, host]) => ({ t: 'agent', id, host })), { t: 'agents.end' }]

describe('ringOn', () => {
  it("reads the page's list when a counts-only apps frame came after it", () => {
    // The daemon learns herdr made the terminal and sends herdr's page and its ring, then learns herdr's client runs in
    // kitty: only the counts change, so a lone apps frame follows, and a re-pick of herdr answers `same` with no list.
    const messages = [apps('herdr', 1, 0), ...list(['a1', 'herdr']), apps('herdr', 1, 1)]
    expect(ringOn(messages, 'herdr')).toEqual([{ t: 'agent', id: 'a1', host: 'herdr' }])
  })

  it('reads none when no list came after a frame showing the page', () => {
    expect(ringOn([...list(['a1', 'kitty']), apps('herdr', 1, 1)], 'herdr')).toBeUndefined()
  })

  it("reads none while the page's frame waits for its list, the dial still holding another page's", () => {
    expect(ringOn([apps('kitty', 1, 1), ...list(['a1', 'kitty']), apps('herdr', 1, 1)], 'herdr')).toBeUndefined()
  })
})

// The critique's case for a subscription window's price (package 15 of BUILD.md beside this file). The design's first
// version priced a window by its need against its room, with the need read from the present rate of spend and the tasks in
// hand. Its critique: where three to eight large tasks fill a window, one of them starting or ending swings that price, and
// the plans made with it. This runs that case for the first version's price, for two that were tried after it, and for the
// one the solver has (cli/src/superTabs/assign/schedule.ts priceOf), which reads the window alone.
//
// Run from cli/:  npx tsx ../docs/design/2026-11-11-swarm-allocator/window-price.mts
//
// The case: two subscriptions, each with two builders taking large tasks back to back, K a window: a task spends 80/K
// percent of the window over 600/K minutes, so each subscription is spent at exactly its even pace, where a price of need
// against room is most sensitive. The second subscription's builders start a third of a task after the first's. A pass a
// minute; a builder that ends a task is given its next at that pass and starts it at the one after. At every pass each
// price is worked out for both windows. A model of the price alone: no solver, no plan.
import { priceOf } from '../../../cli/src/superTabs/assign/schedule.ts'

const RESERVE = 20, EVERY = 300
/** What a price may read at a pass: the window, and (the first version's) the rate its tasks spend at and what is given
 *  and not started. */
interface Seen { left: number; until: number; rate: number; given: number }
const share = (need: number, room: number) => need + room > 0 ? need / (need + room) : 0.5
const prices: Record<string, (seen: Seen) => number> = {
  // The first version: need is the present rate to the reset plus what tasks in hand still expect; nothing while it is
  // under four fifths of the room, rising to its top where it reaches the room.
  'first version': s => { const room = Math.max(0, s.left - RESERVE), need = s.rate * s.until + s.given
    return room <= 0 ? 1 : Math.min(1, Math.max(0, (need / room - 0.8) / 0.2)) },
  // The same need with no threshold: need / (need + room).
  'its need, no threshold': s => share(s.rate * s.until + s.given, Math.max(0, s.left - RESERVE)),
  // The window's own record: the rate it was spent at since its reset, to the next.
  'the window\'s own rate': s => { const gone = EVERY - s.until
    return share(gone > 0 ? (100 - s.left) * s.until / gone : (100 - RESERVE) * s.until / EVERY, Math.max(0, s.left - RESERVE)) },
  // The solver's: the even pace's need, from the window alone.
  'the solver\'s': s => priceOf({ name: '5-hour', left: s.left, resetsAt: s.until, every: EVERY }, RESERVE, 0),
}

console.log('Each price, from 0 to 1, where K large tasks fill a window: its largest change between two passes a minute apart, at a task\'s start or end')
console.log('and at any other pass; and how many times in the window the cheaper of the two subscriptions changes (who would get the next task).')
console.log(`K  ${Object.keys(prices).map(name => name.padEnd(30)).join('')}`)
for (let large = 3; large <= 8; large++) {
  const spend = 80 / large, minutes = Math.round(600 / large)
  const row = Object.values(prices).map(price => {
    // A builder: the minute its task in hand ends (none: -1), and the minute it starts the next it was given.
    const subs = [0, 1].map(i => ({ left: 100, builders: [0, 1].map(j => ({ end: -1, next: Math.round(i * minutes / 3 + j * minutes / 2) })) }))
    let atStartOrEnd = 0, otherwise = 0, flips = 0, last: number[] | null = null, cheaper = -1
    for (let now = 0; now < EVERY; now++) {
      let event = false
      for (const b of subs[0]!.builders.concat(subs[1]!.builders)) {
        if (b.end >= 0 && b.end <= now) { b.end = -1; b.next = now + 1; event = true }
        if (b.end < 0 && b.next <= now) { b.end = now + minutes; event = true }
      }
      const at = subs.map(s => price({ left: s.left, until: EVERY - now, rate: s.builders.filter(b => b.end >= 0).length * spend / minutes,
        given: s.builders.filter(b => b.end < 0 && b.next > now).length * spend }))
      const change = last ? Math.abs(at[0]! - last[0]!) : 0
      if (event) atStartOrEnd = Math.max(atStartOrEnd, change); else otherwise = Math.max(otherwise, change)
      const now_cheaper = Math.abs(at[0]! - at[1]!) < 1e-9 ? cheaper : at[0]! < at[1]! ? 0 : 1
      if (cheaper >= 0 && now_cheaper !== cheaper) flips++
      cheaper = now_cheaper; last = at
      for (const s of subs) s.left -= s.builders.filter(b => b.end >= 0).length * spend / minutes
    }
    return `${atStartOrEnd.toFixed(2)}, ${otherwise.toFixed(2)}, ${flips} times`.padEnd(30)
  })
  console.log(`${large}  ${row.join('')}`)
}

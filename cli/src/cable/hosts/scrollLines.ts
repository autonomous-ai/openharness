/** tui/src/dial.rs's numbers, so a stroke moves a terminal in VS Code as far as it moves Harness's own: pixels per unit
 *  of finger travel, and the line those pixels are counted in. */
export const SCROLL_SCALE = 2.5
export const SCROLL_LINE_PX = 16

/** One stroke's travel as whole lines: n < 0 toward older lines. `down` forgets what was left of the last stroke. An
 *  `up` carries its own travel only: a fling is not played, so the scroll stops where the finger stops. */
export function createScrollLines(): { take(phase: 'down' | 'move' | 'up', dy: number): number } {
  let remainder = 0
  return {
    take: (phase, dy) => {
      if (phase === 'down') remainder = 0
      remainder += -dy * SCROLL_SCALE
      // `|| 0`: travel under a line toward older lines truncates to -0, and no line is a line of 0.
      const lines = Math.trunc(remainder / SCROLL_LINE_PX) || 0
      remainder -= lines * SCROLL_LINE_PX
      return lines
    },
  }
}

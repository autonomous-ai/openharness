import { describe, expect, it } from 'vitest'
import { createScrollLines, SCROLL_LINE_PX, SCROLL_SCALE } from './scrollLines.js'

describe('a stroke\'s travel as lines', () => {
  it('uses tui/src/dial.rs\'s numbers: 2.5 px a unit of travel, a 16 px line', () => {
    expect([SCROLL_SCALE, SCROLL_LINE_PX]).toEqual([2.5, 16])
  })

  it('whole lines are spent and the rest is kept, as dial.rs travels', () => {
    const lines = createScrollLines()
    expect(lines.take('down', 0)).toBe(0)
    expect(lines.take('move', 4)).toBe(0) // -10 px
    expect(lines.take('move', 4)).toBe(-1) // -20 px: one line toward older, -4 px kept
    expect(lines.take('move', -8)).toBe(1) // +16 px: one line toward newer, 0 kept
    expect(lines.take('move', 32)).toBe(-5) // -80 px: five lines at once
  })

  it('a down forgets what the last stroke left', () => {
    const lines = createScrollLines()
    lines.take('down', 0)
    expect(lines.take('move', 6)).toBe(0) // -15 px kept
    expect(lines.take('up', 0)).toBe(0)
    // Without the down, 1 more px would make a line.
    expect(lines.take('down', 0)).toBe(0)
    expect(lines.take('move', 0.4)).toBe(0) // -1 px
    expect(lines.take('move', 6)).toBe(-1) // -16 px
    // A down's own travel counts after the reset.
    expect(lines.take('move', 3)).toBe(0) // -7.5 px kept
    expect(lines.take('down', 7)).toBe(-1) // -17.5 px: the 7.5 before it are gone
  })

  it('an up carries its travel and no fling', () => {
    const lines = createScrollLines()
    lines.take('down', 0)
    expect(lines.take('up', 8)).toBe(-1)
    // Nothing more comes of the stroke: the next take starts from the 4 px the up left.
    expect(lines.take('move', 0)).toBe(0)
    expect(lines.take('move', 6)).toBe(-1) // -4 - 15 px
  })

  it('no line is 0, never -0', () => {
    const lines = createScrollLines()
    lines.take('down', 0)
    expect(lines.take('move', 1)).toBe(0)
    expect(lines.take('move', -1)).toBe(0)
    expect(lines.take('move', 0)).toBe(0)
  })
})

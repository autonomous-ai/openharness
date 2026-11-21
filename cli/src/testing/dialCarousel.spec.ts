import { describe, expect, it } from 'vitest'
import { CAROUSEL_TILES, DialCarousel } from './dialCarousel.js'

/** A whole list as the daemon streams it: `agents.begin`, one `agent` row each, `agents.end`. */
function list(carousel: DialCarousel, ids: string[]): void {
  carousel.heard({ t: 'agents.begin' })
  for (const id of ids) carousel.heard({ t: 'agent', id })
  carousel.heard({ t: 'agents.end' })
}

function face(carousel: DialCarousel): string | null {
  return carousel.tiles[carousel.active] ?? null
}

describe('DialCarousel', () => {
  it('a list pushed over 16 tiles adds before it removes, so its one new agent is refused and the face is "Choose a pane"', () => {
    const carousel = new DialCarousel()
    const full = Array.from({ length: CAROUSEL_TILES }, (_, i) => `a${i}`)
    list(carousel, full)
    carousel.refresh()
    carousel.heard({ t: 'focus', agentId: 'a3' })
    expect(carousel.tiles).toEqual(full)
    expect(face(carousel)).toBe('a3')

    list(carousel, ['x'])
    carousel.refresh()

    expect(carousel.tiles).toEqual([])
    expect(carousel.refused).toBe(1)
    expect(carousel.active).toBe(-1)
  })

  it("the list's order is applied by swaps and the face stays on its agent", () => {
    const carousel = new DialCarousel()
    list(carousel, ['a', 'b', 'c'])
    carousel.refresh()
    carousel.heard({ t: 'focus', agentId: 'b' })

    list(carousel, ['c', 'a', 'b'])
    carousel.refresh()

    expect(carousel.tiles).toEqual(['c', 'a', 'b'])
    expect(face(carousel)).toBe('b')
  })

  it('a focus before its tile lands once the tile is there', () => {
    const carousel = new DialCarousel()
    carousel.heard({ t: 'focus', agentId: 'x' })
    expect(carousel.active).toBe(-1)

    list(carousel, ['w', 'x'])
    carousel.refresh()

    expect(face(carousel)).toBe('x')
  })

  it("a pick lands its ring's first tile; a pick of the app shown lands nothing", () => {
    const carousel = new DialCarousel()
    carousel.heard({ t: 'apps', shown: 'claude' })
    carousel.picked('codex')
    carousel.heard({ t: 'apps', shown: 'codex' })
    list(carousel, ['a', 'b'])
    carousel.refresh()
    expect(face(carousel)).toBe('a')

    carousel.heard({ t: 'focus', agentId: 'b' })
    carousel.picked('codex')
    list(carousel, ['a', 'b'])
    carousel.refresh()
    expect(face(carousel)).toBe('b')
  })

  it('a list still building is not read', () => {
    const carousel = new DialCarousel()
    list(carousel, ['a'])
    carousel.heard({ t: 'agents.begin' })
    carousel.heard({ t: 'agent', id: 'b' })

    carousel.refresh()
    expect(carousel.tiles).toEqual([])

    carousel.heard({ t: 'agents.end' })
    carousel.refresh()
    expect(carousel.tiles).toEqual(['b'])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppFilter, FRONT_SETTLE_MS } from './appFilter.js'
import type { SwitchCause } from './types.js'

/**
 * A filter over counts the test sets, a settle timer on vitest's fake clock, and a random function that draws only what is
 * scripted. The known agents are the counts unless a test gives its own, and the agents counted for the app in front
 * are the known ones unless it gives those too.
 */
function setup(draws: number[] = []) {
  const counts = new Map<string, number>()
  let known: Map<string, number> | undefined
  let inFront: Map<string, number> | undefined
  /** What the filter told, in order: a switch as its cause, a settle as `settled <app>`. */
  const told: string[] = []
  const switched = vi.fn((cause: SwitchCause) => { told.push(cause) })
  const random = vi.fn(() => {
    const r = draws.shift()
    if (r === undefined) throw new Error('a draw nobody scripted')
    return r
  })
  const after = vi.fn((ms: number, run: () => void) => {
    const t = setTimeout(run, ms)
    return () => clearTimeout(t)
  })
  // Each settled app, in order; settledApp() already reads it inside the callback.
  const settled: string[] = []
  let filter: AppFilter
  filter = new AppFilter({
    after,
    random,
    counts: () => ({ all: counts, known: known ?? counts, inFront: inFront ?? known ?? counts }),
    switched,
    settled: (app) => {
      expect(filter.settledApp()).toBe(app)
      settled.push(app)
      told.push(`settled ${app}`)
    },
  })
  const agents = (next: Record<string, number>, knownNext?: Record<string, number>, inFrontNext?: Record<string, number>): void => {
    counts.clear()
    for (const [app, n] of Object.entries(next)) counts.set(app, n)
    known = knownNext && new Map(Object.entries(knownNext))
    inFront = inFrontNext && new Map(Object.entries(inFrontNext))
  }
  const causes = (): SwitchCause[] => switched.mock.calls.map(([cause]) => cause)
  return { filter, agents, random, after, causes, told, settled }
}

const settle = (): void => {
  vi.advanceTimersByTime(FRONT_SETTLE_MS)
}

describe('AppFilter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the default is the app with the most agents', () => {
    const { filter, agents, causes } = setup()
    agents({ vscode: 2, ghostty: 3 })
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual([])
  })

  it('the app in front is the default when it has agents', () => {
    const { filter, agents } = setup()
    filter.front('vscode')
    settle()
    expect(filter.shown()).toBeUndefined()
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('vscode')
  })

  it('a tie is drawn once: the same counts later draw nothing new, and changed counts draw again', () => {
    const { filter, agents, random } = setup([0.9, 0.1])
    agents({ ghostty: 2, vscode: 2 })
    expect(filter.shown()).toBe('vscode')
    expect(filter.shown()).toBe('vscode')
    expect(random).toHaveBeenCalledTimes(1)
    agents({})
    expect(filter.shown()).toBeUndefined()
    agents({ ghostty: 2, vscode: 2 })
    expect(filter.shown()).toBe('vscode')
    expect(random).toHaveBeenCalledTimes(1)
    agents({})
    expect(filter.shown()).toBeUndefined()
    agents({ ghostty: 3, vscode: 3 })
    expect(filter.shown()).toBe('ghostty')
    expect(random).toHaveBeenCalledTimes(2)
  })

  it('the app in front is shown after 1 s, not before', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('vscode')
    vi.advanceTimersByTime(FRONT_SETTLE_MS - 1)
    expect(filter.shown()).toBe('ghostty')
    vi.advanceTimersByTime(1)
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual(['front'])
  })

  it('fifty changes inside a second leave one timer and settle once, on the last', () => {
    const { filter, agents, after, causes } = setup()
    agents({ ghostty: 3, vscode: 1, cursor: 1 })
    expect(filter.shown()).toBe('ghostty')
    for (let i = 0; i < 50; i++) {
      filter.front(i % 2 === 0 ? 'vscode' : 'cursor')
      vi.advanceTimersByTime(10)
    }
    expect(after).toHaveBeenCalledTimes(50)
    expect(vi.getTimerCount()).toBe(1)
    settle()
    expect(vi.getTimerCount()).toBe(0)
    expect(filter.shown()).toBe('cursor')
    expect(causes()).toEqual(['front'])
  })

  it('three apps and back inside a second moves nothing', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1, cursor: 1, orca: 1 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('ghostty')
    settle()
    for (const app of ['vscode', 'cursor', 'orca', 'ghostty']) {
      filter.front(app)
      vi.advanceTimersByTime(200)
    }
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual([])
  })

  it('an app in front with no agents changes nothing', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('vscode')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual([])
  })

  it('the app in front is shown once it gets an agent, as a switch by the front', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('vscode')
    settle()
    expect(filter.shown()).toBe('ghostty')
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual(['front'])
  })

  it('a pick made before the app in front gets agents still holds', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, cursor: 1 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('vscode')
    settle()
    expect(filter.pick('cursor')).toBe('switched')
    agents({ ghostty: 3, cursor: 1, vscode: 2 })
    expect(filter.shown()).toBe('cursor')
    expect(causes()).toEqual(['pick'])
  })

  it('none in front changes nothing', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('none')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual([])
  })

  it("an unknown terminal's agents are never followed to: none in front does not show the unknown app", () => {
    const { filter, agents, causes } = setup()
    agents({ terminal: 3, ghostty: 1 })
    expect(filter.shown()).toBe('terminal')
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('ghostty')
    filter.front('none')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual(['front'])
  })

  // The Device app quitting tells none: nothing is in front that the person chose, so a pick holds and the last app is
  // not followed any more.
  it('none in front keeps a held pick; the next app brought to the front ends it', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    filter.front('ghostty')
    settle()
    expect(filter.pick('vscode')).toBe('switched')
    filter.front('none')
    settle()
    agents({ ghostty: 4, vscode: 1 })
    expect(filter.shown()).toBe('vscode')
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual(['pick', 'front'])
  })

  it('none settled is never shown, and the app in front before it getting agents turns nothing', () => {
    const { filter, agents, causes } = setup()
    agents({ vscode: 2 })
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('vscode')
    filter.front('none')
    settle()
    agents({ vscode: 2, ghostty: 1 })
    expect(filter.shown()).toBe('vscode')
    // Nor while a pick holds.
    expect(filter.pick('ghostty')).toBe('switched')
    expect(filter.pick('vscode')).toBe('switched')
    agents({ vscode: 2, ghostty: 3 })
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual(['pick', 'pick'])
  })

  it('a pick holds through count changes and through the same app settling in front again', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(filter.pick('vscode')).toBe('switched')
    agents({ ghostty: 5, vscode: 2 })
    expect(filter.shown()).toBe('vscode')
    filter.front('cursor')
    vi.advanceTimersByTime(300)
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual(['pick'])
  })

  it('a pick ends when another app settles in front, even one with no agents', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(filter.pick('vscode')).toBe('switched')
    filter.front('none')
    settle()
    expect(filter.shown()).toBe('vscode')
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual(['pick', 'front'])
  })

  it('the picked app emptying shows the app in front, else the biggest, and is an empty switch', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 2, vscode: 1, cursor: 3 })
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(filter.pick('vscode')).toBe('switched')
    agents({ ghostty: 2, cursor: 3 })
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual(['pick', 'empty'])

    // With no agents in the app in front, the biggest; and the pick has ended, so that app is followed again once it has agents.
    filter.front('orca')
    settle()
    agents({ ghostty: 2, vscode: 1, cursor: 3 })
    expect(filter.pick('vscode')).toBe('switched')
    agents({ ghostty: 2, cursor: 3 })
    expect(filter.shown()).toBe('cursor')
    agents({ ghostty: 2, cursor: 3, orca: 1 })
    filter.front('ghostty')
    vi.advanceTimersByTime(300)
    filter.front('orca')
    settle()
    expect(filter.shown()).toBe('orca')
    expect(causes()).toEqual(['pick', 'empty', 'pick', 'empty', 'front'])
  })

  it('a pick of an app with no agents is ignored', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 1 })
    expect(filter.shown()).toBe('ghostty')
    expect(filter.pick('vscode')).toBe('ignored')
    expect(filter.pick('none')).toBe('ignored')
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual([])
  })

  it('a pick of the shown app is same and tells no switch', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('ghostty')
    expect(filter.pick('ghostty')).toBe('same')
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual([])
  })

  it('a pick of the shown app holds nothing: the app in front getting an agent still turns the dial', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('vscode')
    settle()
    expect(filter.pick('ghostty')).toBe('same')
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual(['front'])
  })

  it('hold of the shown app holds it and tells no switch', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('vscode')
    settle()
    expect(filter.hold('ghostty')).toBe(true)
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual([])
  })

  it('hold of another app is a switch by pick', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    filter.front('ghostty')
    settle()
    expect(filter.hold('vscode')).toBe(true)
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual(['pick'])
  })

  it('hold of an app with no agents answers false and holds nothing', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('vscode')
    settle()
    expect(filter.hold('cursor')).toBe(false)
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual(['front'])
  })

  it('a hold ends when another app settles in front', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.shown()).toBe('ghostty')
    expect(filter.hold('vscode')).toBe(true)
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual(['pick', 'front'])
  })

  it('a notice pick is a switch by notice and holds as a pick does', () => {
    const { filter, agents, causes } = setup()
    agents({ ghostty: 3, vscode: 1 })
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('ghostty')
    expect(filter.pick('vscode', 'notice')).toBe('switched')
    agents({ ghostty: 4, vscode: 1 })
    expect(filter.shown()).toBe('vscode')
    filter.front('cursor')
    vi.advanceTimersByTime(300)
    filter.front('ghostty')
    settle()
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual(['notice'])
  })

  it('each change tells its cause once; the first app shown tells none', () => {
    const { filter, agents, causes } = setup()
    expect(filter.shown()).toBeUndefined()
    agents({ vscode: 1 })
    filter.front('vscode')
    settle()
    expect(filter.shown()).toBe('vscode')
    expect(causes()).toEqual([])
    agents({ vscode: 1, ghostty: 1 })
    expect(filter.pick('ghostty')).toBe('switched')
    filter.shown()
    filter.shown()
    agents({ vscode: 1 })
    filter.shown()
    filter.shown()
    expect(causes()).toEqual(['pick', 'empty'])
    // Every agent ends: nothing is shown, and the next app shown is a first again.
    agents({})
    expect(filter.shown()).toBeUndefined()
    agents({ ghostty: 1 })
    expect(filter.shown()).toBe('ghostty')
    expect(causes()).toEqual(['pick', 'empty'])
  })

  it('a front equal to the last starts no timer', () => {
    const { filter, agents, after } = setup()
    agents({ ghostty: 3, vscode: 1 })
    filter.front('vscode')
    filter.front('vscode')
    expect(after).toHaveBeenCalledTimes(1)
    settle()
    filter.front('vscode')
    expect(after).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settledApp is the app that has stayed in front for 1 s', () => {
    const { filter, agents } = setup()
    agents({ ghostty: 3, vscode: 1 })
    expect(filter.settledApp()).toBeUndefined()
    filter.front('orca')
    vi.advanceTimersByTime(FRONT_SETTLE_MS - 1)
    expect(filter.settledApp()).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(filter.settledApp()).toBe('orca')
    filter.front('ghostty')
    filter.front('vscode')
    settle()
    expect(filter.settledApp()).toBe('vscode')
    filter.front('none')
    settle()
    expect(filter.settledApp()).toBe('none')
    // An app with no agents settles all the same: the front is what the person looks at, not what the dial shows.
    filter.front('cursor')
    settle()
    expect(filter.settledApp()).toBe('cursor')
  })

  it('settled is told each time an app settles in front, after the switch it caused', () => {
    const { filter, agents, told, settled } = setup()
    agents({ ghostty: 3, vscode: 1, cursor: 1 })
    expect(filter.shown()).toBe('ghostty')
    filter.front('vscode')
    settle()
    expect(told).toEqual(['front', 'settled vscode'])
    filter.front('none')
    settle()
    // An app with no agents settles all the same.
    filter.front('orca')
    settle()
    expect(settled).toEqual(['vscode', 'none', 'orca'])
    // Away and back inside a second: the same app settles again, and is told again.
    filter.front('ghostty')
    vi.advanceTimersByTime(300)
    filter.front('orca')
    settle()
    expect(settled).toEqual(['vscode', 'none', 'orca', 'orca'])
    for (let i = 0; i < 50; i++) {
      filter.front(i % 2 === 0 ? 'vscode' : 'cursor')
      vi.advanceTimersByTime(10)
    }
    settle()
    expect(settled).toEqual(['vscode', 'none', 'orca', 'orca', 'cursor'])
  })

  it('a front that does not stay 1 s tells no settle', () => {
    const { filter, agents, settled } = setup()
    agents({ ghostty: 3 })
    for (const app of ['vscode', 'cursor', 'orca']) {
      filter.front(app)
      vi.advanceTimersByTime(300)
    }
    expect(settled).toEqual([])
    filter.front('ghostty')
    vi.advanceTimersByTime(FRONT_SETTLE_MS - 1)
    expect(settled).toEqual([])
    vi.advanceTimersByTime(1)
    expect(settled).toEqual(['ghostty'])
  })

  it('latestFront is the app last reported, before it settles', () => {
    const { filter } = setup()
    expect(filter.latestFront()).toBeUndefined()
    filter.front('claude')
    expect(filter.latestFront()).toBe('claude')
    expect(filter.settledApp()).toBeUndefined()
    filter.front('orca')
    expect(filter.latestFront()).toBe('orca')
    filter.front('none')
    expect(filter.latestFront()).toBe('none')
  })

  describe('agents not known yet', () => {
    it('the default counts known agents only: five not known yet lose to two in Ghostty', () => {
      const { filter, agents } = setup()
      agents({ terminal: 5, ghostty: 2 }, { ghostty: 2 })
      expect(filter.shown()).toBe('ghostty')
    })

    it('known agents in the unknown app count as any app\'s: three there beat two in Ghostty', () => {
      const { filter, agents } = setup()
      agents({ terminal: 3, ghostty: 2 }, { terminal: 3, ghostty: 2 })
      expect(filter.shown()).toBe('terminal')
    })

    it('a tie is drawn over known agents: one not known yet coming or going draws nothing new', () => {
      const { filter, agents, random } = setup([0.9])
      agents({ ghostty: 2, vscode: 2 })
      expect(filter.shown()).toBe('vscode')
      agents({})
      expect(filter.shown()).toBeUndefined()
      agents({ ghostty: 2, vscode: 2, terminal: 1 }, { ghostty: 2, vscode: 2 })
      expect(filter.shown()).toBe('vscode')
      agents({})
      expect(filter.shown()).toBeUndefined()
      agents({ ghostty: 2, vscode: 2, terminal: 3 }, { ghostty: 2, vscode: 2 })
      expect(filter.shown()).toBe('vscode')
      expect(random).toHaveBeenCalledTimes(1)
    })

    it('only agents not known yet: their page is the default', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3 }, {})
      expect(filter.shown()).toBe('terminal')
      expect(causes()).toEqual([])
    })

    it('that default gives way once an app has a known agent, as an empty switch', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3 }, {})
      expect(filter.shown()).toBe('terminal')
      agents({ terminal: 2, ghostty: 1 }, { ghostty: 1 })
      expect(filter.shown()).toBe('ghostty')
      expect(causes()).toEqual(['empty'])
      expect(filter.shown()).toBe('ghostty')
      expect(causes()).toEqual(['empty'])
    })

    it('a default another app won gives way to the app in front once its agents are known', () => {
      // Diego's morning: Ghostty in front over five tmux sessions the scan cannot place, and one known agent in VS Code.
      const { filter, agents, causes } = setup()
      agents({ terminal: 5, vscode: 1 }, { vscode: 1 })
      filter.front('ghostty')
      settle()
      expect(filter.shown()).toBe('vscode')
      // Their hooks say they run in Ghostty.
      agents({ ghostty: 5, vscode: 1 })
      expect(filter.shown()).toBe('ghostty')
      expect(causes()).toEqual(['front'])
    })

    it('that default stays while only its own agents become known', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3 }, {})
      expect(filter.shown()).toBe('terminal')
      agents({ terminal: 3 }, { terminal: 1 })
      expect(filter.shown()).toBe('terminal')
      expect(causes()).toEqual([])
    })

    it('a pick of the page of agents not known yet holds while a known app has more', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3, ghostty: 5 }, { ghostty: 5 })
      expect(filter.shown()).toBe('ghostty')
      expect(filter.pick('terminal')).toBe('switched')
      expect([filter.shown(), filter.shown(), filter.shown()]).toEqual(['terminal', 'terminal', 'terminal'])
      expect(causes()).toEqual(['pick'])
    })

    it('the app in front with only agents not known yet is shown, and holds', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3 }, {})
      expect(filter.shown()).toBe('terminal')
      filter.front('terminal')
      settle()
      agents({ terminal: 3, ghostty: 5 }, { ghostty: 5 })
      expect(filter.shown()).toBe('terminal')
      expect(causes()).toEqual([])
    })

    it('Done on the default page changes nothing: the app in front takes over once its agents are known', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3 }, {})
      filter.front('ghostty')
      settle()
      expect(filter.shown()).toBe('terminal')
      expect(filter.pick('terminal')).toBe('same')
      agents({ terminal: 3, ghostty: 5 }, { ghostty: 5 })
      expect(filter.shown()).toBe('ghostty')
      expect(causes()).toEqual(['front'])
    })

    it('a notice of an agent on the default page changes nothing: it still gives way to an app with a known agent', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3 }, {})
      expect(filter.shown()).toBe('terminal')
      expect(filter.pick('terminal', 'notice')).toBe('same')
      agents({ terminal: 3, ghostty: 5 }, { ghostty: 5 })
      expect(filter.shown()).toBe('ghostty')
      expect(causes()).toEqual(['empty'])
    })

    it('a pick that ended in front of an app with no agents does not give way', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3, ghostty: 5 }, { ghostty: 5 })
      expect(filter.shown()).toBe('ghostty')
      expect(filter.pick('terminal')).toBe('switched')
      filter.front('none')
      settle()
      expect(filter.shown()).toBe('terminal')
      expect(causes()).toEqual(['pick'])
    })

    it('a hold of the default page stops it giving way', () => {
      const { filter, agents, causes } = setup()
      agents({ terminal: 3 }, {})
      expect(filter.shown()).toBe('terminal')
      expect(filter.hold('terminal')).toBe(true)
      agents({ terminal: 3, ghostty: 5 }, { ghostty: 5 })
      expect(filter.shown()).toBe('terminal')
      expect(causes()).toEqual([])
    })
  })

  describe('resting agents (docs/plans/2026-11-19-dial-claude-app-sessions-design.md)', () => {
    it('the app in front whose agents all rest is shown once they come, though the dial shows another app', () => {
      const { filter, agents, causes } = setup()
      filter.front('claude')
      settle()
      agents({ ghostty: 1 })
      expect(filter.shown()).toBe('ghostty')
      agents({ ghostty: 1, claude: 2 }, { ghostty: 1 }, { ghostty: 1, claude: 2 })
      expect(filter.shown()).toBe('claude')
      expect(causes()).toEqual(['front'])
      expect(filter.shown()).toBe('claude')
      expect(filter.shown()).toBe('claude')
      expect(causes()).toEqual(['front'])
    })

    it('… and when they come before the dial\'s first list', () => {
      const { filter, agents, causes } = setup()
      filter.front('claude')
      settle()
      agents({ ghostty: 1, claude: 2 }, { ghostty: 1 }, { ghostty: 1, claude: 2 })
      for (let i = 0; i < 4; i++) expect(filter.shown()).toBe('claude')
      expect(causes()).toEqual([])
    })

    it('resting agents weigh nothing in the default while their app is not in front', () => {
      const { filter, agents } = setup()
      agents({ claude: 16, ghostty: 1 }, { ghostty: 1 }, { claude: 16, ghostty: 1 })
      expect(filter.shown()).toBe('ghostty')
      filter.front('vscode')
      settle()
      expect(filter.shown()).toBe('ghostty')
      expect(filter.pick('claude')).toBe('switched')
      expect(filter.shown()).toBe('claude')
    })

    it('… and while no app has a known agent, though they outnumber the agents the scan found', () => {
      const { filter, agents } = setup()
      agents({ claude: 16, ghostty: 3 }, {}, { claude: 16 })
      expect(filter.shown()).toBe('ghostty')
    })

    it('resting agents are the default when they are all there is', () => {
      const { filter, agents } = setup()
      agents({ claude: 16 }, {}, { claude: 16 })
      expect(filter.shown()).toBe('claude')
    })
  })
})

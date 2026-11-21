/**
 * The Harness Pro's apps (docs/plans/2026-11-20-pro-app-data-daemon-design.md), on the real daemon: fake Claude Codes
 * started outside Harness in Ghostty and VS Code (harness/outsideAgent.ts), a fake dial that greets with the Pro's hello
 * (`board: 'pro'`, `appCards: 'v1'` and the rest), and the daemon's fake `open`.
 * - The welcome names `apps.switch`, `question.tier` and `resync`; every `apps` row carries `working`, a turn counting
 *   1 then 0, and every `apps` frame carries the `seq` after the frame before it.
 * - `app.pick` turns the ring to that app and brings it.
 * - With a window open, the Pro on an app's ring is still sent the window's `swarms`; a round dial beside it gets none.
 * The helpers are copied from dialAppFilter.e2e.ts: there they are file-local, and importing a test file runs its tests.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon, until } from './harness/daemon.js'
import { Desk } from './harness/desk.js'
import type { DialMessage, FakeDial } from './harness/fakeDial.js'
import { Outside } from './harness/outsideAgent.js'

/** What the Harness Pro says in its greeting: the split doc's Pro hello plus item B's three keys. */
const PRO = {
  board: 'pro', swarms: 'members-v1', recap: 'long-v1', activity: 'steps-v1', stats: 'turn-v1', player: 'library-v1',
  ota: 'v1', appFilter: 'v1', questionTier: 'v1', appCards: 'v1',
}
/** What the round dial with the filter says in its greeting. */
const FILTER = { appFilter: 'v1' }
const GHOSTTY = { TERM_PROGRAM: 'ghostty' }
const VSCODE = { TERM_PROGRAM: 'vscode' }
const VSCODE_BUNDLE = 'com.microsoft.VSCode'

interface Roster { rows: DialMessage[]; end: DialMessage }
interface AppEntry { id: string; name: string; count: number; waiting: number; working?: number }
interface Apps { shown: string; apps: AppEntry[] }

/** Each list the dial was sent after [since]: its rows, between `agents.begin` and `agents.end`, and the end. */
function rosters(dial: FakeDial, since = 0): Roster[] {
  const out: Roster[] = []
  let rows: DialMessage[] | null = null
  for (const m of dial.messages.slice(since)) {
    if (m.t === 'agents.begin') rows = []
    else if (m.t === 'agent' && rows) rows.push(m)
    else if (m.t === 'agents.end' && rows) { out.push({ rows, end: m }); rows = null }
  }
  return out
}
const appsFrames = (dial: FakeDial, since = 0): Apps[] => dial.messages.slice(since).filter((m) => m.t === 'apps') as unknown as Apps[]
const swarmsFrames = (dial: FakeDial, since = 0): DialMessage[] => dial.messages.slice(since).filter((m) => m.t === 'swarms')
const ids = (roster: Roster): unknown[] => roster.rows.map((r) => r.id)
const idsOf = (agents: Outside[]): string[] => agents.map((a) => a.id)
/** Each app's count, in a form that compares whole. */
const counts = (apps: Apps): Record<string, number> => Object.fromEntries(apps.apps.map((a) => [a.id, a.count]))
const workingOf = (apps: Apps, app: string): number | undefined => apps.apps.find((a) => a.id === app)?.working
/** Lists in their order, an object's keys in any: apps found in one scan come in the order of their session records. */
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b)

/** The last `apps` and the last list the dial was sent after [since], once both pass [test]. */
const showing = (dial: FakeDial, what: string, test: (apps: Apps, roster: Roster) => boolean, since = 0, ms = 45_000): Promise<{ apps: Apps; roster: Roster }> =>
  until(what, () => {
    const apps = appsFrames(dial, since).at(-1)
    const roster = rosters(dial, since).at(-1)
    return apps && roster && test(apps, roster) ? { apps, roster } : null
  }, ms, 100)
/** The first `apps` the dial was sent after [since] that passes [test]: a change of `working` alone pushes `apps` and no
 *  list, since the ring's rows are the same. */
const heard = (dial: FakeDial, what: string, test: (apps: Apps) => boolean, since: number): Promise<Apps> =>
  until(what, () => appsFrames(dial, since).find(test), 45_000, 100)
/** The dial shows [app]'s ring, [agents] in that order, under an `apps` that says so. */
const shows = (dial: FakeDial, app: string, agents: Outside[], since = 0, ms?: number): Promise<{ apps: Apps; roster: Roster }> =>
  showing(dial, `the dial to show ${app}'s ring`, (apps, roster) => apps.shown === app && same(ids(roster), idsOf(agents)) && roster.end.view === 'machine', since, ms)

/** The features the dial's first welcome named. */
const features = (dial: FakeDial): unknown[] => (dial.messages.find((m) => m.t === 'welcome')?.features ?? []) as unknown[]

/** Past the time a change made at [from] could have reached the dial (the 1 s push gap, a tick and room for a loaded
 *  machine), waited for as a frame it heard after that (the daemon pings it every 5 s). */
const settleWindowPassed = (dial: FakeDial, from: number): Promise<unknown> =>
  until('a frame after the settle window', () => dial.arrivedAt.some((at) => at >= from + 3_000), 30_000, 100)

describe('the Harness Pro\'s apps', () => {
  let daemon: IsolatedDaemon | undefined
  let desk: Desk | undefined
  const outside: Outside[] = []
  const windows: LocalClient[] = []
  afterEach(async () => {
    for (const window of windows.splice(0)) window.close()
    for (const engine of outside.splice(0)) await engine.close()
    await desk?.close()
    await daemon?.close()
    daemon = undefined
    desk = undefined
  })

  const fresh = async (): Promise<{ d: IsolatedDaemon; desk: Desk }> => {
    const d = await IsolatedDaemon.create({ env: { CABLE_DISABLE: 'false' } })
    daemon = d
    const file = join(d.root, 'dials.json')
    d.env.HARNESSD_TEST_DIAL_PORT = file
    writeFileSync(file, '[]')
    const theDesk = new Desk(file)
    desk = theDesk
    onTestFailed(() => {
      console.log(`---- daemon log\n${d.log().split('\n').slice(-200).join('\n')}`)
      console.log(`---- hooks the engines ran\n${d.hookLog().split('\n').slice(-40).join('\n')}`)
    })
    await d.start()
    return { d, desk: theDesk }
  }
  const startOutside = async (d: IsolatedDaemon, folder: string, hints: Record<string, string>): Promise<Outside> => {
    const engine = await Outside.start(d, folder, hints)
    outside.push(engine)
    return engine
  }
  /** A dial, plugged in and greeted, with its first list in hand. */
  const plugged = async (theDesk: Desk, capabilities: Record<string, string>, serial = 'E2E-A', mac = 'e2:e0:00:00:00:0a'): Promise<FakeDial> => {
    const dial = await theDesk.plug(serial, mac, capabilities)
    onTestFailed(() => {
      console.log(`---- ${serial}'s apps\n${appsFrames(dial).map((apps) => JSON.stringify(apps)).join('\n')}`)
      console.log(`---- ${serial}'s lists\n${rosters(dial).map((r) => JSON.stringify({ end: r.end, rows: r.rows.map((row) => `${row.name} ${row.host}`) })).join('\n')}`)
    })
    await dial.next((m) => m.t === 'agents.end', 60_000, 'the first list')
    return dial
  }
  /** The first agent, seen shown before another starts: two apps first read in the same second tie, and a tie is drawn. */
  const startFirst = async (d: IsolatedDaemon, dial: FakeDial, app: string, folder: string, hints: Record<string, string>): Promise<Outside> => {
    const engine = await startOutside(d, folder, hints)
    await shows(dial, app, [engine])
    return engine
  }
  /** Ghostty's two, then VS Code's one: the dial shows Ghostty, the app with the most agents. */
  const threeAgents = async (d: IsolatedDaemon, dial: FakeDial): Promise<{ ghostty: Outside[]; vscode: Outside[] }> => {
    const ghostty = [await startFirst(d, dial, 'ghostty', 'a1', GHOSTTY), await startOutside(d, 'a2', GHOSTTY)]
    const vscode = [await startOutside(d, 'a3', VSCODE)]
    await showing(dial, 'Ghostty 2 and VS Code 1', (apps, roster) =>
      same(counts(apps), { ghostty: 2, vscode: 1 }) && apps.shown === 'ghostty' && same(ids(roster), idsOf(ghostty)))
    return { ghostty, vscode }
  }
  /** A Harness window with an empty tab, as the desktop says it. */
  const openWindow = async (d: IsolatedDaemon): Promise<LocalClient> => {
    const window = await LocalClient.connect(d)
    windows.push(window)
    window.send('app_swarms', { active: 't1', swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }], tiles: [] })
    window.send('app_panes', { agentIds: [], foreground: true })
    return window
  }

  it('a Pro\'s hello: the welcome, then apps with seq and working, a turn counting 1 then 0', async () => {
    const { d, desk } = await fresh()
    const pro = await plugged(desk, PRO)
    const named = features(pro)
    expect(named).toEqual(expect.arrayContaining(['apps.switch', 'question.tier', 'resync']))
    expect(named.length).toBeLessThanOrEqual(11)
    const { ghostty: [g1] } = await threeAgents(d, pro)
    await showing(pro, 'every working 0', (apps) => apps.apps.every((a) => a.working === 0))
    let since = pro.messages.length
    g1.type('!until pro-turn')
    await heard(pro, 'Ghostty working 1', (apps) => apps.shown === 'ghostty' && workingOf(apps, 'ghostty') === 1, since)
    since = pro.messages.length
    writeFileSync(join(d.engineConfig.root, 'pro-turn.release'), '')
    await heard(pro, 'Ghostty working 0', (apps) => apps.shown === 'ghostty' && workingOf(apps, 'ghostty') === 0, since)
    pro.messages.forEach((m, at) => {
      if (m.t !== 'apps') return
      for (const row of (m as unknown as Apps).apps) {
        expect(Object.keys(row)).toEqual(['id', 'name', 'count', 'waiting', 'working'])
        expect(row.working).toBeGreaterThanOrEqual(0)
        expect(row.working).toBeLessThanOrEqual(row.count)
      }
      expect(typeof m.seq).toBe('number')
      // A welcome restarts the count at 0, and it is the message before the next one too.
      expect(m.seq).toBe((pro.messages[at - 1].seq as number) + 1)
    })
  })

  it('app.pick from a Pro turns its ring to VS Code and brings VS Code', async () => {
    const { d, desk } = await fresh()
    const pro = await plugged(desk, PRO)
    const { ghostty, vscode } = await threeAgents(d, pro)
    await shows(pro, 'ghostty', ghostty)
    const since = pro.messages.length
    pro.send({ t: 'app.pick', app: 'vscode' })
    const { roster } = await shows(pro, 'vscode', vscode, since)
    expect(roster.end).toMatchObject({ tab: '', view: 'machine', total: 1 })
    // The daemon's open is the fake in its root (harness/daemon.ts); bringing an app forward is macOS's alone.
    if (process.platform === 'darwin') {
      await until('one open -b of VS Code, logged', () =>
        same(d.opens(), [['-b', VSCODE_BUNDLE]]) && d.log().includes('[device] app filter: bring · ok'), 10_000, 100)
    }
  })

  it('with a window, a Pro on an app\'s ring keeps the window\'s swarms, and a round dial beside it gets none', async () => {
    const { d, desk } = await fresh()
    const pro = await plugged(desk, PRO)
    const round = await plugged(desk, FILTER, 'E2E-B', 'e2:e0:00:00:00:0b')
    const ghostty = [await startFirst(d, pro, 'ghostty', 'a1', GHOSTTY), await startOutside(d, 'a2', GHOSTTY)]
    await shows(pro, 'ghostty', ghostty)
    await shows(round, 'ghostty', ghostty)
    let since = pro.messages.length
    const window = await openWindow(d)
    await until('the Pro\'s tab list', () => rosters(pro, since).find((r) => r.end.tab === 't1'), 45_000)
    await until('the Pro\'s swarms on t1', () => swarmsFrames(pro, since).find((m) => m.selected === 't1'), 45_000)
    since = pro.messages.length
    const roundSince = round.messages.length
    pro.send({ t: 'app.pick', app: 'ghostty' })
    // One filter per computer: the pick turns both dials.
    await shows(pro, 'ghostty', ghostty, since)
    await shows(round, 'ghostty', ghostty, roundSince)
    await until('the round dial\'s swarms emptied', () => {
      const last = swarmsFrames(round, roundSince).at(-1)
      return last && same(last.items, []) ? last : null
    }, 30_000)
    expect(swarmsFrames(pro, since).every((m) => m.selected === 't1')).toBe(true)
    // The person adds a tab in the window while the Pro shows Ghostty's ring.
    const toldAt = pro.messages.length
    const told = Date.now()
    window.send('app_swarms', {
      active: 't1', tiles: [],
      swarms: [{ id: 't1', name: 'Tab', agentIds: [], panes: 0 }, { id: 't2', name: 'Two', agentIds: [], panes: 0 }],
    })
    const two = await until('the Pro\'s swarms with two tabs', () =>
      swarmsFrames(pro, toldAt).find((m) => (m.items as unknown[]).length === 2), 30_000)
    expect(two).toMatchObject({ selected: 't1' })
    expect(rosters(pro).at(-1)?.end.view).toBe('machine')
    await settleWindowPassed(round, told)
    expect(swarmsFrames(round, roundSince).every((m) => same(m.items, []))).toBe(true)
  })
})

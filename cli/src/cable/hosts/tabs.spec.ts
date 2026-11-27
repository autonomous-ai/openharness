import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstartGeneration } from '../../lib/lstart.js'
import type { Place } from './adapter.js'
import { APP_IDS } from './hostDetect.js'
import { TAB_APPS, TAB_TTY, clientTtyForm, createTabsAdapter, isTabApp, readTabTty, runPs, tabOf, type RunPs, type TabsDeps } from './tabs.js'

describe('tabs', () => {
  it('the tab apps are three of the app ids', () => {
    expect(TAB_APPS).toHaveLength(3)
    for (const app of TAB_APPS) {
      expect(APP_IDS).toContain(app)
      expect(isTabApp(app)).toBe(true)
    }
  })

  it('a tty is /dev/ttys and one to four digits', () => {
    for (const tty of ['/dev/ttys0', '/dev/ttys023', '/dev/ttys9999']) expect(TAB_TTY.test(tty)).toBe(true)
    for (const tty of [
      '/dev/ttys',
      '/dev/ttys12345',
      '/dev/pts/3',
      'ttys023',
      '/dev/ttys02a',
      '/dev/ttys023\n',
      '/dev/ttys023; rm',
    ]) {
      expect(TAB_TTY.test(tty)).toBe(false)
    }
  })

  it('clientTtyForm: macOS ttys, Linux pts, none on Windows', () => {
    const passes = (platform: NodeJS.Platform, tty: string) => clientTtyForm(platform)?.test(tty) ?? false
    expect(passes('linux', '/dev/pts/3')).toBe(true)
    expect(passes('darwin', '/dev/pts/3')).toBe(false)
    expect(passes('darwin', '/dev/ttys004')).toBe(true)
    expect(passes('linux', '/dev/ttys004')).toBe(false)
    for (const tty of ['/dev/pts/../x', '/dev/pts/', '/dev/pts/1234567', '/dev/pts/3\n', '/dev/pts/3; x']) expect(passes('linux', tty), tty).toBe(false)
    expect(clientTtyForm('win32')).toBeUndefined()
  })

  it('tabOf takes an app of the three and a tty, and no other key', () => {
    for (const app of TAB_APPS) {
      expect(tabOf({ app, tty: '/dev/ttys023', raise: true, extra: 'x' })).toStrictEqual({ app, tty: '/dev/ttys023' })
    }
    for (const app of ['orca', 'none', 'constructor']) expect(tabOf({ app, tty: '/dev/ttys023' })).toBeNull()
    expect(tabOf({ app: 'iterm', tty: '/dev/pts/3' })).toBeNull()
    expect(tabOf('iterm')).toBeNull()
    expect(tabOf(['iterm', '/dev/ttys023'])).toBeNull()
    expect(tabOf(null)).toBeNull()
  })

  const START = 'Tue Nov 25 10:00:00 2026'

  it('readTabTty asks ps once for the pid\'s tty and start, with 1 s and 256 bytes', async () => {
    const run = vi.fn<RunPs>(async () => `ttys003  ${START}\n`)
    expect(await readTabTty(4101, run)).toStrictEqual({ tty: '/dev/ttys003', start: lstartGeneration(START) })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(['-o', 'tty=,lstart=', '-p', '4101'], { timeout: 1_000, maxBuffer: 256 })
  })

  it('??, nothing and a tty the check refuses are no tty', async () => {
    for (const out of [`??  ${START}\n`, '', `pts/3  ${START}\n`, `ttys12345  ${START}\n`]) {
      expect(await readTabTty(4101, async () => out), out).toBeUndefined()
    }
  })

  it('a start that does not parse leaves the tty alone, with no start', async () => {
    expect(await readTabTty(4101, async () => 'ttys003  garbage\n')).toStrictEqual({ tty: '/dev/ttys003' })
    expect(await readTabTty(4101, async () => 'ttys003\n')).toStrictEqual({ tty: '/dev/ttys003' })
  })

  it('a run that failed rejects: it is not no tty', async () => {
    await expect(readTabTty(4101, async () => null)).rejects.toThrow('ps')
  })

  it('a pid that is not a positive integer is not asked', async () => {
    const run = vi.fn<RunPs>(async () => `ttys003  ${START}\n`)
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(await readTabTty(pid, run)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  describe('under the person\'s own locale', () => {
    const had = process.env.LC_ALL
    afterEach(() => {
      if (had === undefined) delete process.env.LC_ALL
      else process.env.LC_ALL = had
    })

    // Only this test's own process is read. ps prints lstart in LC_TIME's form: a German one is no start the parser reads.
    it.skipIf(process.platform === 'win32')('ps prints a start the parser reads', async () => {
      process.env.LC_ALL = 'de_DE.UTF-8'
      const out = await runPs(['-o', 'lstart=', '-p', String(process.pid)], { timeout: 1_000, maxBuffer: 256 })
      expect(out).not.toBeNull()
      expect(lstartGeneration(out!.trim())).toMatch(/^ps:\d+$/)
    })
  })
})

describe('the tabs adapter', () => {
  function recorder(open = true, selects = true) {
    const deps = { isOpen: vi.fn<TabsDeps['isOpen']>(() => open), select: vi.fn<TabsDeps['select']>(() => selects) }
    return { deps, adapter: createTabsAdapter(deps) }
  }
  const place = (app: string, tty?: string, host = app): Place => ({ host, app, hints: {}, ...(tty === undefined ? {} : { tty }) })
  const pane = (id: string) => ({ adapter: 'tabs', id })

  it('its id is tabs, and it is raised after its app', () => {
    const { adapter } = recorder()
    expect(adapter.id).toBe('tabs')
    expect(adapter.tap).toBe('after')
    expect(adapter.type).toBeUndefined()
  })

  it('paneOf takes a tab app and a tty, and refuses any other', () => {
    const { adapter } = recorder()
    for (const app of TAB_APPS) {
      expect(adapter.paneOf(place(app, '/dev/ttys023'))).toStrictEqual(pane(`${app}:/dev/ttys023`))
    }
    for (const app of ['orca', 'vscode', 'terminal']) expect(adapter.paneOf(place(app, '/dev/ttys023'))).toBeUndefined()
    for (const tty of [undefined, '/dev/pts/3', '/dev/ttys023; rm']) expect(adapter.paneOf(place('iterm', tty))).toBeUndefined()
  })

  it('paneOf: only while the tab app is the agent\'s nearest host', () => {
    const { adapter } = recorder()
    for (const host of ['herdr', 'rex', 'zellij', 'tmux', 'wezterm', 'kitty', 'orca']) {
      expect(adapter.paneOf(place('ghostty', '/dev/ttys023', host)), host).toBeUndefined()
    }
    // A session the open scan found: no hook has named its host yet, and its parents named the app.
    expect(adapter.paneOf(place('ghostty', '/dev/ttys023', 'terminal'))).toStrictEqual(pane('ghostty:/dev/ttys023'))
  })

  it('a place with an outer app and tty is that tab, whatever its host and app', () => {
    const { adapter } = recorder()
    const nested: Place = { host: 'tmux', app: 'tmux', hints: { TMUX_PANE: '%3' }, tty: '/dev/ttys099', pid: 100 }
    expect(adapter.paneOf({ ...nested, outer: { app: 'terminal-app', tty: '/dev/ttys004' } })).toStrictEqual(pane('terminal-app:/dev/ttys004'))
    // An outer app with no tty, a tty out of form, or an app with no tabs: no tab, and the multiplexer's own pty is never one.
    for (const outer of [{ app: 'terminal-app' }, { app: 'terminal-app', tty: '/dev/pts/3' }, { app: 'orca', tty: '/dev/ttys004' }]) {
      expect(adapter.paneOf({ ...nested, outer }), JSON.stringify(outer)).toBeUndefined()
    }
    expect(adapter.paneOf(nested)).toBeUndefined()
  })

  it('paneOf gives the pane the proof of its place, and none to a nested one or one with none', () => {
    const { adapter } = recorder()
    const proof = { pid: 4101, start: 'ps:1' }
    expect(adapter.paneOf({ ...place('iterm', '/dev/ttys003'), proof })).toStrictEqual({ ...pane('iterm:/dev/ttys003'), proof })
    expect(adapter.paneOf(place('iterm', '/dev/ttys003'))).toStrictEqual(pane('iterm:/dev/ttys003'))
    // Its tab holds the multiplexer's client, not the agent: the proof's process is on the multiplexer's pane.
    const nested: Place = { host: 'tmux', app: 'tmux', hints: {}, tty: '/dev/ttys099', pid: 4101, proof,
      outer: { app: 'iterm', tty: '/dev/ttys004', pid: 4300 } }
    expect(adapter.paneOf(nested)).toStrictEqual(pane('iterm:/dev/ttys004'))
  })

  it('canFocus and canShow are the stream being open, asked each time', () => {
    let open = false
    const deps = { isOpen: vi.fn(() => open), select: vi.fn(() => true) }
    const adapter = createTabsAdapter(deps)
    const tab = pane('iterm:/dev/ttys023')
    expect(adapter.canFocus(tab)).toBe(false)
    expect(adapter.canShow(tab)).toBe(false)
    open = true
    expect(adapter.canFocus(tab)).toBe(true)
    expect(adapter.canShow(tab)).toBe(true)
    expect(deps.isOpen).toHaveBeenCalledTimes(4)
  })

  it('show writes one select that does not raise, and focus one that does', async () => {
    const { deps, adapter } = recorder()
    const tab = pane('terminal-app:/dev/ttys023')
    expect(await adapter.show(tab, 'agent-1')).toBe('ok')
    expect(deps.select).toHaveBeenLastCalledWith({ app: 'terminal-app', tty: '/dev/ttys023' }, false)
    expect(await adapter.focus(tab)).toBe(true)
    expect(deps.select).toHaveBeenLastCalledWith({ app: 'terminal-app', tty: '/dev/ttys023' }, true)
    expect(deps.select).toHaveBeenCalledTimes(2)

    const refused = recorder(true, false)
    expect(await refused.adapter.show(tab, 'agent-1')).toBe('failed')
    expect(await refused.adapter.focus(tab)).toBe(false)
  })

  it('show and focus write their line before they answer', () => {
    const { deps, adapter } = recorder()
    const tab = pane('ghostty:/dev/ttys023')
    void adapter.show(tab, 'agent-1')
    void adapter.focus(tab)
    expect(deps.select).toHaveBeenCalledTimes(2)
  })

  it('a pane id not in its form writes nothing', async () => {
    const { deps, adapter } = recorder()
    for (const id of ['orca:/dev/ttys023', 'terminal-app', 'terminal-app:/dev/pts/3', 'terminal-app:/dev/ttys023:x', '']) {
      expect(await adapter.show(pane(id), 'agent-1')).toBe('failed')
      expect(await adapter.focus(pane(id))).toBe(false)
    }
    expect(deps.select).not.toHaveBeenCalled()
  })
})

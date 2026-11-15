import { describe, expect, it, vi } from 'vitest'
import type { Place } from './adapter.js'
import { APP_IDS } from './hostDetect.js'
import { TAB_APPS, TAB_TTY, createTabsAdapter, isTabApp, readTty, tabOf, type RunPs, type TabsDeps } from './tabs.js'

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

  it('readTty asks ps once for the pid, with 1 s and 256 bytes', async () => {
    const run = vi.fn<RunPs>(async () => 'ttys023\n')
    expect(await readTty(4242, run)).toBe('/dev/ttys023')
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(['-o', 'tty=', '-p', '4242'], { timeout: 1_000, maxBuffer: 256 })
  })

  it('??, nothing and a tty the check refuses are no tty', async () => {
    for (const out of ['??\n', '', 'pts/3\n', 'ttys12345\n']) {
      expect(await readTty(4242, async () => out)).toBeUndefined()
    }
  })

  it('a run that failed rejects: it is not no tty', async () => {
    await expect(readTty(4242, async () => null)).rejects.toThrow('ps')
  })

  it('a pid that is not a positive integer is not asked', async () => {
    const run = vi.fn<RunPs>(async () => 'ttys023\n')
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(await readTty(pid, run)).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the tabs adapter', () => {
  function recorder(open = true, selects = true) {
    const deps = { isOpen: vi.fn<TabsDeps['isOpen']>(() => open), select: vi.fn<TabsDeps['select']>(() => selects) }
    return { deps, adapter: createTabsAdapter(deps) }
  }
  const place = (app: string, tty?: string): Place => ({ host: 'claude', app, hints: {}, ...(tty === undefined ? {} : { tty }) })
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

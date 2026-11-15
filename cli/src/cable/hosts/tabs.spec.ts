import { describe, expect, it, vi } from 'vitest'
import { APP_IDS } from './hostDetect.js'
import { TAB_APPS, TAB_TTY, isTabApp, readTty, tabOf, type RunPs } from './tabs.js'

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

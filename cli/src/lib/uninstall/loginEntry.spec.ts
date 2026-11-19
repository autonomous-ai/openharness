import { describe, expect, it } from 'vitest'
import { loginEntryExec, removeLoginEntry } from './loginEntry.js'

const LAUNCHER = '/home/u/.local/bin/harness'
const ENTRY = '/home/u/.config/autostart/harnessd.desktop'
/** The six lines install.sh writes (write_login_entry). */
const own = (exec = `"${LAUNCHER}" start`, ...more: string[]) =>
  ['[Desktop Entry]', 'Type=Application', 'Name=Harness', `Exec=${exec}`, 'NoDisplay=true', 'X-GNOME-Autostart-enabled=true', ...more, ''].join('\n')

function fake(files: Record<string, string>, overrides: Partial<Parameters<typeof removeLoginEntry>[0]> = {}) {
  const read: string[] = []
  const removed: string[] = []
  const deps: Parameters<typeof removeLoginEntry>[0] = {
    platform: 'linux', home: '/home/u', launcher: LAUNCHER,
    read: (path) => { read.push(path); return files[path] ?? null },
    remove: (path) => { removed.push(path) },
    ...overrides,
  }
  return { deps, read, removed }
}

describe('removeLoginEntry', () => {
  it('removes the entry install.sh wrote for this launcher', () => {
    const t = fake({ [ENTRY]: own() })
    expect(removeLoginEntry(t.deps)).toBe(ENTRY)
    expect(t.removed).toEqual([ENTRY])
  })

  it('removes its own entry the person turned off: Harness is going', () => {
    const t = fake({ [ENTRY]: own(undefined, 'Hidden=true') })
    expect(removeLoginEntry(t.deps)).toBe(ENTRY)
    expect(t.removed).toEqual([ENTRY])
  })

  it.each([
    ['another program\'s', own('/opt/harness-device/harness-device --login')],
    ['another launcher\'s', own('"/opt/harness/bin/harness" start')],
    ['its own only on a later Exec= line', own('/opt/other', `Exec="${LAUNCHER}" start`)],
    ['one with no Exec= line', '[Desktop Entry]\nType=Application\n'],
  ])('keeps an entry that is %s', (_, text) => {
    const t = fake({ [ENTRY]: text })
    expect(removeLoginEntry(t.deps)).toBeNull()
    expect(t.removed).toEqual([])
  })

  it('answers null when there is none', () => {
    const t = fake({})
    expect(removeLoginEntry(t.deps)).toBeNull()
    expect(t.removed).toEqual([])
  })

  it.each(['darwin', 'win32'] as const)('touches nothing on %s', (platform) => {
    const t = fake({ [ENTRY]: own() }, { platform })
    expect(removeLoginEntry(t.deps)).toBeNull()
    expect(t.read).toEqual([])
    expect(t.removed).toEqual([])
  })

  it('takes XDG_CONFIG_HOME only when it is absolute, as install.sh does', () => {
    const absolute = fake({ '/x/cfg/autostart/harnessd.desktop': own() }, { configHome: '/x/cfg' })
    expect(removeLoginEntry(absolute.deps)).toBe('/x/cfg/autostart/harnessd.desktop')
    for (const configHome of ['cfg', '']) {
      const t = fake({ [ENTRY]: own() }, { configHome })
      expect(removeLoginEntry(t.deps)).toBe(ENTRY)
    }
  })

  it('answers the path and why when it could not be removed', () => {
    const t = fake({ [ENTRY]: own() }, { remove: () => { throw new Error('EACCES: permission denied') } })
    expect(removeLoginEntry(t.deps)).toEqual({ path: ENTRY, failed: 'EACCES: permission denied' })
  })

  it('finds its own entry for a launcher path the Exec= line has to quote', () => {
    const launcher = '/home/u/a b$c%d/.local/bin/harness'
    const t = fake({ [ENTRY]: own('"/home/u/a b\\\\$c%%d/.local/bin/harness" start') }, { launcher })
    expect(removeLoginEntry(t.deps)).toBe(ENTRY)
  })
})

describe('loginEntryExec', () => {
  // Each expected value is what install.sh's login_entry_exec printed for the same path under /bin/sh.
  it('quotes as install.sh does: a backslash doubled twice, " ` $ after an escaped backslash, % doubled', () => {
    expect(loginEntryExec('/home/u/a b$c%d/.local/bin/harness')).toBe('"/home/u/a b\\\\$c%%d/.local/bin/harness" start')
    expect(loginEntryExec('/h/x\\y"z`w/harness')).toBe('"/h/x\\\\\\\\y\\\\"z\\\\`w/harness" start')
  })
})

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HARNESS_ENTRIES, harnessPath, harnessPathText, harnessRoot, harnessRoots, legacyHarnessHome, legacyHarnessPath, xdgRoots,
  type HarnessEntry, type HomeLook,
} from './harnessHome.js'

// The spec's table (docs/plans/2026-11-18-harness-paths-design.md), written out by hand.
const TABLE: Record<string, 'data' | 'state'> = {
  auth: 'data',
  'computer-id': 'data',
  cli: 'data',
  connections: 'data',
  'agent-messages': 'data',
  bin: 'data',
  dsh: 'data',
  'claude-profiles': 'data',
  'desktop-app-v2': 'data',
  'viewer-app-v2': 'data',
  tui: 'data',
  devices: 'data',
  lessons: 'data',
  'grid-fleet': 'data',
  community: 'data',
  'orca-plugin': 'data',
  memory: 'data',
  logs: 'state',
  runtime: 'state',
  'hook-routes': 'state',
  s: 'state',
  run: 'state',
  'shell-requests': 'state',
  pty: 'state',
  uninstalling: 'state',
  flasher: 'state',
  monitor: 'state',
}
const ENTRIES = Object.keys(TABLE) as HarnessEntry[]

/** A computer that has these folders and these variables, and nothing else. */
const look = (folders: string[] = [], env: Record<string, string | undefined> = {}): HomeLook => ({ env, exists: (path) => folders.includes(path) })

const FRESH = { data: '/h/.local/share/harness', state: '/h/.local/state/harness' }

describe('Harness\'s home folder', () => {
  it('the table is the spec\'s', () => {
    expect(HARNESS_ENTRIES).toEqual(TABLE)
  })

  it('fresh: neither folder exists → the XDG roots', () => {
    expect(harnessRoot('data', '/h', 'linux', look())).toBe(FRESH.data)
    expect(harnessRoot('state', '/h', 'linux', look())).toBe(FRESH.state)
    expect(harnessRoots('/h', 'linux', look())).toEqual([FRESH.data, FRESH.state])
  })

  it('legacy only → both roots are ~/.harness', () => {
    const legacy = look(['/h/.harness'])
    expect(harnessRoot('data', '/h', 'linux', legacy)).toBe('/h/.harness')
    expect(harnessRoot('state', '/h', 'linux', legacy)).toBe('/h/.harness')
    expect(harnessRoots('/h', 'linux', legacy)).toEqual(['/h/.harness'])
    for (const entry of ENTRIES) expect(harnessPath(entry, '/h', 'linux', legacy)).toBe('/h/.harness/' + entry)
  })

  // The bridge the move leaves at ~/.harness, or one something old made again, never flips a moved machine back.
  it('the data root exists → XDG, whatever is at ~/.harness', () => {
    const moved = look([FRESH.data, '/h/.harness'])
    expect(harnessRoot('data', '/h', 'linux', moved)).toBe(FRESH.data)
    expect(harnessRoot('state', '/h', 'linux', moved)).toBe(FRESH.state)
    expect(harnessRoots('/h', 'linux', moved)).toEqual([FRESH.data, FRESH.state])
  })

  it('an XDG variable that is unset, empty or relative is ignored', () => {
    for (const value of [undefined, '', 'share']) {
      const env = { XDG_DATA_HOME: value, XDG_STATE_HOME: value }
      expect(xdgRoots('/h', env)).toEqual(FRESH)
      expect(harnessRoots('/h', 'linux', look([], env))).toEqual([FRESH.data, FRESH.state])
    }
    const env = { XDG_DATA_HOME: '/d', XDG_STATE_HOME: '/s' }
    expect(xdgRoots('/h', env)).toEqual({ data: '/d/harness', state: '/s/harness' })
    expect(harnessRoots('/h', 'linux', look([], env))).toEqual(['/d/harness', '/s/harness'])
    // Its data root is the switch: the default's existing says nothing about a machine that set its own.
    expect(harnessRoots('/h', 'linux', look([FRESH.data, '/h/.harness'], env))).toEqual(['/h/.harness'])
  })

  it('every entry goes to the root its label names', () => {
    for (const entry of ENTRIES) expect(harnessPath(entry, '/h', 'linux', look())).toBe(`${FRESH[TABLE[entry]]}/${entry}`)
  })

  it('macOS and Windows never run the rule', () => {
    const asks: HomeLook = { env: {}, exists: () => { throw new Error('the rule ran') } }
    for (const entry of ENTRIES) {
      expect(harnessPath(entry, '/Users/me', 'darwin', asks)).toBe('/Users/me/.harness/' + entry)
      expect(harnessPath(entry, 'C:\\Users\\me', 'win32', asks)).toBe('C:\\Users\\me\\.harness\\' + entry)
      expect(harnessPathText(entry, '$HOME', 'darwin', asks)).toBe('$HOME/.harness/' + entry)
      expect(harnessPathText(entry, '$HOME', 'win32', asks)).toBe('$HOME/.harness/' + entry)
    }
    expect(harnessRoots('/Users/me', 'darwin', asks)).toEqual(['/Users/me/.harness'])
    expect(harnessRoots('C:\\Users\\me', 'win32', asks)).toEqual(['C:\\Users\\me\\.harness'])
  })

  it('the legacy helpers ignore the rule', () => {
    expect(legacyHarnessHome('/h', 'linux')).toBe('/h/.harness')
    expect(legacyHarnessPath('dsh', '/h', 'linux')).toBe('/h/.harness/dsh')
    expect(legacyHarnessPath('logs', 'C:\\h', 'win32')).toBe('C:\\h\\.harness\\logs')
    expect(legacyHarnessHome()).toBe(join(homedir(), '.harness'))
  })

  // A path join normalizes the home and a text join keeps it as written: each caller gets what it built before.
  it('joins as its caller joined', () => {
    expect(harnessPath('cli', '/tmp/x/', 'darwin')).toBe('/tmp/x/.harness/cli')
    expect(harnessPath('cli', '/tmp/x/', 'linux', look(['/tmp/x/.harness']))).toBe('/tmp/x/.harness/cli')
    expect(harnessPathText('cli', '/tmp/x/', 'darwin')).toBe('/tmp/x//.harness/cli')
  })

  // The suite's home is a throwaway one with no Harness folder in it (vitest.setup.ts), and no XDG variable.
  it('defaults to this account\'s home and this platform', () => {
    const logs = process.platform === 'linux' ? join(homedir(), '.local', 'state', 'harness', 'logs') : join(homedir(), '.harness', 'logs')
    expect(harnessPath('logs')).toBe(logs)
  })

  // Linux's paths only: a Windows folder is not an absolute posix path, so its XDG variable would be ignored.
  it.skipIf(process.platform === 'win32')('reads this computer\'s variables and folders when no look is passed', () => {
    const home = mkdtempSync(join(tmpdir(), 'harness-look-'))
    try {
      expect(harnessRoot('data', home, 'linux')).toBe(posix.join(home, '.local', 'share', 'harness'))
      mkdirSync(join(home, '.harness'))
      expect(harnessRoot('data', home, 'linux')).toBe(posix.join(home, '.harness'))
      process.env.XDG_DATA_HOME = posix.join(home, 'data')
      mkdirSync(join(home, 'data', 'harness'), { recursive: true })
      expect(harnessRoot('data', home, 'linux')).toBe(posix.join(home, 'data', 'harness'))
    } finally {
      delete process.env.XDG_DATA_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })

  // The launch prelude writes these between double quotes, for the process's own home.
  it('the prelude\'s text', () => {
    const home = homedir()
    expect(harnessPathText('run', '$HOME', 'linux', look([posix.join(home, '.harness')]))).toBe('$HOME/.harness/run')
    expect(harnessPathText('run', '$HOME', 'linux', look([posix.join(home, '.local', 'share', 'harness')]))).toBe('$HOME/.local/state/harness/run')
    expect(harnessPathText('run', '$HOME', 'darwin', look())).toBe('$HOME/.harness/run')
  })

  it.skipIf(process.platform === 'win32')('the prelude\'s text is one folder for any state root', () => {
    const odd = 'a b $x "q" \\ `date`'
    const inShell = (text: string, home: string): string =>
      execFileSync('/bin/sh', ['-c', `printf %s "${text}"`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, x: 'expanded' } })
    // Outside the home: the root written out.
    const outside = { XDG_STATE_HOME: `/tmp/${odd}` }
    expect(inShell(harnessPathText('run', '$HOME', 'linux', look([], outside), '/h'), '/h')).toBe(`/tmp/${odd}/harness/run`)
    // In the home: `$HOME` and the rest of the way.
    const inside = { XDG_STATE_HOME: `/h/${odd}` }
    expect(harnessPathText('run', '$HOME', 'linux', look([], inside), '/h')).toMatch(/^\$HOME\//)
    expect(inShell(harnessPathText('run', '$HOME', 'linux', look([], inside), '/h'), '/h')).toBe(`/h/${odd}/harness/run`)
  })

  // The core's process loads this module (src/architecture.coreFiles.txt), so it may load nothing beyond Node.
  it('loads nothing but node:os, node:path and node:fs', () => {
    const source = readFileSync(new URL('./harnessHome.ts', import.meta.url), 'utf8')
    const loaded = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(loaded.filter((name) => !['node:os', 'node:path', 'node:fs'].includes(name))).toEqual([])
  })
})

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HARNESS_ENTRIES, harnessPath, harnessPathText, harnessRoot, harnessRoots, type HarnessEntry } from './harnessHome.js'

// The spec's table (docs/plans/2026-11-18-harness-paths-design.md), written out by hand.
const TABLE = {
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
  logs: 'state',
  runtime: 'state',
  'hook-routes': 'state',
  s: 'state',
  run: 'state',
  'shell-requests': 'state',
  pty: 'state',
  uninstalling: 'state',
  flasher: 'state',
}

describe('Harness\'s home folder', () => {
  it('the table is the spec\'s', () => {
    expect(HARNESS_ENTRIES).toEqual(TABLE)
  })

  it('every entry is <home>/.harness/<entry>, on posix and on Windows', () => {
    for (const entry of Object.keys(TABLE) as HarnessEntry[]) {
      expect(harnessPath(entry, '/home/me', 'linux')).toBe('/home/me/.harness/' + entry)
      expect(harnessPath(entry, 'C:\\Users\\me', 'win32')).toBe('C:\\Users\\me\\.harness\\' + entry)
    }
  })

  it('both roots are the home\'s .harness, and the roots are one', () => {
    expect(harnessRoot('data', '/h', 'linux')).toBe('/h/.harness')
    expect(harnessRoot('state', '/h', 'linux')).toBe('/h/.harness')
    expect(harnessRoots('/h', 'linux')).toEqual(['/h/.harness'])
    expect(harnessRoots('C:\\h', 'win32')).toEqual(['C:\\h\\.harness'])
  })

  // A path join normalizes the home and a text join keeps it as written: each caller gets what it built before.
  it('joins as its caller joined', () => {
    expect(harnessPath('cli', '/tmp/x/', 'linux')).toBe('/tmp/x/.harness/cli')
    expect(harnessPathText('cli', '/tmp/x/')).toBe('/tmp/x//.harness/cli')
    expect(harnessPathText('run')).toBe('$HOME/.harness/run')
  })

  it('defaults to this account\'s home and this platform', () => {
    expect(harnessPath('logs')).toBe(join(homedir(), '.harness', 'logs'))
  })

  // The core's process loads this module (src/architecture.coreFiles.txt), so it may load nothing beyond Node.
  it('loads nothing but node:os and node:path', () => {
    const source = readFileSync(new URL('./harnessHome.ts', import.meta.url), 'utf8')
    const loaded = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    expect(loaded.filter((name) => name !== 'node:os' && name !== 'node:path')).toEqual([])
  })
})

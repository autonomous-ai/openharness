import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeExecutable } from './executableFixture.js'

interface FakeDaemon { root: string; env: { HOME: string; CLAUDE_PATH: string } }

// The harness is outside tsconfig's rootDir (src), so it is loaded untyped, as dialAppEvalTierB.spec.ts loads it.
const { ownHerdrsOnly } = await import('../../e2e/harness/herdrServer.js' as string) as {
  ownHerdrsOnly(d: FakeDaemon, root: number, ps: string): { kept(): number[]; dropped(): number[] }
}

/** The test worker's pid in the fake tables, and herdr's executable. */
const WORKER = 500
const HERDR = '/Users/someone/.local/bin/herdr'
/** iTerm2's server in a home, where the fake iTerm2 starts its own (harness/outsideAgent.ts). */
const itermServer = (home: string): string => join(home, 'Library', 'Application Support', 'iTerm2', 'iTermServer-3.6.6')

/** A daemon's folders as ownHerdrsOnly reads them: its throwaway root, its home inside it, its bin. */
function daemon(home?: string): FakeDaemon {
  const root = mkdtempSync(join(tmpdir(), 'own-herdrs-'))
  mkdirSync(join(root, 'bin'))
  return { root, env: { HOME: home ?? join(root, 'home'), CLAUDE_PATH: join(root, 'bin', 'claude') } }
}

/**
 * The daemon's `ps -axo pid=,ppid=,comm=` over [rows] alone (pid, ppid, comm): ownHerdrsOnly's wrapper whose real ps is
 * a script printing them, so no real process is read. The pids it listed, and those it noted kept and dropped.
 */
function table(d: FakeDaemon, rows: ReadonlyArray<readonly [number, number, string]>): { listed: number[]; kept: number[]; dropped: number[] } {
  const rowsFile = join(d.root, 'table')
  writeFileSync(rowsFile, rows.map(([pid, ppid, comm]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${comm}\n`).join(''))
  const fakePs = join(d.root, 'fake-ps')
  writeExecutable(fakePs, `#!/bin/sh\ncat '${rowsFile}'\n`)
  const hidden = ownHerdrsOnly(d, WORKER, fakePs)
  const wrapper = join(d.root, 'bin', 'ps')
  // Checked before it runs: a wrapper over the real ps would read the computer's own table.
  expect(readFileSync(wrapper, 'utf8')).toContain(fakePs)
  const listed = execFileSync(wrapper, ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((line) => Number(line.trim().split(/\s+/)[0]))
  return { listed, kept: hidden.kept(), dropped: hidden.dropped() }
}

describe.skipIf(process.platform === 'win32')("ownHerdrsOnly: the daemon's table holds the test's herdrs alone", () => {
  it("keeps a herdr under this worker, and one under this daemon's iTerm2 server once launchd adopted it, and drops the person's", () => {
    const d = daemon()
    const { listed, kept, dropped } = table(d, [
      [1, 0, '/sbin/launchd'],
      [WORKER, 1, 'node'],
      [510, WORKER, HERDR],
      // The fake iTerm2 relaunched: its server is launchd's, its tab's helper, herdr's client and server under it.
      [600, 1, itermServer(d.env.HOME)],
      [601, 600, 'python3'],
      [602, 601, HERDR],
      [603, 602, HERDR],
      // The person's herdr, in a tab of their own iTerm2.
      [800, 1, itermServer(userInfo().homedir)],
      [801, 800, '/usr/bin/login'],
      [802, 801, '-zsh'],
      [803, 802, HERDR],
    ])
    expect(kept).toEqual([510, 602, 603])
    expect(dropped).toEqual([803])
    expect(listed).toEqual([1, WORKER, 510, 600, 601, 602, 603, 800, 801, 802])
  })

  it.each<[string, (d: FakeDaemon) => ReadonlyArray<readonly [number, number, string]>]>([
    ['under launchd', () => [[1, 0, '/sbin/launchd'], [700, 1, HERDR]]],
    ['under the person\'s own iTerm2 server', () => [[1, 0, '/sbin/launchd'], [800, 1, itermServer(userInfo().homedir)], [801, 800, '-zsh'], [700, 801, HERDR]]],
    ['under another daemon\'s iTerm2 server', () => [[1, 0, '/sbin/launchd'], [800, 1, itermServer(daemon().env.HOME)], [700, 800, HERDR]]],
    ['under a server of another version in this home', (d) => [[800, 1, `${itermServer(d.env.HOME)}-1`], [700, 800, HERDR]]],
    ['under a home beside this one', (d) => [[800, 1, itermServer(`${d.env.HOME}x`)], [700, 800, HERDR]]],
    ['under a path that ends with this server\'s', (d) => [[800, 1, `/elsewhere${itermServer(d.env.HOME)}`], [700, 800, HERDR]]],
    ['under this server\'s path with a space after it', (d) => [[800, 1, `${itermServer(d.env.HOME)} `], [700, 800, HERDR]]],
    ['under this server\'s path in another case', (d) => [[800, 1, itermServer(d.env.HOME).toLowerCase()], [700, 800, HERDR]]],
    ['under a path that leads to this server another way', (d) => [[800, 1, `${d.env.HOME}/Library/..${itermServer('/')}`], [700, 800, HERDR]]],
    ['under the server\'s name alone', () => [[800, 1, 'iTermServer-3.6.6'], [700, 800, HERDR]]],
    ['over this daemon\'s iTerm2 server, not under it', (d) => [[700, 1, HERDR], [800, 700, itermServer(d.env.HOME)]]],
  ])('drops a herdr %s', (_, rows) => {
    const d = daemon()
    const { listed, kept, dropped } = table(d, rows(d))
    expect(kept).toEqual([])
    expect(dropped).toEqual([700])
    expect(listed).not.toContain(700)
  })

  it('refuses a daemon whose home is outside its root, writing no ps', () => {
    const d = daemon(userInfo().homedir)
    expect(() => ownHerdrsOnly(d, WORKER, join(d.root, 'fake-ps'))).toThrow(/outside/)
    expect(existsSync(join(d.root, 'bin', 'ps'))).toBe(false)
  })
})

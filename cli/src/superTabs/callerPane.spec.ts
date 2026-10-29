import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { isolatedTmux } from '../testing/isolatedTmux.js'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { processProbe, runningPane, systemTmuxPaths } from './callerPane.js'

const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TSX = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

// This process is 900; its shell 800 runs in pane %42, whose process is 700, under the tmux server 600. Pane %7, another
// harness's, is 500.
const panes = [{ pane: '%7', pid: 500 }, { pane: '%42', pid: 700 }]
const chain = (...pids: number[]) => pids.map(pid => ({ pid, command: pid === 600 ? 'tmux' : pid === 1 ? '/sbin/launchd' : '/bin/zsh' }))
const probe = (over: { panes?: typeof panes | null; ancestors?: ReturnType<typeof chain> | null } = {}) => ({
  panes: () => over.panes === undefined ? panes : over.panes,
  ancestors: () => over.ancestors === undefined ? chain(900, 800, 700, 600, 1) : over.ancestors,
})
const UNPROVEN = { refused: 'Harness could not tell which pane this command runs in, so it did not run it. Run it as your harness gave it, in its own pane.' }

it('finds the pane this command runs in from its parent processes, whatever TMUX_PANE says', () => {
  // With the parents its harness is held to (inDaemonPane).
  expect(runningPane({ TMUX_PANE: '%42' }, probe(), 'darwin')).toEqual({ pane: '%42', ancestors: [900, 800, 700, 600, 1] })
  // Unsetting TMUX_PANE does not hide the pane.
  expect(runningPane({}, probe(), 'darwin')).toMatchObject({ pane: '%42' })
  // tmux inside a harness's pane: the nearest pane is the one asking.
  expect(runningPane({ TMUX_PANE: '%7' }, probe({ ancestors: chain(900, 500, 600, 800, 700, 600, 1) }), 'darwin')).toMatchObject({ pane: '%7' })
})

// The Lead's must on #904's plan: an allowed command can't claim another harness by typing its pane.
it('refuses a TMUX_PANE that names another pane than the one the command runs in', () => {
  expect(runningPane({ TMUX_PANE: '%7' }, probe(), 'darwin'))
    .toEqual({ refused: 'This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.' })
})

// Security review 2 of #2087, late finding: with no pane proven the command went on as a person's terminal. It fails closed
// now whenever it may be in a pane: ps unreadable, a tmux server among its parents, or TMUX or TMUX_PANE set.
it('refuses when it may run in a pane that cannot be proven', () => {
  // TMUX pointing at a socket that does not exist: tmux answers nothing, and the server is still among its parents.
  expect(runningPane({ TMUX: '/nowhere/default,1,0' }, probe({ panes: null }), 'darwin')).toEqual(UNPROVEN)
  expect(runningPane({}, probe({ panes: null }), 'darwin')).toEqual(UNPROVEN)
  // Another server's panes, none of them its parent.
  expect(runningPane({}, probe({ panes: [{ pane: '%3', pid: 300 }] }), 'darwin')).toEqual(UNPROVEN)
  // ps cannot be read: nothing proves where it runs.
  expect(runningPane({}, probe({ ancestors: null }), 'darwin')).toEqual(UNPROVEN)
  expect(runningPane({ TMUX_PANE: '%42' }, probe({ ancestors: null }), 'darwin')).toEqual(UNPROVEN)
  // Detached from its pane by a double fork (its parent is launchd now), with TMUX or TMUX_PANE still set.
  for (const env of [{ TMUX: '/private/tmp/tmux-501/default,1,0' }, { TMUX_PANE: '%42' }]) {
    expect(runningPane(env, probe({ ancestors: chain(900, 1) }), 'darwin')).toEqual(UNPROVEN)
  }
})

it('is no pane for a person\'s terminal outside tmux, nor for a command detached with TMUX and TMUX_PANE unset (the named gap)', () => {
  expect(runningPane({}, probe({ ancestors: chain(900, 300, 1) }), 'darwin')).toEqual({})
  expect(runningPane({}, probe({ ancestors: chain(900, 300, 1), panes: null }), 'darwin')).toEqual({})
  expect(runningPane({}, probe({ ancestors: chain(900, 1) }), 'darwin')).toEqual({})
})

it('keeps TMUX_PANE as it is on Windows, which has no tmux to check it against', () => {
  expect(runningPane({ TMUX_PANE: '%7' }, probe({ panes: null, ancestors: null }), 'win32')).toEqual({ pane: '%7' })
  expect(runningPane({}, probe(), 'win32')).toEqual({})
})

// The second review of #2087: the real tmux and ps outputs, read as they come, and the late finding's three ways to leave
// a pane unproven, each run for real in a pane of a private tmux server.
describe('reading the real processes and panes', () => {
  it('reads this process\'s own parents from ps, nearest first', () => {
    const chain = processProbe().ancestors()!.map(row => row.pid)
    expect(chain.slice(0, 2)).toEqual([process.pid, process.ppid])
    expect(new Set(chain).size).toBe(chain.length)
  })

  // Re-check 1 of #2093 (critical): Harness's own tmux, which install.sh puts on Macs without Homebrew's and in Team
  // accounts, was not looked for, so there every agent's Swarm command was refused. The daemon's tmux comes first.
  it('reads the panes with the tmux the daemon uses: the managed one first, then the system\'s', async () => {
    const tmux = await isolatedTmux()
    try {
      await tmux.run('new-session', '-d', '-s', 'probe', 'sleep 30')
      const pane = await tmux.run('display-message', '-p', '-t', 'probe', '#{pane_id}')
      const pid = Number(await tmux.run('display-message', '-p', '-t', 'probe', '#{pane_pid}'))
      // A runtime folder as the installer leaves it: the build under it, and current-tmux naming it.
      const runtime = join(tmux.root, 'runtime'), managed = join(runtime, 'tmux-3.5a', 'bin', 'tmux')
      mkdirSync(dirname(managed), { recursive: true })
      symlinkSync(resolveBinaryOnPath('tmux')!, managed)
      writeFileSync(join(runtime, 'current-tmux'), `${managed}\n`)
      const server = { pid: 0, command: 'tmux' }
      // Only the managed tmux on this machine.
      expect(processProbe(tmux.env, 'darwin', { runtimeDir: runtime, systemTmux: [] }).panes(server)).toContainEqual({ pane, pid })
      // Another version where the system keeps tmux, which cannot talk to the daemon's server: the managed one is used.
      const other = join(tmux.root, 'other-tmux')
      writeFileSync(other, '#!/bin/sh\necho "protocol version mismatch (client 7, server 8)" >&2\nexit 1\n', { mode: 0o755 })
      expect(processProbe(tmux.env, 'darwin', { runtimeDir: runtime, systemTmux: [other] }).panes(server)).toContainEqual({ pane, pid })
      // No managed tmux: the system's is used, and one that cannot read the server reads as nothing.
      const none = join(tmux.root, 'no-runtime')
      expect(processProbe(tmux.env, 'darwin', { runtimeDir: none, systemTmux: [resolveBinaryOnPath('tmux')!] }).panes(server)).toContainEqual({ pane, pid })
      expect(processProbe(tmux.env, 'darwin', { runtimeDir: none, systemTmux: [other] }).panes(server)).toBeNull()
      // A record naming a tmux outside the runtime folder is not trusted.
      writeFileSync(join(runtime, 'current-tmux'), `${other}\n`)
      expect(processProbe(tmux.env, 'darwin', { runtimeDir: runtime, systemTmux: [] }).panes(server)).toBeNull()
    } finally { await tmux.close() }
  }, 30_000)

  // Re-check 2 of #2093 (critical 5): MacPorts and the install folders Harness already trusts (tmuxOnPath.ts), after the
  // managed tmux, and never PATH: the folders come from this account's home, whatever HOME or PATH say.
  it('looks for the system\'s tmux where Harness installs and trusts it, and nowhere a command names', () => {
    expect(systemTmuxPaths('darwin', '/Users/ken')).toEqual(['/Users/ken/.local/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux',
      '/opt/local/bin/tmux', '/usr/bin/tmux', '/bin/tmux', '/run/current-system/sw/bin/tmux'])
    expect(systemTmuxPaths('linux', '/home/ken')).toEqual(['/home/ken/.local/bin/tmux', '/usr/local/bin/tmux', '/opt/local/bin/tmux',
      '/usr/bin/tmux', '/bin/tmux', '/run/current-system/sw/bin/tmux'])
  })

  it('finds the pane a command runs in, whatever its environment says, and refuses when it cannot be proven', async () => {
    const tmux = await isolatedTmux()
    try {
      // A tmux first on PATH that would claim this command for another harness's pane.
      const fakeBin = join(tmux.root, 'fake-bin')
      mkdirSync(fakeBin)
      writeFileSync(join(fakeBin, 'tmux'), '#!/bin/sh\necho "%7 $PPID"\n', { mode: 0o755 })
      const probeScript = (out: string, cases: string) => {
        const script = join(tmux.root, `${basename(out)}.mts`)
        writeFileSync(script, `import { writeFileSync } from 'node:fs'\nimport { runningPane } from ${JSON.stringify(join(CLI_ROOT, 'src/superTabs/callerPane.ts'))}\n`
          + `const env = process.env\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(${cases}))\n`)
        return `${shellQuote(process.execPath)} ${shellQuote(TSX)} ${shellQuote(script)}`
      }
      const inPane = join(tmux.root, 'in-pane.json'), detached = join(tmux.root, 'detached.json')
      const cases = `{ named: runningPane(env), unset: runningPane({ ...env, TMUX_PANE: '' }), other: runningPane({ ...env, TMUX_PANE: '%999' }),
        badSocket: runningPane({ ...env, TMUX: '/nowhere/default,1,0', TMUX_PANE: '' }),
        fakeTmux: runningPane({ ...env, TMUX_PANE: '', PATH: ${JSON.stringify(fakeBin)} + ':' + env.PATH }) }`
      // The second probe forks twice and its middle shell exits, so launchd (or init) is its parent, TMUX still set.
      await tmux.run('new-session', '-d', '-s', 'probe', '-x', '80', '-y', '20',
        `${probeScript(inPane, cases)}; ( ( ${probeScript(detached, `{ detached: runningPane({ ...env, TMUX_PANE: '' }) }`)} & ) & ); sleep 30`)
      const pane = await tmux.run('display-message', '-p', '-t', 'probe', '#{pane_id}')
      const panePid = Number(await tmux.run('display-message', '-p', '-t', 'probe', '#{pane_pid}'))
      expect(processProbe(tmux.env).panes({ pid: 0, command: 'tmux' })).toContainEqual({ pane, pid: panePid })
      await vi.waitFor(() => expect(existsSync(inPane) && existsSync(detached)).toBe(true), { timeout: 25_000, interval: 100 })
      const unproven = { refused: 'Harness could not tell which pane this command runs in, so it did not run it. Run it as your harness gave it, in its own pane.' }
      const withParents = expect.objectContaining({ pane, ancestors: expect.arrayContaining([panePid]) })
      expect(JSON.parse(readFileSync(inPane, 'utf8'))).toEqual({ named: withParents, unset: withParents,
        other: { refused: 'This command names a pane it does not run in. Run it as your harness gave it, without setting TMUX_PANE.' },
        badSocket: unproven, fakeTmux: withParents })
      expect(JSON.parse(readFileSync(detached, 'utf8'))).toEqual({ detached: unproven })
    } finally { await tmux.close() }
  }, 40_000)
})

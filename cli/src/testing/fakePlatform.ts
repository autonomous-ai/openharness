/**
 * Fake `launchctl`, `systemctl` and `loginctl` for the tests of `harness service` (harnessd/platform.ts,
 * lib/serviceCommand.ts): a small model of what launchd and systemd do with harnessd's job, kept in a
 * folder of their own, recording every call.
 *
 * Hand the code under test a PATH that is this folder ALONE. Node looks a command up on the PATH of the
 * environment it is given, so a fake that is missing fails as ENOENT and is never the real binary: a
 * test cannot register anything with this machine's launchd or systemd, or stop the person's daemon.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export interface FakePlatformState {
  /** launchd: the user's GUI domain exists (someone is logged in at the screen). */
  guiDomain: boolean
  /** launchd: the job is loaded. systemd: the unit's file is known to the manager. */
  loaded: boolean
  /** systemd: enabled for the next login. */
  enabled: boolean
  /** The master's pid while the platform runs it; null while it does not. */
  pid: number | null
  /** The pid the next start runs the master as. */
  nextPid: number
  /** When set, a start writes `nextPid` here, as the master claims the pid file once its core binds;
   *  a stop removes it, as the master does on its way out. */
  pidFile: string | null
  /** systemd: the unit gave up (its start limit). */
  failed: boolean
  /** loginctl's answer for Linger; null makes loginctl fail. */
  linger: 'yes' | 'no' | null
  /** Calls that fail instead, keyed by `<command> <first argument after --user>`. */
  fail: Record<string, { status: number; stderr: string }>
  /** Pids a stop may SIGTERM, as launchd and systemd do the master: only stand-ins a test started
   *  itself, never a number that could be someone's real process. */
  killable: number[]
}

export interface FakePlatform {
  /** The folder to put alone on PATH. */
  bin: string
  /** Every call, as argv arrays with the command first. */
  calls(): string[][]
  state(): FakePlatformState
  set(change: Partial<FakePlatformState>): void
}

const DEFAULTS: FakePlatformState = {
  guiDomain: true, loaded: false, enabled: false, pid: null, nextPid: 4242, pidFile: null, failed: false, linger: 'yes', fail: {}, killable: [],
}

// One script for all three commands, told apart by the name it was run as. Plain CommonJS on the
// node running the tests, named by its absolute path in the shebang, so it needs nothing from PATH.
const SCRIPT = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const dir = path.dirname(process.argv[1])
const name = path.basename(process.argv[1])
let args = process.argv.slice(2)
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify([name, ...args]) + '\n')
const stateFile = path.join(dir, 'state.json')
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
const out = (text) => process.stdout.write(text)
const end = (status, stderr = '') => { if (stderr) process.stderr.write(stderr + '\n'); save(); process.exit(status) }
if (name === 'systemctl' && args[0] === '--user') args = args.slice(1)
const failing = state.fail[name + ' ' + args[0]]
if (failing) end(failing.status, failing.stderr)
const run = () => {
  state.pid = state.nextPid
  state.failed = false
  if (state.pidFile) fs.writeFileSync(state.pidFile, state.pid + '\n')
}
const halt = () => {
  if (state.pid !== null && state.killable.includes(state.pid)) { try { process.kill(state.pid, 'SIGTERM') } catch {} }
  if (state.pidFile && state.pid !== null) {
    try { if (Number(fs.readFileSync(state.pidFile, 'utf8')) === state.pid) fs.rmSync(state.pidFile) } catch {}
  }
  state.pid = null
}
const label = 'ai.autonomous.harness.harnessd'
if (name === 'launchctl') {
  const [verb, target, file] = args
  switch (verb) {
    case 'print':
      if (!target.includes('/' + label)) {
        if (!state.guiDomain) end(113, 'Could not find domain for port identifier: ' + target)
        out(target + ' = {\n\ttype = Aqua\n}\n'); end(0)
      }
      if (!state.loaded) end(113, 'Could not find service "' + label + '" in domain for port')
      out(target + ' = {\n\tactive count = 1\n\tpath = /fake/' + label + '.plist\n\ttype = LaunchAgent\n\tstate = ' + (state.pid ? 'running' : 'not running') + '\n\n\tprogram = /fake/node\n\targuments = {\n\t\t/fake/node\n\t}\n')
      if (state.pid) out('\tpid = ' + state.pid + '\n\tlast exit code = (never exited)\n')
      else out('\tlast exit code = 1\n')
      out('}\n'); end(0)
    case 'enable': end(0)
    case 'bootstrap':
      if (!state.guiDomain) end(125, 'Bootstrap failed: 125: Domain does not support specified action')
      if (state.loaded) end(5, 'Bootstrap failed: 5: Input/output error')
      if (!fs.existsSync(file)) end(2, 'Bootstrap failed: 2: No such file or directory')
      state.loaded = true; run(); end(0)
    case 'kickstart':
      if (!state.loaded) end(113, 'Could not find service "' + label + '" in domain for port')
      if (!state.pid) run()
      end(0)
    case 'bootout':
      if (!state.loaded) end(3, 'Boot-out failed: 3: No such process')
      state.loaded = false; halt(); end(0)
    default: end(64, 'Unrecognized subcommand: ' + verb)
  }
}
if (name === 'systemctl') {
  const verb = args[0]
  switch (verb) {
    case 'show':
      if (args.includes('--property=MainPID')) { out('MainPID=' + (state.pid ?? 0) + '\n'); end(0) }
      out('LoadState=' + (state.loaded ? 'loaded' : 'not-found') + '\nUnitFileState=' + (state.enabled ? 'enabled' : state.loaded ? 'disabled' : '') +
        '\nActiveState=' + (state.failed ? 'failed' : state.pid ? 'active' : 'inactive') + '\nSubState=' + (state.failed ? 'failed' : state.pid ? 'running' : 'dead') +
        '\nMainPID=' + (state.pid ?? 0) + '\nResult=' + (state.failed ? 'start-limit-hit' : 'success') + '\n')
      end(0)
    case 'daemon-reload': state.loaded = true; end(0)
    case 'reset-failed': state.failed = false; end(0)
    case 'enable': state.enabled = true; if (args[1] === '--now' && !state.pid) run(); end(0)
    case 'start': if (!state.pid) run(); end(0)
    case 'stop': halt(); end(0)
    case 'kill': if (!state.pid) end(1, 'Failed to kill unit harnessd.service: No main process to kill'); halt(); end(0)
    case 'disable': state.enabled = false; if (args[1] === '--now') halt(); end(0)
    default: end(1, 'Unknown command verb ' + verb)
  }
}
if (name === 'loginctl') {
  if (state.linger === null) end(1, 'Failed to get user: User ID is not logged in or lingering')
  out('Linger=' + state.linger + '\n'); end(0)
}
end(127, name + ': not faked')
`

export function fakePlatform(bin: string, initial: Partial<FakePlatformState> = {}): FakePlatform {
  // Never a folder that could be on someone's real PATH.
  if (!resolve(bin).startsWith(resolve(tmpdir())) && !resolve(bin).startsWith('/tmp/') && !resolve(bin).startsWith('/private/tmp/')) {
    throw new Error(`fake platform binaries belong in a temporary folder, not ${bin}`)
  }
  mkdirSync(bin, { recursive: true })
  for (const name of ['launchctl', 'systemctl', 'loginctl']) {
    const file = join(bin, name)
    writeFileSync(file, `#!${process.execPath}\n${SCRIPT}`)
    chmodSync(file, 0o755)
  }
  const stateFile = join(bin, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ ...DEFAULTS, ...initial }))
  const callsFile = join(bin, 'calls.jsonl')
  return {
    bin,
    calls: () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : [],
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as FakePlatformState,
    set: (change) => writeFileSync(stateFile, JSON.stringify({ ...(JSON.parse(readFileSync(stateFile, 'utf8')) as FakePlatformState), ...change })),
  }
}

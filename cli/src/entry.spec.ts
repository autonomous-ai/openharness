import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const ENTRY = fileURLToPath(new URL('./entry.ts', import.meta.url))
const LOADER = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))
const homes: string[] = []
/** What Node and the loader need on Windows to find its temporary folder; nothing on a Mac or Linux. */
const WINDOWS_ENV = Object.fromEntries(['TEMP', 'TMP', 'SystemRoot'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

// The Swarm's shell guard is gone (anh Dee, 2026-11-09). An agent a release before started still runs its hook before each
// tool, `cli.js __swarm-shell-guard`, as its engine was told at launch, and Codex fails a tool call whose hook fails. The
// entry reads the call and allows it, whatever it is, and touches nothing of the account or the daemon.
it.each([
  ['a command the guard refused', 'Bash', { command: 'sudo npm ci' }],
  ['a stop by name', 'exec_command', { cmd: 'killall node' }],
  ['a write to a fixed name in /tmp', 'Write', { file_path: '/tmp/shared-notes.txt', content: 'x' }],
  ['a write larger than a pipe holds', 'Write', { file_path: 'notes.txt', content: 'x'.repeat(300_000) }],
  ['an ordinary command', 'Bash', { command: 'git status' }],
])('allows %s through the retired shell guard\'s hook, and says nothing', (_name, tool, input) => {
  const home = mkdtempSync(join(tmpdir(), 'retired-guard-')); homes.push(home)
  const run = spawnSync(process.execPath, ['--import', LOADER, ENTRY, '__swarm-shell-guard'], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: home }), encoding: 'utf8', timeout: 30_000, windowsHide: true,
    env: { ...WINDOWS_ENV, PATH: process.env.PATH, HOME: home, USERPROFILE: home, ADAPTER_DATA_DIR: join(home, 'data') },
  })
  expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual({ status: 0, stdout: '', stderr: '' })
  expect(readdirSync(home)).toEqual([])
}, 60_000)

// The master on a Mac or Linux runs its team guard and, on Linux, the home move before startMaster installs its fatal
// handler (masterProcess.ts). Node's own report of an error either throws is its message and stack, on the stderr launchd
// and systemd make the daemon's log, which Export logs sends. Windows' master installs its own once its log is open.
it.skipIf(process.platform === 'win32')('a master whose home move throws ends with one line, the error by its kind', () => {
  const home = mkdtempSync(join(tmpdir(), 'master-fatal-')); homes.push(home)
  // As on Linux, with a home move whose error names the person's folder; nothing is moved, nothing else starts.
  const stub = "export async function moveHomeAtStart() { throw new Error('the home at /Users/sentinel/x could not move') }"
  const hooks = 'export async function resolve(specifier, context, next) { return specifier === \'./homeMove/start.js\''
    + ` ? { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)}, shortCircuit: true } : next(specifier, context) }`
  const preload = "import { register } from 'node:module'; Object.defineProperty(process, 'platform', { value: 'linux' }); "
    + `register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)})`
  const run = spawnSync(process.execPath, ['--import', LOADER, '--import', `data:text/javascript,${encodeURIComponent(preload)}`, ENTRY, '__harnessd'], {
    encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: home, ADAPTER_DATA_DIR: join(home, 'data') },
  })
  expect(run.stderr).not.toContain('sentinel')
  expect({ status: run.status, stderr: run.stderr })
    .toEqual({ status: 1, stderr: expect.stringMatching(/^[\d-]+ [\d:.]+ \[harnessd\] the master stopped on an uncaught error: Error\n$/) })
}, 60_000)

it('allows a call it cannot read, and one with no input at all', () => {
  for (const input of ['not json', '']) {
    const home = mkdtempSync(join(tmpdir(), 'retired-guard-')); homes.push(home)
    const run = spawnSync(process.execPath, ['--import', LOADER, ENTRY, '__swarm-shell-guard'], {
      input, encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...WINDOWS_ENV, PATH: process.env.PATH, HOME: home, USERPROFILE: home, ADAPTER_DATA_DIR: join(home, 'data') },
    })
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }, JSON.stringify(input)).toEqual({ status: 0, stdout: '', stderr: '' })
  }
}, 60_000)

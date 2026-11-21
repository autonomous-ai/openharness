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


it.each([
  ['entry.ts', '__service'], ['entry.ts', '__run'],
  ['leanEntry.ts', '__service'], ['leanCoreEntry.ts', '__run'],
  ['cli.ts', '__service'], ['cli.ts', '__run'],
])('rejects a real legacy-contract parent at %s %s before loading child runtime', (file, command) => {
  const home = mkdtempSync(join(tmpdir(), 'child-admission-')); homes.push(home)
  const entry = fileURLToPath(new URL(`./${file}`, import.meta.url))
  // A separate process launches the child with the historical parent's environment. No modern
  // supervisor code or admission helper runs in that parent; this exercises the real parent PID too.
  const parent = `
    const { spawnSync } = require('node:child_process')
    const child = spawnSync(process.execPath, ${JSON.stringify(['--import', LOADER, entry, command, 'not-a-service'])},
      { env: process.env, encoding: 'utf8', timeout: 8_000, windowsHide: true })
    console.log(JSON.stringify({ parent: process.pid, status: child.status, stdout: child.stdout, stderr: child.stderr, error: child.error?.code }))
  `
  const run = spawnSync(process.execPath, ['-e', parent], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...WINDOWS_ENV, PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      ADAPTER_DATA_DIR: join(home, 'data'), PORT: '0', ADAPTER_UPDATE_DISABLE: '1',
      HARNESSD_SUPERVISED: '1', HARNESSD_SERVICE_TOKEN: 'test-only', HARNESSD_CORE_SCRIPT: ENTRY },
  })
  expect(run.error).toBeUndefined()
  expect(run.status).toBe(0)
  const child = JSON.parse(run.stdout) as { parent: number; status: number; stdout: string; stderr: string; error?: string }
  expect(child.parent).not.toBe(process.pid)
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(2)
  expect(child.stdout).toBe('')
  expect(child.stderr).toContain('[harnessd] child bundle admission failed:')
  expect(readdirSync(home)).toEqual([])
})

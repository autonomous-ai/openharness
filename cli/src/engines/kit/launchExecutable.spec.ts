import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
let root = ''
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); if (root) rmSync(root, { recursive: true, force: true }); root = '' })
async function fixture() {
  root = mkdtempSync(join(tmpdir(), 'launch-executable-'))
  const bin = join(root, 'bin'); mkdirSync(bin)
  vi.stubEnv('HOME', root); vi.stubEnv('PATH', bin); vi.stubEnv('OPENCODE_PATH', '')
  vi.resetModules()
  return { bin, ...await import('./launchExecutable.js') }
}
it('captures an absolute executable once and detects its replacement', async () => {
  const { bin, captureLaunchExecutable } = await fixture()
  const file = join(bin, 'opencode'); writeFileSync(file, 'fixture', { mode: 0o700 })
  const result = await captureLaunchExecutable('opencode', '')
  expect(result.state).toBe('ready')
  if (result.state !== 'ready') throw new Error('fixture was held')
  expect(result.executable.command).toBe(file)
  expect(result.executable.current()).toBe(true)
  writeFileSync(file, 'upgraded fixture')
  expect(result.executable.current()).toBe(false)
})
it('distinguishes complete absence from inaccessible or ambiguous candidates', async () => {
  const { bin, captureLaunchExecutable } = await fixture()
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'install' })
  const file = join(bin, 'opencode'); writeFileSync(file, 'fixture'); chmodSync(file, 0o600)
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
  rmSync(file); mkdirSync(file)
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
  vi.stubEnv('PATH', 'relative')
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
})
it('searches the absolute folders of a PATH that also lists what is not one', async () => {
  // The login PATH of a Mac with the .NET SDK: `~/.dotnet/tools`, unexpanded. An empty entry and `.` are as common.
  const { bin, captureLaunchExecutable } = await fixture()
  vi.stubEnv('PATH', ['~/.dotnet/tools', '', '.', 'relative', bin].join(':'))
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'install' })
  const file = join(bin, 'opencode'); writeFileSync(file, 'fixture', { mode: 0o700 })
  const result = await captureLaunchExecutable('opencode', '')
  expect(result).toMatchObject({ state: 'ready', executable: { command: file } })
  // Nothing absolute to search, or more entries than a search is bounded to: still held.
  vi.stubEnv('PATH', '~/.dotnet/tools::.')
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
  vi.stubEnv('PATH', Array(257).fill(bin).join(':'))
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
})
it('never installs over an explicitly configured missing executable', async () => {
  await fixture()
  vi.stubEnv('OPENCODE_PATH', join(root, 'absent'))
  vi.resetModules()
  const { captureLaunchExecutable } = await import('./launchExecutable.js')
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
})

it('holds dangling command aliases instead of authorizing an installation over them', async () => {
  const { bin, captureLaunchExecutable } = await fixture()
  symlinkSync(join(root, 'unavailable-engine'), join(bin, 'opencode'))
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'held' })
})
it('permits complete absence through a valid search-directory alias', async () => {
  const { bin, captureLaunchExecutable } = await fixture()
  const alias = join(root, 'path-alias'); symlinkSync(bin, alias); vi.stubEnv('PATH', alias)
  expect(await captureLaunchExecutable('opencode', '')).toMatchObject({ state: 'install' })
})

it('gives an npm engine Harness\'s Node, after the PATH, when the launch PATH has none', async () => {
  // Codex installed by the daemon with Harness's Node on a computer without one (fresh Ubuntu VM, 2026-10-11):
  // `#!/usr/bin/env node` found no node, so its probe and its pane both failed.
  const { bin, captureLaunchExecutable } = await fixture()
  const { managedNodePath } = await import('../../lib/nodeRuntime.js')
  writeFileSync(join(bin, 'opencode'), '#!/usr/bin/env node\nrequire("./opencode.js")\n', { mode: 0o700 })
  const result = await captureLaunchExecutable('opencode', '')
  expect(result).toMatchObject({ state: 'ready', environment: { PATH: `${bin}:${dirname(managedNodePath())}` } })
})
it('finds an npm engine beside Harness\'s Node, where its installer finds it', async () => {
  // A Codex there was "missing" to the daemon only: each launch dispatched an installer that exited 0 (2026-10-19).
  await fixture()
  const runtime = join(root, 'runtime'), nodeBin = join(runtime, 'node-fixture', 'bin'); mkdirSync(nodeBin, { recursive: true })
  writeFileSync(join(nodeBin, 'node'), '', { mode: 0o700 })
  writeFileSync(join(runtime, 'current-node'), join(nodeBin, 'node'))
  vi.stubEnv('ADAPTER_RUNTIME_DIR', runtime); vi.stubEnv('CODEX_PATH', '')
  vi.resetModules()
  const { captureLaunchExecutable } = await import('./launchExecutable.js')
  expect(await captureLaunchExecutable('codex', '')).toMatchObject({ state: 'install' })
  writeFileSync(join(nodeBin, 'codex'), '#!/usr/bin/env node\n', { mode: 0o700 })
  expect(await captureLaunchExecutable('codex', '')).toMatchObject({ state: 'ready', executable: { command: join(nodeBin, 'codex') } })
})
it('leaves the launch PATH alone for a Node the person has, and for an engine that is not a Node script', async () => {
  const { bin, withNodeForScript } = await fixture()
  const script = join(bin, 'codex'), node = join(root, 'harness-node', 'bin', 'node')
  const environment = { HOME: root, PATH: bin }
  writeFileSync(script, '#!/usr/bin/env -S node --no-warnings\n', { mode: 0o700 })
  expect(withNodeForScript(script, environment, node).PATH).toBe(`${bin}:${dirname(node)}`)
  expect(withNodeForScript(script, environment, 'node')).toBe(environment)
  expect(withNodeForScript(script, { ...environment, PATH: Array(256).fill(bin).join(':') }, node).PATH).toBe(Array(256).fill(bin).join(':'))
  writeFileSync(join(bin, 'node'), '', { mode: 0o700 })
  expect(withNodeForScript(script, environment, node)).toBe(environment)
  rmSync(join(bin, 'node'))
  for (const head of ['#!/bin/sh\nexec node "$0"\n', '#!/usr/bin/env nodejs\n', '\x7fELF']) {
    writeFileSync(script, head)
    expect(withNodeForScript(script, environment, node), head).toBe(environment)
  }
  expect(withNodeForScript(join(root, 'absent'), environment, node)).toBe(environment)
})

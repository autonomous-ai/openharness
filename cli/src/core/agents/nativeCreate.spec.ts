/** The real receipt → create → native hook proof → trust composition, with no real pane. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CreateAgentDeps } from './create.js'
import type { RegisteredSession } from '../../lib/registry.js'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('../../lib/createAgentPane.js', () => ({ createAndRegisterPane: spawn }))
let root: string
let stop: (() => void) | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'native-create-composition-'))
  for (const key of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'HARNESS_AUTH_DIR', 'HARNESS_HOOK_ROUTES_DIR', 'CODEX_HOME']) {
    const value = join(root, key.toLowerCase())
    mkdirSync(value, { recursive: true }); vi.stubEnv(key, value)
  }
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'ZDOTDIR', 'CODEX_PATH', 'CLAUDE_CONFIG_DIR', 'HARNESS_OS']) vi.stubEnv(key, '')
  const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nif [ "$1" = --version ]; then printf "codex-cli 0.160.0\\n"; else printf "%s\\n" "--no-daemon --approve-for-me"; fi\n', { mode: 0o700 })
  vi.stubEnv('SHELL', '/bin/sh'); vi.stubEnv('PATH', bin)
  writeFileSync(join(process.env.CODEX_HOME!, 'config.toml'), 'model_provider = "openai"\n')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.resetModules(); spawn.mockReset()
})
afterEach(() => {
  stop?.(); stop = undefined
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it('records Claude trust at its captured shell home when that shell omitted CLAUDE_CONFIG_DIR', async () => {
  const { folderTrust } = await import('../../engines/launchPrep.js')
  const selected = join(root, 'selected-home'); mkdirSync(selected)
  const config = join(selected, '.claude.json'); writeFileSync(config, '{}\n')
  const ambient = join(process.env.HOME!, '.claude.json'); writeFileSync(ambient, '{}\n')
  expect(folderTrust('claude', null, { HOME: selected })!.record('/fixture/work')).toBe('trusted')
  expect(JSON.parse(readFileSync(config, 'utf8')).projects['/fixture/work'].hasTrustDialogAccepted).toBe(true)
  expect(readFileSync(ambient, 'utf8')).toBe('{}\n')
})

it.each([true, false])('completes native Codex preparation before its dispatch claim with saved local authority %s', async local => {
  const { createAgentCreator } = await import('./create.js')
  const { createLaunchRequests } = await import('./launches.js')
  const { AgentCreationReceipts } = await import('../../lib/agentCreationReceipt.js')
  const { inspectNativeLaunch } = await import('../../engines/nativeLaunch.js')
  const { projectsRoot } = await import('../../lib/projectFolder.js')
  const cwd = join(projectsRoot(), 'workspace'); mkdirSync(cwd, { recursive: true })
  const config = join(process.env.CODEX_HOME!, 'config.toml')
  const pending = { agentId: 'fixture-agent', engine: 'codex', cwd, sessionId: '', runtimes: [] } as unknown as RegisteredSession
  spawn.mockImplementation(async (options: { current(): boolean; argv: string[] }) => {
    expect(options.current()).toBe(true)
    expect(readFileSync(config, 'utf8').includes('trust_level = "trusted"')).toBe(local)
    expect(options.argv.join(' ')).toContain('original prompt')
    return { ok: true, pending, spawned: { runtime: { backend: 'tmux', paneId: '%fixture' } } }
  })
  const creator = createAgentCreator({ native: (engine, source) => inspectNativeLaunch(engine, source),
    tmuxBackend: {} as CreateAgentDeps['tmuxBackend'], registry: {} as CreateAgentDeps['registry'],
    externalResume: async () => { throw Error('unexpected external resume') }, watchNewPane: async () => {},
    announceSession: () => {}, attachDsh: () => {}, prepareApiTools: () => {},
    hookPort: 19473, hooksDisabled: false, installOpencodePlugin: async () => true,
    gridLaunchMachine: () => ({}) as never, buildGridLaunch: async () => { throw Error('unexpected grid') },
    terminalHintMachineName: () => 'Fixture', blocksFolder: () => false, gridSetup: () => null, privateGridName: async () => null,
    dshLaunch: { launch: async () => { throw Error('unexpected DSH') }, materialize: async () => { throw Error('unexpected DSH') } },
  })
  const receipts = new AgentCreationReceipts(join(root, 'receipts'))
  const requests = createLaunchRequests({ receipts, createAgent: () => creator, prepareCreate: creator.prepare,
    forkAgent: () => null, resumeAgent: () => null, restartAgent: () => null,
    byAgent: () => pending, toProject: async () => ({ agentId: pending.agentId }) as never, modelTarget: async () => null })
  stop = requests.stop
  const replies: Record<string, unknown>[] = []
  const input = { creationId: 'native_trust_fixture_1', engine: 'codex', cwd, bypassPermission: false, prompt: 'original prompt' }
  await requests.create(input, { local }, result => { replies.push(result) })
  await vi.waitFor(() => expect(replies[0]).toMatchObject({ state: 'created' }), { timeout: 10_000 })
  expect(spawn).toHaveBeenCalledOnce()
  await requests.create(input, { local: !local }, result => { replies.push(result) })
  await vi.waitFor(() => expect(replies[1]).toMatchObject({ state: 'created' }))
  expect(spawn).toHaveBeenCalledOnce()
  expect(readFileSync(config, 'utf8').includes('trust_level = "trusted"')).toBe(local)
}, 20_000)

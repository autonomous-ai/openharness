/** Former-code launch answers and native commands, before OpenCode control becomes eager. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import type { AgentEngine } from './types.js'

const captured = vi.hoisted(() => ({ panes: [] as Record<string, any>[] }))
vi.mock('../lib/createAgentPane.js', () => ({ createAndRegisterPane: async (input: Record<string, any>) => {
  captured.panes.push(input)
  return { ok: false, error: 'RECORDED', detail: 'No pane is opened by this golden.' }
} }))
vi.mock('../lib/tmuxVersion.js', async real => ({ ...await real<object>(), tmuxSupportsSessionEnv: async () => true }))
vi.mock('../lib/tmux.js', async real => ({ ...await real<object>(), clearPaneRemainOnExit: async () => {}, processArgs: async () => '' }))
vi.mock('../lib/gatewayRuntime.js', async real => ({ ...await real<object>(), probeGatewayRuntime: async () => ({ kind: 'none' }) }))
vi.mock('../lib/binaryOnPath.js', async real => {
  const actual = await real<typeof import('../lib/binaryOnPath.js')>()
  return { ...actual, resolveBinaryOnPath: (name: string) => name === 'tmux' ? '/fixture/bin/tmux' : actual.resolveBinaryOnPath(name) }
})

const GOLDEN = fileURLToPath(new URL('./__fixtures__/opencode-launch.golden.json', import.meta.url))
const RECORD = process.env.RECORD_OPENCODE_LAUNCH_GOLDEN === '1'
let root = '', work = '', calls = ''
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const actual: Record<string, unknown> = {}

function normalize(value: unknown, label?: string): unknown {
  let text = JSON.stringify(value ?? null).split(root).join('<root>')
    .split(process.cwd()).join('<repo>')
    .split(process.execPath).join('<node>').split(dirname(process.execPath)).join('<node-dir>')
    .replace(/\/launch\/[0-9a-f-]{36}\.sh/g, '/launch/<script>.sh')
  if (label) text = text.split(label).join('<pane-label>')
  return JSON.parse(text)
}
function paneAnswer(): unknown {
  return captured.panes.map(pane => {
    const script = (pane.argv as string[]).map(arg => /^\. '(.+\/launch\/[0-9a-f-]{36}\.sh)'$/.exec(arg)?.[1]).find(Boolean)
    return normalize({ argv: pane.argv, env: pane.env, engine: pane.engine, agent: pane.agent, forkedFrom: pane.forkedFrom,
      permissionMode: pane.permissionMode, grid: pane.grid, gridLaunchRecord: pane.gridLaunchRecord,
      script: script ? readFileSync(script, 'utf8') : null }, pane.sessionLabel)
  })
}
function nativeCalls(): unknown[] {
  return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function resetCase(): void { captured.panes.length = 0; writeFileSync(calls, '') }
async function attempt(run: () => Promise<unknown>): Promise<unknown> {
  try { return await run() } catch (error) { return { threw: error instanceof Error ? { name: error.name, message: error.message } : String(error) } }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-launch-golden-')))
  work = join(root, 'work'); calls = join(root, 'calls.jsonl')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-09T00:00:00Z'))
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENCODE_DATA_DIR', 'OPENCODE_CONFIG_DIR']) {
    const path = join(root, name.toLowerCase()); mkdirSync(path, { recursive: true }); vi.stubEnv(name, path)
  }
  vi.stubEnv('TZ', 'UTC'); vi.stubEnv('SHELL', '/bin/sh'); vi.stubEnv('ZDOTDIR', join(root, 'zdotdir'))
  vi.stubEnv('CLAUDE_PATH', '/fixture/bin/claude'); vi.stubEnv('CODEX_PATH', '/fixture/bin/codex')
  vi.stubEnv('HARNESS_OS', ''); vi.stubEnv('HARNESS_GRID_BIN', '')
  mkdirSync(work); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'zdotdir'))
  vi.stubEnv('PATH', join(root, 'bin'))
  vi.stubEnv('OPENCODE_PATH', join(root, 'bin', 'v1'))
  // These binaries only report facts or record requests. They never launch an engine or open a real store.
  for (const [name, version] of [['v1', '1.18.31'], ['v2', 'opencode v2.0.18'], ['unknown', 'not-a-version']]) {
    writeFileSync(join(root, 'bin', name), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({binary:'opencode',args,cwd:process.cwd()})+'\\n');
if(args[0]==='--version') console.log(${JSON.stringify(version)});
else if(args[1]==='model.list') console.log(JSON.stringify({data:[{providerID:'fixture',id:'model'}]}));
else if(args[1]==='session.switchModel') { fs.writeFileSync(${JSON.stringify(join(root, 'model.json'))}, args[args.indexOf('-d')+1]); console.log('{}'); }
else if(args[1]==='session.get') console.log(JSON.stringify({data:JSON.parse(fs.readFileSync(${JSON.stringify(join(root, 'model.json'))},'utf8'))}));
else { console.error('Unexpected fixture command'); process.exitCode=1; }
`, { mode: 0o755 })
  }
  writeFileSync(join(root, 'bin', 'sqlite3'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({binary:'sqlite3',args:process.argv.slice(2)})+'\\n');
console.log('5000\\n1\\n1');
`, { mode: 0o755 })
  vi.resetModules()
})
afterAll(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platform)
  if (root) rmSync(root, { recursive: true, force: true })
})

it('records create, fork, relaunch and actual retarget dispatch before the extraction', async () => {
  const { launchShapes } = await import('../testing/launchShapes.js')
  const { opencodeMajorVersion } = await import('./opencode/version.js')
  const { createAgentRetargeter } = await import('../core/agents/retarget.js')
  const { buildEngineLaunchArgv } = await import('../lib/engineLaunch.js')
  const { env } = await import('../config/env.js')
  const world = { dataDir: join(root, 'adapter_data_dir'), machine: () => ({ hermesSystemManaged: false, opencodeMajor: opencodeMajorVersion() }),
    tmuxSupportsSessionEnv: async () => true, readCodexConfig: () => null, setGridLaunch: () => {} }
  const shapes = launchShapes(world)
  const row = (engine: AgentEngine, named = false): RegisteredSession => ({ agentId: 'fixture-agent', sessionId: 'ses_fixture', engine, cwd: work,
    registeredAt: Date.now(), active: true, runtimes: [{ backend: 'tmux', paneId: '%4' }], agent: named ? 'reviewer' : null,
    processIdentity: { pid: 4242, executable: engine, startMarker: 'fixture' }, grid: null, gridLaunch: null, codexHome: null,
    dsh: null, dshRuntime: null, scmLaunch: null, permissionMode: null, bypassPermission: false, subscriptionModel: 'fixture/model#high',
  }) as unknown as RegisteredSession
  const createRest = { tmuxBackend: {}, registry: {}, hooksDisabled: true, hookPort: 4242,
    installOpencodePlugin: async () => true, terminalHintMachineName: () => 'fixture-machine', blocksFolder: () => false,
    gridSetup: () => null, privateGridName: async () => null, watchNewPane: async () => {}, announceSession: () => {}, attachDsh: () => {},
  }
  for (const version of ['v1', 'v2', 'unknown', 'missing']) {
    vi.stubEnv('OPENCODE_PATH', join(root, 'bin', version))
    env.OPENCODE_PATH = join(root, 'bin', version)
    for (const named of [false, true]) {
      resetCase()
      const result = await attempt(() => shapes.create(createRest as never)({ engine: 'opencode', cwd: work, bypassPermission: false,
        permissionMode: null, grid: null, codexHome: null, dsh: null, prompt: 'fixture prompt', name: null,
        agent: named ? 'reviewer' : null, resumeSessionId: null, takeOver: null } as never))
      actual[`${version} create named=${named}`] = normalize({ result, panes: paneAnswer(), native: nativeCalls() })

      const source = row('opencode', named)
      resetCase()
      const fork = await shapes.fork({ tmuxBackend: {}, registry: { byAgent: () => source },
        mirror: { isBusy: () => false, recentAsks: () => ['fixture ask'], recent: () => [], lastFullText: () => 'fixture answer' },
        pendingForkInherit: new Map(), watchNewPane: async () => {}, announceSession: () => {}, attachDsh: () => {},
      } as never)({ agentId: source.agentId, name: null, prompt: 'try another approach' })
      actual[`${version} fork named=${named}`] = normalize({ result: fork, panes: paneAnswer(), native: nativeCalls() })

      resetCase()
      actual[`${version} relaunch named=${named}`] = normalize({ result: await shapes.relaunch(source), native: nativeCalls() })
    }

    resetCase()
    const source = row('opencode', true), events: unknown[] = []
    const event = (entry: unknown[]) => { events.push(entry); appendFileSync(calls, JSON.stringify({ control: entry }) + '\n') }
    const retarget = createAgentRetargeter({
      purgeBusy: () => false, tmuxBackend: { clearEnv: async (_pane: unknown, names: string[]) => { event(['clearEnv', names]); return { state: 'succeeded' } } },
      registry: { resolve: () => source, byAgent: () => source, updateProcessIdentity: (...args: unknown[]) => event(['process', ...args]),
        setGridLaunch: (...args: unknown[]) => event(['grid', ...args]), setSubscriptionModel: (...args: unknown[]) => event(['subscription', ...args]),
        setActive: (...args: unknown[]) => event(['active', ...args]) },
      runtimeProfiles: { selectedModel: () => null },
      launchOverridesDeps: { machine: world.machine, tmuxSupportsSessionEnv: world.tmuxSupportsSessionEnv },
      captureTerminal: async () => 'fixture idle', readScreen: async () => ({ pane: { idle: true } }),
      acquireTerminalControl: () => () => event(['release']), relaunchOverrides: shapes.relaunch,
      downgradedPermission: async () => ({ bypassPermission: false, permissionMode: null }),
      agentReconciler: { holdRoute: () => event(['holdRoute']), releaseRoute: () => event(['releaseRoute']) },
      restartJobs: { busy: () => false, cancel: () => event(['cancel']) },
      paneSwapDeps: (s: RegisteredSession, _pane: unknown, overrides: { extraArgs: string[]; env: unknown; clearEnv: string[] }) => ({
        holdOpen: async () => { event(['holdOpen']); return { ok: true } },
        terminate: async () => { event(['terminate']); return 'gone' },
        buildArgv: (options: { bypassPermission: boolean; resumeSessionId?: string }) => buildEngineLaunchArgv(s.engine, { ...options, cwd: s.cwd!, extraArgs: overrides.extraArgs }),
        respawn: async (argv: string[]) => {
          const script = argv.map(arg => /^\. '(.+\/launch\/[0-9a-f-]{36}\.sh)'$/.exec(arg)?.[1]).find(Boolean)
          event(['respawn', argv, overrides, script ? readFileSync(script, 'utf8') : null]); return { ok: true }
        },
        waitForProcess: async () => ({ pid: 4343, executable: 'opencode', startMarker: 'replacement' }), log: () => {},
      }),
      liveBypassPermission: async () => false, announceSession: () => event(['announce']), refreshGridAssignment: () => event(['assignment']),
      opencodeDb: join(root, 'fixture.db'),
    } as never)
    actual[`${version} retarget own login`] = normalize({ result: await retarget({ agentId: source.agentId, grid: null }), events, native: nativeCalls() })
  }
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n')
  else expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')))
}, 120_000)

it('contains no host paths or executable location', () => {
  const text = readFileSync(GOLDEN, 'utf8')
  expect(text).not.toContain(root)
  expect(text).not.toContain(process.execPath)
  expect(text).not.toMatch(/\/Users\/|\/home\/runner|opencode-launch-golden-/)
})

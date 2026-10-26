// Claude Code, Codex and OpenCode created through the daemon's own create path (core/agents/create.ts, its native
// inspection, launch argv and pane request) on the real Harness PTY host, with no POSIX shell anywhere. Windows only,
// on a machine where the engines are installed (and Claude Code and Codex signed in). Build the host first:
//   cd pty && cargo build
//   cd cli && set HARNESS_PTY_BIN=C:\...\pty\target\debug\harness-pty.exe && npx vitest run src/lib/windows/engineStart.real.spec.ts
// Engine hooks are not installed (DISABLE_HOOK_INSTALL's path): their POSIX ownership checks are another task's.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentCreator, type CreateAgentDeps } from '../../core/agents/create.js'
import { heldPaneArgv } from '../../core/agents/heldLaunches.js'
import { captureLaunchExecutable } from '../../engines/kit/launchExecutable.js'
import { inspectNativeLaunch } from '../../engines/nativeLaunch.js'
import type { AgentEngine } from '../../engines/types.js'
import { PtyHostBackend } from '../ptyHostBackend.js'
import { listDiscoveries } from '../ptyHost/launch.js'
import { PTY_PROTOCOL } from '../ptyHost/protocol.js'
import { processRows } from '../processTable.js'
import { registry, type RegisteredSession } from '../registry.js'
import { removeTree } from '../terminalBackend.contract.js'
import type { PtyRuntimeRef } from '../terminalTypes.js'
import { windowsAfterExit } from './engineStart.js'

const enabled = process.platform === 'win32' && !!process.env.HARNESS_PTY_BIN
const CASE_TIMEOUT_MS = 120_000
const POSIX_ONLY = /^(?:\/bin\/(?:sh|dash|bash|zsh)|\/usr\/bin\/env)$/

async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function withBackend(run: (backend: PtyHostBackend) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'pty-engines-'))
  const backend = new PtyHostBackend({ home })
  try {
    const prepared = await backend.prepare({ ownedPanes: new Map() })
    if (prepared.state !== 'ready') throw new Error(`the pty host is unavailable: ${prepared.reason}`)
    await run(backend)
  } finally {
    const discovery = listDiscoveries(home).findLast((found) => found.protocol === PTY_PROTOCOL)
    backend.dispose()
    if (discovery) try { process.kill(discovery.pid) } catch { /* gone */ }
    removeTree(home)
  }
}

/** The core's creator with the real native inspection, registry and pty host; every service it would ask is absent. */
function creator(backend: PtyHostBackend) {
  const unused = async () => { throw new Error('not used here') }
  const deps: CreateAgentDeps = {
    native: (engine, source) => inspectNativeLaunch(engine, source),
    createBackend: backend,
    noBackendCode: 'PTY_HOST_UNAVAILABLE',
    registry,
    externalResume: unused,
    watchNewPane: (async () => {}) as unknown as CreateAgentDeps['watchNewPane'],
    announceSession: () => {},
    attachDsh: () => {},
    prepareApiTools: () => {},
    hookPort: 0,
    hooksDisabled: true,
    installOpencodePlugin: async () => true,
    gridLaunchMachine: unused as unknown as CreateAgentDeps['gridLaunchMachine'],
    buildGridLaunch: unused,
    terminalHintMachineName: () => 'windows-vm',
    blocksFolder: () => false,
    gridSetup: () => null,
    privateGridName: async () => null,
    dshLaunch: { materialize: unused, launch: unused } as unknown as CreateAgentDeps['dshLaunch'],
  }
  return createAgentCreator(deps)
}

const request = (engine: AgentEngine, cwd: string) => ({
  engine, cwd, bypassPermission: false, permissionMode: null, grid: null, codexHome: null, dsh: null, prompt: null,
  name: null, agent: null, scmLaunchRecord: null, startedBy: null, parentAgentId: null,
}) as unknown as Parameters<ReturnType<typeof createAgentCreator>>[0]

/** Create [engine] through the core and wait for its process in the pane's Job; the evidence, for the report. */
async function created(backend: PtyHostBackend, engine: AgentEngine) {
  const cwd = mkdtempSync(join(tmpdir(), `ws-${engine}-`))
  const answer = await creator(backend)(request(engine, cwd))
  if (!answer.ok) throw new Error(`create ${engine}: ${JSON.stringify(answer)}`)
  const session = (answer as { session: RegisteredSession }).session
  const runtime = session.runtimes[0] as PtyRuntimeRef
  const host = (backend as unknown as { client: { call(op: object): Promise<{ state: string; value?: Record<string, unknown> }> } }).client
  const state = await host.call({ op: 'paneState', pane: runtime.paneId })
  const command = ((state.value?.state as { command?: string[] })?.command) ?? []
  console.log(`[${engine}] pane ${runtime.paneId} command ${JSON.stringify(command)}`)
  expect(command.filter((arg) => POSIX_ONLY.test(arg))).toEqual([])
  const validation = await until(() => backend.validate(runtime, { engine }), (v) => v.state === 'alive', 45_000)
  return { cwd, runtime, host, command, validation }
}

;(enabled ? describe : describe.skip)('engines created on the real pty host', () => {
  registry.load()

  // A grid launch's provider keys: the host inherited them from the daemon, and a pane told to clear them must not see
  // them, in any case of the name, while the rest of what it inherits stays (security; lib/windows/engineStart.ts).
  it('keeps the names a launch clears from what the host inherited, in any case, for that launch and its hand-off', async () => {
    const saved = { key: process.env.ANTHROPIC_API_KEY, kept: process.env.HN_KEPT_VARIABLE }
    process.env.ANTHROPIC_API_KEY = 'sk-person-secret'
    process.env.HN_KEPT_VARIABLE = 'kept'
    try {
      await withBackend(async (backend) => {
        const show = ['cmd.exe', '/d', '/k', 'echo [%ANTHROPIC_API_KEY%][%HN_KEPT_VARIABLE%][%GRID_KEY%]']
        for (const clearEnv of [['ANTHROPIC_API_KEY'], ['anthropic_api_key']]) {
          const created = await backend.create({ command: show, env: { GRID_KEY: 'grid' }, clearInherited: clearEnv })
          if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
          const seen = await until(() => backend.capture(created.runtime, { mode: 'visible', ansi: false }),
            (s) => s.state === 'succeeded' && s.value.includes('][kept][grid]'))
          expect(seen.state === 'succeeded' && seen.value).toContain('[%ANTHROPIC_API_KEY%][kept][grid]')
          expect(seen.state === 'succeeded' && seen.value).not.toContain('sk-person-secret')
          await backend.kill(created.runtime)
        }
        // Without the name cleared the child does see it: the host really has it.
        const plain = await backend.create({ command: show })
        if (plain.state !== 'succeeded') throw new Error('create failed')
        const leaked = await until(() => backend.capture(plain.runtime, { mode: 'visible', ansi: false }),
          (s) => s.state === 'succeeded' && s.value.includes('[sk-person-secret]'))
        expect(leaked.state === 'succeeded' && leaked.value).toContain('[sk-person-secret][kept]')
        await backend.kill(plain.runtime)
        // The engine's respawn and the shell it hands the pane to stay without it.
        const engine = await backend.create({ command: ['cmd.exe', '/c', 'exit 4'], clearInherited: ['ANTHROPIC_API_KEY'],
          afterExit: { command: show } })
        if (engine.state !== 'succeeded') throw new Error('create failed')
        const handed = await until(() => backend.capture(engine.runtime, { mode: 'visible', ansi: false }),
          (s) => s.state === 'succeeded' && s.value.includes('][kept]'))
        expect(handed.state === 'succeeded' && handed.value).toContain('[%ANTHROPIC_API_KEY%][kept]')
        // Per launch: a respawn with its own list clears that list alone; the last launch's names are back.
        await backend.respawn(engine.runtime, { command: show, clearInherited: ['HN_KEPT_VARIABLE'] })
        const respawned = await until(() => backend.capture(engine.runtime, { mode: 'visible', ansi: false }),
          (s) => s.state === 'succeeded' && s.value.includes('[%HN_KEPT_VARIABLE%]'))
        expect(respawned.state === 'succeeded' && respawned.value).toContain('[sk-person-secret][%HN_KEPT_VARIABLE%]')
        // And one that sends none (an agent moved off its grid) clears nothing the host inherited.
        await backend.respawn(engine.runtime, { command: show })
        const home = await until(() => backend.capture(engine.runtime, { mode: 'visible', ansi: false }),
          (s) => s.state === 'succeeded' && s.value.includes('[sk-person-secret][kept]'))
        expect(home.state === 'succeeded' && home.value).toContain('[sk-person-secret][kept]')
        await backend.kill(engine.runtime)
      })
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key
      if (saved.kept === undefined) delete process.env.HN_KEPT_VARIABLE; else process.env.HN_KEPT_VARIABLE = saved.kept
    }
  }, CASE_TIMEOUT_MS)

  it('hands a pane to cmd.exe, where there is no PowerShell, without leaving the engine\'s variables in it', async () => {
    await withBackend(async (backend) => {
      const created = await backend.create({ command: ['cmd.exe', '/c', 'exit 5'], afterExit: windowsAfterExit('codex', [process.env.ComSpec ?? 'cmd.exe']) })
      if (created.state !== 'succeeded') throw new Error('create failed')
      await until(() => backend.paneState(created.runtime), (p) => typeof p !== 'string' && p.engineExit === 5)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await backend.typeLiteral(created.runtime, 'echo [%HARNESS_ENGINE_COMMAND%][%HARNESS_ENGINE_EXIT%][%HARNESS_PANE:~0,1%]\n')
      const seen = await until(() => backend.capture(created.runtime, { mode: 'visible', ansi: false }),
        (s) => s.state === 'succeeded' && /^\[%HARNESS_ENGINE_COMMAND%\]/m.test(s.value))
      expect(seen.state === 'succeeded' && seen.value).toMatch(/^\[%HARNESS_ENGINE_COMMAND%\]\[%HARNESS_ENGINE_EXIT%\]\[p\]/m)
      expect(await backend.paneState(created.runtime)).toMatchObject({ dead: false, engineExit: 5 })
      await backend.kill(created.runtime)
    })
  }, CASE_TIMEOUT_MS)

  it('holds a pane in the daemon\'s Node, which says why and outlasts Ctrl-C', async () => {
    await withBackend(async (backend) => {
      const token = '0f0e0d0c-0b0a-4908-8706-050403020100'
      const created = await backend.create({ command: heldPaneArgv('Waiting for the Store.', token) })
      if (created.state !== 'succeeded') throw new Error(`create failed: ${JSON.stringify(created)}`)
      const shown = await until(() => backend.capture(created.runtime, { mode: 'visible', ansi: false }),
        (s) => s.state === 'succeeded' && s.value.includes('Waiting for the Store.'))
      expect(shown.state === 'succeeded' && shown.value).toContain('Waiting for the Store.')
      expect(await backend.isHeld(created.runtime, token)).toBe(true)
      const host = (backend as unknown as { client: { call(op: object): Promise<unknown> } }).client
      await host.call({ op: 'key', pane: created.runtime.paneId, key: 'C-c' })
      await host.call({ op: 'write', pane: created.runtime.paneId, data: Buffer.from('\u0003').toString('base64') })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(await backend.paneState(created.runtime)).toMatchObject({ dead: false })
      expect(await backend.rootProcess(created.runtime)).toEqual(expect.any(Number))
      await backend.kill(created.runtime)
    })
  }, CASE_TIMEOUT_MS)

  for (const engine of ['claude', 'codex', 'opencode'] as const) {
    it(`starts ${engine} with no POSIX shell, its process in the pane's Job, and the pane a shell after it`, async (context) => {
      // Found as the launch finds it (engines/kit/launchExecutable.ts). Only an engine that is not installed (CI's
      // runners, where the launch would install it first) skips, saying so; any other hold is a failure to read.
      const found = await captureLaunchExecutable(engine)
      if (found.state === 'install') context.skip(`${engine} is not installed here`)
      if (found.state === 'held') throw new Error(`${engine}'s launch could not resolve its executable: ${found.detail}`)
      await withBackend(async (backend) => {
        const home = process.env.HOME
        if (engine === 'codex') {
          // Codex's own login, in a home of the test's: the pane starts it with CODEX_HOME there. One that lasts from
          // run to run: Codex 0.162.1 migrating a new state_5.sqlite raced itself one start in four ("index
          // idx_threads_project_recency already exists", then exit 1), and it puts no helpers under a temporary folder.
          process.env.HOME = join(process.env.LOCALAPPDATA ?? tmpdir(), 'harness-engine-start-test')
          const auth = join(process.env.USERPROFILE ?? '', '.codex', 'auth.json')
          mkdirSync(join(process.env.HOME, '.codex'), { recursive: true })
          if (existsSync(auth)) copyFileSync(auth, join(process.env.HOME, '.codex', 'auth.json'))
        }
        try {
        const { cwd, runtime, host, command, validation } = await created(backend, engine)
        const job = await host.call({ op: 'jobPids', pane: runtime.paneId })
        const pids = (job.value?.pids as number[] | undefined) ?? []
        const rows = (await processRows()) ?? []
        const inJob = rows.filter((row) => pids.includes(row.pid)).map((row) => `${row.pid} <- ${row.parentPid} ${row.args.slice(0, 160)}`)
        console.log(`[${engine}] validate ${JSON.stringify(validation)}\n[${engine}] job:\n  ${inJob.join('\n  ')}`)
        if (engine === 'codex') expect(command).toContain('--no-daemon')
        // A few seconds on, the engine still runs in its own folder: its interactive start, not a quick exit.
        await new Promise((resolve) => setTimeout(resolve, 6_000))
        const screen = await backend.capture(runtime, { historyLines: 60, ansi: false })
        const pane = await backend.paneState(runtime)
        console.log(`[${engine}] after 6 s: ${JSON.stringify(pane)}\n[${engine}] screen:\n${screen.state === 'succeeded' ? screen.value.split('\n').filter((l) => l.trim()).slice(-30).join('\n') : screen.reason}`)
        const info = await backend.paneInfo(runtime)
        console.log(`[${engine}] pane info ${JSON.stringify(info)} (workspace ${cwd})`)
        expect(validation.state).toBe('alive')
        const history = screen.state === 'succeeded' ? screen.value : ''
        // OpenCode's terminal UI cannot load on Windows on Arm: its build has no bun:ffi (measured, OpenCode 1.19.0 on
        // the arm64 VM, 2026-10-15). It starts in the pane's Job, then exits of its own accord, and the pane hands on.
        const unsupported = engine === 'opencode' && process.arch === 'arm64' && /bun:ffi dlopen\(\) is not available/.test(history)
        if (!unsupported) {
          expect(pane).toMatchObject({ dead: false, engineExit: null })
          expect(info?.path.toLowerCase()).toBe(cwd.toLowerCase())
          // The engine ends: the pane is the person's shell, and the daemon reads why.
          backend.signalProcess(info!.pid!, 'SIGTERM')
        }
        const after = await until(() => backend.paneState(runtime), (p) => typeof p !== 'string' && p.engineExit !== null, 30_000)
        const shell = await until(() => backend.capture(runtime, { mode: 'visible', ansi: false }),
          (s) => s.state === 'succeeded' && /exited \(-?\d+\)\. This pane is a shell now/.test(s.value), 20_000)
        console.log(`[${engine}] after the engine: ${JSON.stringify(after)}\n${shell.state === 'succeeded' ? shell.value.split('\n').filter((l) => l.trim()).slice(-4).join('\n') : ''}`)
        expect(after).toMatchObject({ dead: false })
        expect(typeof after !== 'string' && after.engineExit).not.toBeNull()
        expect(typeof after !== 'string' && after.command).toMatch(/^(?:pwsh|powershell|cmd)\.exe$/i)
        expect(shell.state === 'succeeded' && shell.value).toMatch(new RegExp(`harness: ${engine} exited \\(-?\\d+\\)\\. This pane is a shell now`))
        await backend.kill(runtime)
        } finally { process.env.HOME = home }
      })
    }, CASE_TIMEOUT_MS)
  }
})

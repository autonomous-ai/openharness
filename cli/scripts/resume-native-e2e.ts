/** Real Claude/Codex + production resume handler, registry, hooks and tmux.
 * Native TUIs load disposable local history. Codex defers SessionStart until input;
 * its test prompt targets a deliberately unavailable loopback provider, never a paid API.
 * Run: node --import tsx scripts/resume-native-e2e.ts
 * Every service, profile, conversation and tmux socket belongs to this fixture.
 */
import { execFile as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { cleanupFixtureGit } from './native-fixture-git.js'
import assert from 'node:assert/strict'
import type { NativeResumeRequests } from '../src/testing/nativeResumeSocket.js'
const exec = promisify(execCallback)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-resume-native-')))
const cliRoot = resolve('.')
const tmuxBinary = (await exec('/usr/bin/which', ['tmux'])).stdout.trim()
const claudeBinary = realpathSync((await exec('/usr/bin/which', ['claude'])).stdout.trim())
const codexBinary = realpathSync((await exec('/usr/bin/which', ['codex'])).stdout.trim())
const socket = `resume-e2e-${process.pid}`
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const bin = join(root, 'bin'); mkdirSync(bin)
writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmuxBinary)} -L ${quote(socket)} -f /dev/null "$@"\n`, { mode: 0o700 })
// Do not propagate this agent's account, swarm or engine overrides into the disposable TUIs.
for (const key of Object.keys(process.env)) {
  if (/^(HARNESS|CODEX|CLAUDE|ANTHROPIC|OPENAI)_/.test(key) || key === 'CLAUDECODE') delete process.env[key]
}
// A home of the fixture's own, for the tmux server and every shell and engine it starts. With the person's,
// the shell a fixture pane keeps after its engine exits wrote the commands typed into it to their real
// ~/.zsh_history (two `printf 'SURVIVING_SHELL_…'` lines per run, found 2026-10-08). macOS's /etc/zshrc puts
// zsh's history in ${ZDOTDIR:-$HOME}, so both point here; HISTFILE covers a bash.
const home = join(root, 'home'); mkdirSync(home)
Object.assign(process.env, { HOME: home, ZDOTDIR: home, HISTFILE: join(home, '.shell_history') })
Object.assign(process.env, {
  PATH: `${bin}:${process.env.PATH}`, ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
  ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'), HARNESS_AUTH_DIR: join(root, 'auth'), DSH_DIR: join(root, 'dsh'),
  CLAUDE_PROJECTS_DIR: join(root, 'claude', 'projects'), CODEX_HOME: join(root, 'codex'), CLAUDE_PATH: claudeBinary, CODEX_PATH: codexBinary,
  HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
})
const tmux = async (...args: string[]) => (await exec(tmuxBinary, ['-L', socket, '-f', '/dev/null', ...args], { timeout: 5000 })).stdout
const { registry } = await import('../src/lib/registry.js')
const { stoppedAgents } = await import('../src/lib/stoppedAgents.js')
const { TmuxBackend } = await import('../src/lib/tmuxBackend.js')
const { createStopAgentService } = await import('../src/lib/stopAgentService.js')
const { CloseAgentService, inspectCloseActivity } = await import('../src/lib/closeAgentService.js')
const { sessionCheckpoints } = await import('../src/lib/sessionCheckpoint.js')
const { createHarnessResourcesReader } = await import('../src/lib/harnessResources.js')
const { CodexNormalizer } = await import('../src/engines/codex/normalizer.js')
const { lineToEvents, newTurnState } = await import('../src/lib/normalize.js')
const { agentFrame } = await import('../src/lib/agentFrame.js')
const { buildEngineLaunchArgv } = await import('../src/lib/engineLaunch.js')
const { createResumeAgentService } = await import('../src/lib/resumeAgentService.js')
const { AgentRestartCoordinator } = await import('../src/lib/restartAgent.js')
const { resolvePaneEngineProcess, checkSessionRuntime, lookupPaneEngineProcess, tmuxPaneProcessTree } = await import('../src/lib/tmux.js')
const { probeTerminalAgents } = await import('../src/lib/terminalAgentDiscovery.js')
const { captureResumeIdentity } = await import('../src/lib/captureResumeIdentity.js')
const { processSessionOf } = await import('../src/lib/sessionRepair.js')
const { checkPidRuntime } = await import('../src/lib/deleteAgentFallback.js')
const { startHookServer } = await import('../src/hookServer.js')
const { BackendSocket } = await import('../src/backendSocket.js')
const { bindNativeResumeRequests } = await import('../src/testing/nativeResumeSocket.js')
const { engineHooks } = await import('../src/engines/hooks.js')
// The engines' screen readers and Codex's shared app-server control, composed in this process as the
// daemon's inline mode does: the fixture runs no engine workers.
const { readInlineScreen } = await import('../src/testing/inlineScreen.js')
const { inlineNativeControls } = await import('../src/testing/inlineNativeControls.js')
const backend = new TmuxBackend()
const socketBackend = new BackendSocket('fixture-only')
const hooks: Array<{ engine: string; sessionId: string }> = []
const server = await startHookServer(0, {
  onSessionEnd: () => {},
  onRegistered: row => { stoppedAgents.save(row); hooks.push({ engine: row.engine, sessionId: row.sessionId }); if (row.resumeOnly) stoppedAgents.finishResume(row.agentId) },
  resolveHookAgent: async input => {
    if (!input.tmuxPane) return null
    const identity = await resolvePaneEngineProcess(input.tmuxPane, input.engine)
    if (!identity) { console.error('[fixture] no process for', input,
      await lookupPaneEngineProcess(input.tmuxPane, input.engine), await tmuxPaneProcessTree(input.tmuxPane)); return null }
    const row = registry.byPaneEngine(input.tmuxPane, input.engine)
    if (!row || row.engine !== input.engine) { console.error('[fixture] no registry route', input, identity, registry.list().map(r => ({ id: r.agentId, pane: r.tmuxPane }))); return null }
    return registry.openProcessAgent({ engine: input.engine, processIdentity: identity, runtimes: row.runtimes, primaryRuntimeKey: row.primaryRuntimeKey, cwd: row.cwd })?.entry ?? null
  },
})
let nativeRequests: NativeResumeRequests | undefined
const fixtures: Array<{ agentId: string; engine: string; sessionId: string; marker: string }> = []
const replies = new Map<string, any>()
socketBackend.registerLocalClient('local:resume-e2e', { sendFrame: frame => { const f = frame as any; if (f.payload?.requestId) replies.set(f.payload.requestId, f.payload); return true }, sendBinary: () => true })
const rpc = async (type: string, payload: Record<string, unknown>) => {
  const requestId = randomUUID(); socketBackend.handleLocalFrame('local:resume-e2e', { type, payload: { ...payload, requestId } })
  const until = Date.now() + 55000
  while (!replies.has(requestId) && Date.now() < until) await new Promise(r => setTimeout(r, 20))
  const response = replies.get(requestId); assert(response, `missing ${type} reply`); return response
}
const log = (msg: string) => console.log(`[resume-native] ${msg}`)


try {
  // Anchor keeps pane IDs monotonic even after Stop removes the last engine session.
  await tmux('new-session', '-d', '-s', 'fixture-anchor', '/bin/sh')
  for (const engine of ['claude', 'codex'] as const) {
    const selected = process.argv.find(arg => arg.startsWith('--engine='))?.slice('--engine='.length)
    if (selected && selected !== engine) continue
    const cwd = join(root, engine, 'workspace'); mkdirSync(cwd, { recursive: true })
    const profile = join(root, engine)
    const sessionId = randomUUID(); const marker = `RESUME_HISTORY_${engine}_${sessionId.slice(0, 8)}`
    const timestamp = new Date().toISOString()
    let transcriptPath: string
    if (engine === 'claude') {
      const project = join(profile, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(project, { recursive: true })
      transcriptPath = join(project, `${sessionId}.jsonl`)
      const user = randomUUID()
      writeFileSync(transcriptPath, [
        { type: 'user', uuid: user, parentUuid: null, sessionId, cwd, version: '2.1.278', timestamp, isSidechain: false, userType: 'external', message: { role: 'user', content: marker } },
        { type: 'assistant', uuid: randomUUID(), parentUuid: user, sessionId, cwd, version: '2.1.278', timestamp, isSidechain: false, message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: `Retained ${marker}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n')
      writeFileSync(join(profile, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: [] } } }))
      const cmd = [process.execPath, join(cliRoot, 'hook', 'notify.mjs'), '--port', String(server.port), '--data-dir', process.env.ADAPTER_DATA_DIR!, '--claude-projects-dir', process.env.CLAUDE_PROJECTS_DIR!].map(quote).join(' ')
      writeFileSync(join(profile, 'settings.json'), JSON.stringify({ apiKeyHelper: 'printf fixture-never-used', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }] } }))
    } else {
      const folder = join(profile, 'sessions', timestamp.slice(0,4), timestamp.slice(5,7), timestamp.slice(8,10)); mkdirSync(folder, { recursive: true })
      transcriptPath = join(folder, `rollout-${timestamp.slice(0, 19).replace(/:/g, '-')}-${sessionId}.jsonl`)
      writeFileSync(transcriptPath, [
        { timestamp, type: 'session_meta', payload: { id: sessionId, timestamp, cwd, originator: 'codex_cli_rs', cli_version: '0.154.0', source: 'cli', model_provider: 'fixture' } },
        { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: sessionId, model_context_window: 100000 } },
        { timestamp, type: 'event_msg', payload: { type: 'user_message', message: marker, images: [], local_images: [], text_elements: [] } },
        { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] } },
        { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Retained ${marker}` }] } },
        { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: `Retained ${marker}`, phase: 'final_answer' } },
        { timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: sessionId, last_agent_message: `Retained ${marker}` } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n')
      writeFileSync(join(profile, 'config.toml'), `model_provider = "fixture"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n[features]\nhooks = true\n`)
      engineHooks.codex.installIn(server.port, profile)

    }
    const old = registry.openPendingAgent({ engine, runtimes: [{ backend: 'tmux', paneId: '%99999' }], cwd, codexHome: engine === 'codex' ? profile : null, defaultName: `Native ${engine} fixture` })!
    const saved = { ...old, sessionId, transcriptPath, launch: { state: 'ready' as const }, processIdentity: null }
    stoppedAgents.save(saved); registry.removeAgent(old.agentId)
    fixtures.push({ agentId: old.agentId, engine, sessionId, marker })
    const launchEnv: Record<string, string> = {
      CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), ZDOTDIR: root,
      DISABLE_AUTOUPDATER: '1', DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      PATH: `${bin}:${process.env.PATH}`, HARNESS_HOOK_DATA_DIR: process.env.ADAPTER_DATA_DIR!,
    }
    if (engine === 'codex') {
      const bootstrap = await backend.create({ cwd, label: 'fixture-hook-trust', command: buildEngineLaunchArgv('codex', { extraArgs: ['--no-alt-screen'] }), env: launchEnv })
      assert.equal(bootstrap.state, 'succeeded')
      if (bootstrap.state === 'succeeded') {
        const until = Date.now() + 15000
        let trusted = false
        while (Date.now() < until) {
          const screen = await tmux('capture-pane', '-p', '-t', bootstrap.runtime.paneId)
          if (/Hooks need review/.test(screen)) await tmux('send-keys', '-t', bootstrap.runtime.paneId, 'Down', 'Enter')
          if (readFileSync(join(profile, 'config.toml'), 'utf8').includes('trusted_hash')) { trusted = true; break }
          await new Promise(r => setTimeout(r, 200))
        }
        assert(trusted, 'Codex must trust fixture hooks through its native review UI')
        await backend.kill(bootstrap.runtime)
      }
    }
    const jobs = new AgentRestartCoordinator()
    const stopJobs = new Map<string, Promise<void>>()
    const stopAgent = createStopAgentService({
      registry, stoppedAgents, restartJobs: jobs, stopJobs, tmuxBackend: backend,
      agentReconciler: { suppress: () => {}, holdRoute: () => {}, releaseRoute: () => {}, trigger: async () => {} },
      forgetSession: id => { registry.removeAgent(id); socketBackend.send({ type: 'agent_deleted', payload: { agentId: id, retained: true } }) }, markDeleted: () => {}, clearDeleted: () => {},
      stopNative: inlineNativeControls().stop,
    })
    socketBackend.closeAgentService?.dispose()
    socketBackend.closeAgentService = new CloseAgentService({
      registry,
      activity: async row => {
        const screen = await tmux('capture-pane', '-p', '-S', '-80', '-t', row.tmuxPane)
        const raw = row.transcriptPath ? readFileSync(row.transcriptPath, 'utf8').trim().split('\n') : []
        let turnOpen: boolean | undefined
        if (row.engine === 'codex') {
          const normalizer = new CodexNormalizer('live')
          for (const line of raw) normalizer.ingest(line)
          if (raw.length) turnOpen = normalizer.turnOpen
        } else if (row.engine === 'claude') {
          const state = newTurnState()
          for (const line of raw) lineToEvents(line, state)
          if (raw.length) turnOpen = state.turnOpen
        }
        return inspectCloseActivity(row, await readInlineScreen(row, screen), turnOpen, false)
      },
      checkpoint: async (row, phase) => sessionCheckpoints.save(row, {
        screen: phase === 'before' ? await tmux('capture-pane', '-p', '-S', '-2000', '-t', row.tmuxPane) : null,
      }),
      stop: stopAgent, changed: row => { void agentFrame(row, { selectedModel: null, terminalAvailable: true, dsh: null }).then(agent => socketBackend.send({ type: 'agent_synced', payload: { agent } })) },
    })
    const resumeAgent = createResumeAgentService({
      registry, stoppedAgents, tmuxBackend: backend, restartJobs: jobs, stopJobs, pinnedControls: new Set(),
      announceSession: () => {}, relaunchOverrides: async () => ({ ok: true, overrides: { env: launchEnv, extraArgs: [], clearEnv: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDECODE'] } }),
      prepareSessionResume: () => {}, refreshGridWebSearch: () => {}, clearDeleted: () => {}, attachDsh: () => {},
      // This fixture checks the native TUI's history directly; it has no daemon transcript watcher.
      attachSession: async () => false,
      retainExitedSession: (row, alive) => { stoppedAgents.save(row); if (alive) registry.releaseEngine(row.agentId, true); else registry.removeAgent(row.agentId) },
    })
    nativeRequests = { resume: resumeAgent, stop: stopAgent }
    bindNativeResumeRequests(socketBackend, nativeRequests)
    const inventory = await rpc('agents_list', { includeStopped: true })
    assert(inventory.agents.some((a: any) => a.id === old.agentId && a.status === 'stopped'))
    const openSaved = async (creationId: string) => {
      // Warm the same catalog used by status updates before each real resume.
      // The action must revalidate disk state, and the resumed row must stop
      // appearing among saved sessions without waiting for a cache timeout.
      for (let i = 0; i < 2; i++) {
        const savedInventory = await rpc('agents_list', { includeStopped: true })
        const rows = savedInventory.agents.filter((a: any) => a.id === old.agentId)
        assert.equal(rows.length, 1, 'the catalog must not duplicate or lose the conversation')
        // After an external engine exit, this fixture intentionally leaves the
        // old registry route until resume repairs it and preserves its shell.
        if (!registry.advertised().some(row => row.agentId === old.agentId)) assert.equal(rows[0].status, 'stopped')
      }
      let settled = false, submitted = false, historyVisible = false
      const hookCount = hooks.length
      const nativeHookSeen = () => hooks.some(h => h.engine === engine && h.sessionId === sessionId)
      const needHook = !nativeHookSeen()
      const opening = rpc('agent_resume', { agentId: old.agentId, creationId }).finally(() => { settled = true })
      const deadline = Date.now() + 45000
      // Readiness now uses the live process and can precede the first TUI paint or startup hook.
      // Verify those independently; finishing the RPC must not stop this fixture from driving
      // Codex's deferred hook through its loopback-only synthetic turn.
      while ((!settled || !historyVisible || (needHook && !nativeHookSeen())) && Date.now() < deadline) {
        const row = registry.byAgent(old.agentId)
        if (row) {
          await tmux('resize-window', '-t', row.tmuxPane, '-x', '140', '-y', '45')
          const screen = await tmux('capture-pane', '-p', '-S', '-500', '-t', row.tmuxPane)
          historyVisible ||= screen.includes(marker)
          writeFileSync(join(root, `${engine}-screen.txt`), screen)
          if (/Hooks need review/.test(screen)) await tmux('send-keys', '-t', row.tmuxPane, 'Down', 'Enter')
          if (/trust this folder|trust the files|Yes, I trust|confirm.*API key/i.test(screen)) await tmux('send-keys', '-t', row.tmuxPane, 'Enter')
          // Codex 0.154 defers SessionStart until the next submitted turn. First prove
          // that opening alone restored visible history, then simulate user input so
          // the real hook can confirm the receipt. Production never submits a prompt.
          if (engine === 'codex' && needHook && !submitted && hooks.length === hookCount && screen.includes(marker) && /Ask Codex/.test(screen)) {
            submitted = true
            log('Codex history is visible before input; verifying its deferred native hook')
            await tmux('send-keys', '-t', row.tmuxPane, '-l', 'Fixture verification only. Do not use tools.')
            await new Promise(r => setTimeout(r, 600))
            await tmux('send-keys', '-t', row.tmuxPane, 'Enter')
          }
        }
        await new Promise(r => setTimeout(r, 250))
      }
      assert(settled, `${engine} did not confirm: ${readFileSync(join(root, `${engine}-screen.txt`), 'utf8')}`)
      assert(historyVisible, `${engine} did not render the saved conversation`)
      assert(!needHook || nativeHookSeen(), `${engine} did not send its native SessionStart`)
      assert(!stoppedAgents.available(registry.advertised()).some(row => row.agentId === old.agentId),
        'a resumed conversation must immediately leave the saved catalog')
      return opening
    }
    const creationId = randomUUID()
    const result = await openSaved(creationId)
    assert.equal(result.state, 'created', JSON.stringify(result)); assert.equal(result.resumed, true)
    const live = registry.byAgent(old.agentId)!
    assert.equal(live.sessionId, sessionId); assert.equal(live.launch?.state, 'ready'); assert(live.processIdentity)
    const discovery = await probeTerminalAgents([backend], ['tmux'])
    assert(discovery.processTableAvailable, 'native process table must be readable')
    const discovered = discovery.agents.filter(agent => agent.runtimes.some(runtime => runtime.paneId === live.tmuxPane))
    assert.equal(discovered.length, 1, 'the live discovery coordinator must identify exactly one engine in the resumed pane')
    assert.equal(discovered[0].engine, engine)
    assert.equal(discovered[0].processIdentity.pid, live.processIdentity.pid)
    assert.equal(discovered[0].processIdentity.startMarker, live.processIdentity.startMarker)
    log(`${engine}: live coordinator identified the resumed process`)
    assert(hooks.some(h => h.engine === engine && h.sessionId === sessionId), 'native SessionStart must confirm saved id')
    const screen = await tmux('capture-pane', '-p', '-S', '-500', '-t', live.tmuxPane)
    assert(screen.includes(marker), 'restored conversation text must be visible')
    const pid = live.processIdentity!.pid; const route = live.tmuxPane
    const neighbour = (await tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', route, '/bin/sh')).trim()
    const neighbourPid = (await tmux('display-message', '-p', '-t', neighbour, '#{pane_pid}')).trim()
    assert.equal((await checkSessionRuntime(live)).state, 'alive')
    const reattached = await rpc('agent_resume', { agentId: old.agentId, creationId: randomUUID() })
    assert.equal(reattached.resumed, true, JSON.stringify(reattached))
    assert.equal(registry.byAgent(old.agentId)!.processIdentity!.pid, pid); assert.equal(registry.byAgent(old.agentId)!.tmuxPane, route)
    assert.equal((await rpc('agent_create_status', { creationId })).state, 'created')
    // Reproduce a legacy daemon row whose hook binding was lost. Remove the earlier
    // archive too, so Stop must recover from the real process, not the seeded snapshot.
    registry.unbindSession(sessionId)
    rmSync(join(root, 'data', 'stopped-agents', `${old.agentId}.json`))
    const unbound = registry.byAgent(old.agentId)!
    assert.equal(unbound.sessionId, '')
    assert.equal((await captureResumeIdentity(unbound)).sessionId, sessionId)
    if (engine === 'claude') {
      assert.equal((await processSessionOf('claude', unbound.processIdentity!.pid, cwd,
        Date.parse(unbound.processIdentity!.startMarker)))?.sessionId, sessionId,
      'Claude native process metadata identifies the conversation before Stop')
    }
    // Stop uses a known fixture-owned tmux session; its saved row survives a registry reload.
    assert.equal((await rpc('agent_delete', { agentId: live.agentId })).deleted, true)
    assert.equal((await checkPidRuntime(live)).state, 'gone')
    assert.equal((await tmux('display-message', '-p', '-t', neighbour, '#{pane_pid}')).trim(), neighbourPid,
      'Stop must preserve unrelated work in another pane of the same tmux session')
    registry.load(); assert(!registry.byAgent(old.agentId)); assert.equal(stoppedAgents.get(old.agentId)!.sessionId, sessionId)
    assert((await rpc('agents_list', { includeStopped: true })).agents.some((a: any) => a.id === old.agentId && a.status === 'stopped'))
    const reopened = await openSaved(randomUUID())
    assert.equal(reopened.state, 'created', JSON.stringify(reopened))
    assert.equal(registry.byAgent(old.agentId)!.sessionId, sessionId)
    assert.notEqual(registry.byAgent(old.agentId)!.tmuxPane, route)
    assert.notEqual(registry.byAgent(old.agentId)!.processIdentity!.pid, pid)
    // A native engine exit is different from Stop: preserve the surviving shell
    // and prove that resuming the conversation never replaces that shell's work.
    const exited = { ...registry.byAgent(old.agentId)! }
    assert.equal((await checkSessionRuntime(exited)).state, 'alive')
    assert(exited.cwd?.startsWith(root), 'only a fixture-owned process may be signaled')
    process.kill(exited.processIdentity!.pid, 'SIGTERM')
    const exitDeadline = Date.now() + 10000
    while ((await checkPidRuntime(exited)).state !== 'gone' && Date.now() < exitDeadline) await new Promise(r => setTimeout(r, 100))
    assert.equal((await checkPidRuntime(exited)).state, 'gone')
    const shellMarker = `SURVIVING_SHELL_${engine}`
    await new Promise(r => setTimeout(r, 300))
    await tmux('send-keys', '-t', exited.tmuxPane, '-l', `printf '${shellMarker}\\n'; sleep 30`)
    await tmux('send-keys', '-t', exited.tmuxPane, 'Enter')
    const shellPid = (await tmux('display-message', '-p', '-t', exited.tmuxPane, '#{pane_pid}')).trim()
    const afterExit = await openSaved(randomUUID())
    assert.equal(afterExit.state, 'created')
    assert.equal(registry.byAgent(old.agentId)!.sessionId, sessionId)
    assert.notEqual(registry.byAgent(old.agentId)!.tmuxPane, exited.tmuxPane)
    const shell = registry.byRuntimeTerminal({ backend: 'tmux', paneId: exited.tmuxPane })!
    assert.equal(shell.engine, 'terminal'); assert.notEqual(shell.agentId, old.agentId)
    assert.equal((await tmux('display-message', '-p', '-t', exited.tmuxPane, '#{pane_pid}')).trim(), shellPid)
    assert((await tmux('capture-pane', '-p', '-t', exited.tmuxPane)).includes(shellMarker))
    assert.equal((await rpc('agent_delete', { agentId: old.agentId })).deleted, true)
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.equal((await openSaved(randomUUID())).state, 'created')
      const current = registry.byAgent(old.agentId)!
      assert.equal(current.sessionId, sessionId)
      const closeTarget = { agentId: current.agentId, sessionId: current.sessionId, createdAt: new Date(current.registeredAt).toISOString() }
      // Deferred intent is durable, but opening/cancelling must leave the same process alive.
      assert.equal((await rpc('agent_close', { ...closeTarget, mode: 'after_task' })).deferred, true)
      registry.load()
      assert.equal(registry.byAgent(current.agentId)?.closePlan?.state, 'waiting')
      assert.equal((await rpc('agent_close', { ...closeTarget, mode: 'cancel' })).cancelled, true)
      assert.equal((await checkPidRuntime(current)).state, 'alive')
      const reading = (await createHarnessResourcesReader(() => [current])()).agents[0]
      assert(reading.memoryBytes !== null && reading.memoryBytes > 0, 'monitor must read the real process tree')
      const inspected = await rpc('agent_close', { ...closeTarget, mode: 'inspect' })
      assert(inspected.activity, JSON.stringify(inspected))
      const paused = await rpc('agent_close', { ...closeTarget, mode: inspected.activity === 'idle' ? 'idle' : 'now' })
      assert.equal(paused.closed, true, JSON.stringify(paused))
      assert.equal((await checkPidRuntime(current)).state, 'gone')
      const after = (await createHarnessResourcesReader(() => [current])()).agents[0]
      assert.equal(after.memoryBytes, null, 'a dead process must not retain an old RAM reading')
      const folder = join(root, 'data', 'session-checkpoints')
      const manifest = readdirSync(folder).filter(f => /^[a-f0-9]{64}\.json$/.test(f))
        .map(f => JSON.parse(readFileSync(join(folder, f), 'utf8'))).find(m => m.agentId === current.agentId)
      assert(manifest, 'close must commit a durable checkpoint')
      assert(readFileSync(join(folder, manifest.file), 'utf8').includes(marker), 'checkpoint must retain the original conversation')
      log(`${engine} close ${cycle + 1}: ${inspected.activity}, ${Math.round(reading.memoryBytes / 1024 / 1024)} MB released, checkpoint verified`)
    }
    if (engine === 'claude') {
      assert.equal((await openSaved(randomUUID())).state, 'created')
      const current = registry.byAgent(old.agentId)!
      const queued = await rpc('agent_close', { agentId: current.agentId, sessionId: current.sessionId,
        createdAt: new Date(current.registeredAt).toISOString(), mode: 'after_task' })
      assert.equal(queued.deferred, true)
      const deferredDeadline = Date.now() + 25000
      while (registry.byAgent(current.agentId) && Date.now() < deferredDeadline) await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(registry.byAgent(current.agentId), undefined, 'a deferred idle close must complete without another client request')
      assert.equal((await checkPidRuntime(current)).state, 'gone')
      assert.equal(stoppedAgents.get(current.agentId)?.sessionId, sessionId)
      log('PASS deferred close: real idle Claude saved and exited through the background timer')
    }
    log(`PASS ${engine}: native history + hook, three close/checkpoint/resume cycles, deferred close persistence/cancel, measured RAM released, new tmux runtime, same id, attach same PID, receipt replay, missing-ID recovery before Stop, neighbouring pane and surviving shell preserved`)
  }
  if (process.argv.includes('--serve')) {
    // The desktop acceptance test uses the real local WS transport and terminal streams.
    // HTTP supplies only fixture metadata and assertions, never fabricated RPC results.
    const { attachLocalWsServer } = await import('../src/localWsServer.js')
    const { TerminalStreamManager } = await import('../src/lib/terminalStreamManager.js')
    const { TerminalBackendCoordinator } = await import('../src/lib/terminalBackendCoordinator.js')
    const streams = new TerminalStreamManager({
      terminals: new TerminalBackendCoordinator([backend], ['tmux']),
      resolveAgent: id => registry.byAgent(id), streamingAvailable: true,
      sendTarget: (id, type, payload) => socketBackend.sendTerminalTo(id, type, payload),
      sendBinaryTarget: (id, frame) => socketBackend.sendTerminalBinaryTo(id, frame),
      isLoopback: () => true,
    })
    socketBackend.setTerminalStreamManager(streams)
    const anchorPane = (await tmux('display-message', '-p', '-t', 'fixture-anchor', '#{pane_id}')).trim()
    const anchor = registry.openPendingAgent({ engine: 'terminal', runtimes: [{ backend: 'tmux', paneId: anchorPane }], cwd: root, defaultName: 'Keep this work open' })!
    registry.setLaunch(anchor.agentId, { state: 'ready' })
    assert(nativeRequests)
    const { resume, stop } = nativeRequests
    nativeRequests.resume = async (id, permissionMode) => {
      const fixture = fixtures.find(f => f.agentId === id); assert(fixture, 'only fixture sessions may resume')
      let done = false
      const result = resume(id, permissionMode).finally(() => { done = true })
      let announced = ''
      while (!done) {
        const row = registry.byAgent(id)
        if (row) {
          const state = `${row.tmuxPane}:${row.launch?.state}`
          if (state !== announced) {
            announced = state
            socketBackend.send({ type: 'agent_synced', payload: { agent: await agentFrame(row, { selectedModel: null, terminalAvailable: true, dsh: null }) } })
          }
          // The standalone native check already proved the deferred startup
          // hook. UI resume must behave like production: never submit a turn.
        }
        await new Promise(r => setTimeout(r, 100))
      }
      return result
    }
    nativeRequests.stop = async id => {
      assert(fixtures.some(f => f.agentId === id), 'never stop the anchor or a non-fixture session')
      const before = JSON.stringify(registry.byAgent(id))
      try { await stop(id) }
      catch (error) {
        console.error('[resume-native] native pause failed:', error, { before, after: JSON.stringify(registry.byAgent(id)) })
        throw error
      }
    }
    let finish!: () => void
    const finished = new Promise<void>(resolve => { finish = resolve })
    const http = createServer((req, res) => { void (async () => {
      res.setHeader('content-type', 'application/json')
      const url = new URL(req.url!, 'http://127.0.0.1')
      if (url.pathname === '/fixtures') { res.end(JSON.stringify({ fixtures, anchorId: anchor.agentId })); return }
      if (url.pathname === '/shutdown' && req.method === 'POST') { res.end('{}'); finish(); return }
      if (url.pathname === '/verify') {
        const id = url.searchParams.get('id')!
        const fixture = fixtures.find(f => f.agentId === id); assert(fixture)
        const row = registry.byAgent(id)
        const saved = stoppedAgents.get(id)
        assert.equal(saved?.sessionId, fixture.sessionId)
        if (row) {
          assert.equal(row.sessionId, fixture.sessionId)
          // Process readiness precedes the native TUI's first paint. Check the
          // real terminal with a bounded wait, including background resumes.
          let screen = ''
          const paintDeadline = Date.now() + 10000
          do {
            screen = await tmux('capture-pane', '-p', '-S', '-500', '-t', row.tmuxPane)
            if (screen.includes(fixture.marker)) break
            await new Promise(resolve => setTimeout(resolve, 100))
          } while (Date.now() < paintDeadline)
          assert(screen.includes(fixture.marker), 'native terminal must show original history')
        } else {
          assert.equal((await checkPidRuntime(saved!)).state, 'gone', 'Paused must mean the original process is gone')
        }
        const persisted = JSON.parse(readFileSync(join(root, 'data', 'registry.json'), 'utf8'))
        assert.equal(persisted.some((r: any) => r.agentId === id), !!row)
        res.end(JSON.stringify({ stopped: !row, sessionId: saved!.sessionId, pane: row?.tmuxPane, pid: row?.processIdentity?.pid, ready: row?.launch?.state === 'ready' })); return
      }
      res.statusCode = 404; res.end('{}')
    })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })) }) })
    const local = attachLocalWsServer(http, { machineId: 'm', backend: socketBackend })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const endpoint = `http://127.0.0.1:${(http.address() as { port: number }).port}`
    writeFileSync(join(tmpdir(), 'harness-resume-ui-endpoint.json'), JSON.stringify({ endpoint, root }))
    log(`desktop fixture ready: ${endpoint}`)
    const expiry = setTimeout(finish, 30 * 60_000)
    process.once('SIGINT', finish); process.once('SIGTERM', finish)
    await finished
    clearTimeout(expiry); process.off('SIGINT', finish); process.off('SIGTERM', finish)
    await local.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()))
  }
} finally {
  await tmux('kill-server').catch(() => {})
  server.server.closeAllConnections(); await new Promise<void>(r => server.server.close(() => r()))
  await socketBackend.stop()
  log(`fixture Git cleanup verified (${await cleanupFixtureGit(root)} processes)`)
  // Keep fixture diagnostics when requested; contains only synthetic history, no credentials.
  if (process.env.KEEP_RESUME_FIXTURE === '1') log(`fixture: ${root}`)
  else {
    // A shell can flush .zsh_history just after tmux exits. Retry the whole walk,
    // not only rmdir, so a late-created file is discovered and removed as well.
    for (let attempt = 0; ; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 5) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
}

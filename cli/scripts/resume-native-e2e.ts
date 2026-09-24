/** Real Claude/Codex + production resume handler, registry, hooks and tmux.
 * Native TUIs load disposable local history. Codex defers SessionStart until input;
 * its test prompt targets a deliberately unavailable loopback provider, never a paid API.
 * Run: node --import tsx scripts/resume-native-e2e.ts
 * Every service, profile, conversation and tmux socket belongs to this fixture.
 */
import { execFile as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
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
const { createResumeAgentService } = await import('../src/lib/resumeAgentService.js')
const { AgentRestartCoordinator } = await import('../src/lib/restartAgent.js')
const { resolvePaneEngineProcess, checkSessionRuntime } = await import('../src/lib/tmux.js')
const { captureResumeIdentity } = await import('../src/lib/captureResumeIdentity.js')
const { claudeProcessSession } = await import('../src/lib/sessionRepair.js')
const { checkPidRuntime } = await import('../src/lib/deleteAgentFallback.js')
const { startHookServer } = await import('../src/hookServer.js')
const { BackendSocket } = await import('../src/backendSocket.js')
const { installCodexHooks } = await import('../src/lib/hooks.js')
const backend = new TmuxBackend()
const socketBackend = new BackendSocket('fixture-only')
const hooks: Array<{ engine: string; sessionId: string }> = []
const server = await startHookServer(0, {
  onSessionEnd: () => {},
  onRegistered: row => { stoppedAgents.save(row); hooks.push({ engine: row.engine, sessionId: row.sessionId }); if (row.resumeOnly) stoppedAgents.finishResume(row.agentId) },
  resolveHookAgent: async input => {
    if (!input.tmuxPane) return null
    const identity = await resolvePaneEngineProcess(input.tmuxPane, input.engine)
    if (!identity) { console.error('[fixture] no process for', input); return null }
    const row = registry.byPaneEngine(input.tmuxPane, input.engine)
    if (!row || row.engine !== input.engine) { console.error('[fixture] no registry route', input, identity, registry.list().map(r => ({ id: r.agentId, pane: r.tmuxPane }))); return null }
    return registry.openProcessAgent({ engine: input.engine, processIdentity: identity, runtimes: row.runtimes, primaryRuntimeKey: row.primaryRuntimeKey, cwd: row.cwd })?.entry ?? null
  },
})
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
      transcriptPath = join(folder, `rollout-${timestamp.replace(/:/g, '-')}-${sessionId}.jsonl`)
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
      installCodexHooks(server.port, profile)

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
      const bootstrap = await backend.create({ cwd, label: 'fixture-hook-trust', command: [codexBinary, '--no-alt-screen'], env: launchEnv })
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
    socketBackend.onDeleteAgent = createStopAgentService({
      registry, stoppedAgents, restartJobs: jobs, stopJobs, tmuxBackend: backend,
      agentReconciler: { suppress: () => {}, holdRoute: () => {}, releaseRoute: () => {}, trigger: async () => {} },
      forgetSession: id => registry.removeAgent(id), markDeleted: () => {}, clearDeleted: () => {},
    })
    socketBackend.onResumeAgent = createResumeAgentService({
      registry, stoppedAgents, tmuxBackend: backend, restartJobs: jobs, stopJobs, pinnedControls: new Set(),
      announceSession: () => {}, relaunchOverrides: async () => ({ ok: true, overrides: { env: launchEnv, extraArgs: [], clearEnv: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDECODE'] } }),
      prepareSessionResume: () => {}, refreshGridWebSearch: () => {}, clearDeleted: () => {}, attachDsh: () => {},
      retainExitedSession: (row, alive) => { stoppedAgents.save(row); if (alive) registry.releaseEngine(row.agentId, true); else registry.removeAgent(row.agentId) },
    })
    const inventory = await rpc('agents_list', { includeStopped: true })
    assert(inventory.agents.some((a: any) => a.id === old.agentId && a.status === 'stopped'))
    const openSaved = async (creationId: string) => {
      let settled = false, submitted = false
      const hookCount = hooks.length
      const opening = rpc('agent_resume', { agentId: old.agentId, creationId }).finally(() => { settled = true })
      const deadline = Date.now() + 45000
      while (!settled && Date.now() < deadline) {
        const row = registry.byAgent(old.agentId)
        if (row) {
          await tmux('resize-window', '-t', row.tmuxPane, '-x', '140', '-y', '45')
          const screen = await tmux('capture-pane', '-p', '-S', '-500', '-t', row.tmuxPane)
          writeFileSync(join(root, `${engine}-screen.txt`), screen)
          if (/Hooks need review/.test(screen)) await tmux('send-keys', '-t', row.tmuxPane, 'Down', 'Enter')
          if (/trust this folder|trust the files|Yes, I trust|confirm.*API key/i.test(screen)) await tmux('send-keys', '-t', row.tmuxPane, 'Enter')
          // Codex 0.154 defers SessionStart until the next submitted turn. First prove
          // that opening alone restored visible history, then simulate user input so
          // the real hook can confirm the receipt. Production never submits a prompt.
          if (engine === 'codex' && row.launch?.state === 'starting' && !submitted && hooks.length === hookCount && screen.includes(marker) && /Ask Codex/.test(screen)) {
            assert.equal(row.launch?.state, 'starting')
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
      return opening
    }
    const creationId = randomUUID()
    const result = await openSaved(creationId)
    assert.equal(result.state, 'created', JSON.stringify(result)); assert.equal(result.resumed, true)
    const live = registry.byAgent(old.agentId)!
    assert.equal(live.sessionId, sessionId); assert.equal(live.launch?.state, 'ready'); assert(live.processIdentity)
    assert(hooks.some(h => h.engine === engine && h.sessionId === sessionId), 'native SessionStart must confirm saved id')
    const screen = await tmux('capture-pane', '-p', '-S', '-500', '-t', live.tmuxPane)
    assert(screen.includes(marker), 'restored conversation text must be visible')
    const pid = live.processIdentity!.pid; const route = live.tmuxPane
    const neighbour = (await tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', route, '/bin/sh')).trim()
    const neighbourPid = (await tmux('display-message', '-p', '-t', neighbour, '#{pane_pid}')).trim()
    assert.equal((await checkSessionRuntime(live)).state, 'alive')
    assert.equal((await rpc('agent_resume', { agentId: old.agentId, creationId: randomUUID() })).resumed, true)
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
      assert.equal((await claudeProcessSession(unbound.processIdentity!.pid, cwd,
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
      const paused = await rpc('agent_delete', { agentId: old.agentId })
      assert.equal(paused.deleted, true, JSON.stringify(paused))
      assert.equal((await checkPidRuntime(current)).state, 'gone')
    }
    log(`PASS ${engine}: native history + hook, three immediate pause/resume cycles, new tmux runtime, same id, attach same PID, receipt replay, missing-ID recovery before Stop, stop persistence, neighbouring pane and surviving shell preserved`)
  }
  if (process.argv.includes('--serve')) {
    // The desktop acceptance test uses the real local WS transport and terminal streams.
    // HTTP supplies only fixture metadata and assertions, never fabricated RPC results.
    const { attachLocalWsServer } = await import('../src/localWsServer.js')
    const { TerminalStreamManager } = await import('../src/lib/terminalStreamManager.js')
    const { TerminalBackendCoordinator } = await import('../src/lib/terminalBackendCoordinator.js')
    const { agentFrame } = await import('../src/lib/agentFrame.js')
    const streams = new TerminalStreamManager({
      terminals: new TerminalBackendCoordinator([backend], ['tmux'], []),
      resolveAgent: id => registry.byAgent(id), streamingAvailable: true,
      sendTarget: (id, type, payload) => socketBackend.sendTerminalTo(id, type, payload),
      sendBinaryTarget: (id, frame) => socketBackend.sendTerminalBinaryTo(id, frame),
      isLoopback: () => true,
    })
    socketBackend.setTerminalStreamManager(streams)
    const anchorPane = (await tmux('display-message', '-p', '-t', 'fixture-anchor', '#{pane_id}')).trim()
    const anchor = registry.openPendingAgent({ engine: 'terminal', runtimes: [{ backend: 'tmux', paneId: anchorPane }], cwd: root, defaultName: 'Keep this work open' })!
    registry.setLaunch(anchor.agentId, { state: 'ready' })
    const resume = socketBackend.onResumeAgent!
    socketBackend.onResumeAgent = async id => {
      const fixture = fixtures.find(f => f.agentId === id); assert(fixture, 'only fixture sessions may resume')
      let done = false, submitted = false
      const result = resume(id).finally(() => { done = true })
      let announced = ''
      while (!done) {
        const row = registry.byAgent(id)
        if (row) {
          const state = `${row.tmuxPane}:${row.launch?.state}`
          if (state !== announced) {
            announced = state
            socketBackend.send({ type: 'agent_synced', payload: { agent: await agentFrame(row, { selectedModel: null, terminalAvailable: true, dsh: null }) } })
          }
          if (fixture.engine === 'codex' && !submitted) {
            const screen = await tmux('capture-pane', '-p', '-S', '-500', '-t', row.tmuxPane)
            if (screen.includes(fixture.marker) && /Ask Codex/.test(screen)) {
              submitted = true
              await tmux('send-keys', '-t', row.tmuxPane, '-l', 'Fixture verification only. Do not use tools.')
              await new Promise(r => setTimeout(r, 600))
              await tmux('send-keys', '-t', row.tmuxPane, 'Enter')
            }
          }
        }
        await new Promise(r => setTimeout(r, 100))
      }
      return result
    }
    const stop = socketBackend.onDeleteAgent!
    socketBackend.onDeleteAgent = async id => {
      assert(fixtures.some(f => f.agentId === id), 'never stop the anchor or a non-fixture session')
      const before = JSON.stringify(registry.byAgent(id))
      try { await stop(id) }
      catch (error) {
        console.error('[resume-native] native pause failed:', error, { before, after: JSON.stringify(registry.byAgent(id)) })
        throw error
      }
      socketBackend.send({ type: 'agent_deleted', payload: { agentId: id, retained: true } })
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
          const screen = await tmux('capture-pane', '-p', '-S', '-500', '-t', row.tmuxPane)
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
    const expiry = setTimeout(finish, 10 * 60_000)
    process.once('SIGINT', finish); process.once('SIGTERM', finish)
    await finished
    clearTimeout(expiry); process.off('SIGINT', finish); process.off('SIGTERM', finish)
    await local.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve()))
  }
} finally {
  await tmux('kill-server').catch(() => {})
  server.server.closeAllConnections(); await new Promise<void>(r => server.server.close(() => r()))
  await socketBackend.stop()
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

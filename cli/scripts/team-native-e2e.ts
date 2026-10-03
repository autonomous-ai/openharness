/** Opt-in, paid-model acceptance: real native TUIs, production input controller,
 * daemon WebSocket, durable team ledger, and real transcript normalizers.
 * Every pane and workspace belongs to an isolated tmux server. No user sessions
 * are addressed. Existing credentials are reused only for the model providers.
 * HARNESS_TEAM_LIVE=1 node --import tsx scripts/team-native-e2e.ts
 */
import assert from 'node:assert/strict'
import { execFile as execCallback } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { promisify, stripVTControlCharacters } from 'node:util'
import type { AgentEngine } from '../src/engines/types.js'
import type { LiveEvent } from '../src/lib/normalize.js'

assert.equal(process.env.HARNESS_TEAM_LIVE, '1', 'Explicit opt-in is required for model usage')
const requestedEngines = (process.env.HARNESS_TEAM_ENGINES ?? 'codex,grok,claude').split(',')
const engines = (['grok', 'codex', 'claude'] as const).filter(engine => requestedEngines.includes(engine))
assert(engines.includes('claude') && engines.length >= 2 && engines.length === requestedEngines.length, 'Choose Claude and one or both peers; the default verifies all three')
const peerEngines = engines.filter(engine => engine !== 'claude')
const exec = promisify(execCallback)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-team-native-')))
chmodSync(root, 0o700)
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const loader = fileURLToPath(import.meta.resolve('tsx'))
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
const socketName = `team-live-${process.pid}`
const tmuxBinary = (await exec('/usr/bin/which', ['tmux'])).stdout.trim()
const binaries = Object.fromEntries(await Promise.all(engines.map(async engine => [engine, realpathSync((await exec('/usr/bin/which', [engine])).stdout.trim())])))
const profiles = join(root, 'profiles'); mkdirSync(profiles, { mode: 0o700 })
for (const engine of ['codex', 'grok']) {
  const profile = join(profiles, engine); mkdirSync(profile, { mode: 0o700 })
}
const bin = join(root, 'bin'); mkdirSync(bin)
writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmuxBinary)} -L ${quote(socketName)} -f /dev/null "$@"\n`, { mode: 0o700 })
Object.assign(process.env, {
  PATH: `${bin}:${process.env.PATH}`, ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
  ADAPTER_COMPUTER_ID_FILE: join(root, 'computer-id'), HARNESS_AUTH_DIR: join(root, 'auth'), DSH_DIR: join(root, 'dsh'),
  CODEX_HOME: join(profiles, 'codex'), GROK_HOME: join(profiles, 'grok'),
  CLAUDE_PATH: binaries.claude, CODEX_PATH: binaries.codex, GROK_PATH: binaries.grok,
  HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9/catalog.json',
})
delete process.env.CLAUDECODE
const tmux = async (...args: string[]) => (await exec(tmuxBinary, ['-L', socketName, '-f', '/dev/null', ...args], { timeout: 5000 })).stdout
const [{ BackendSocket }, { attachLocalWsServer }, { registry }, { TmuxBackend }, { SessionInputController },
  { captureTmuxPane, checkSessionRuntime, sendToTmux, sendKeyToTmux, resolvePaneEngineProcess },
  { teamRpc }, { teamWriteHold }, { lineToEvents, newTurnState }, { CodexNormalizer }, { GrokNormalizer }] = await Promise.all([
  import('../src/backendSocket.js'), import('../src/localWsServer.js'), import('../src/lib/registry.js'), import('../src/lib/tmuxBackend.js'),
  import('../src/lib/sessionInput.js'), import('../src/lib/tmux.js'), import('../src/teams/client.js'), import('../src/teams/preflight.js'),
  import('../src/lib/normalize.js'), import('../src/engines/codex/normalizer.js'), import('../src/engines/grok/normalizer.js'),
])
const machineId = randomBytes(16).toString('hex'), teamId = randomBytes(16).toString('hex')
const backend = new BackendSocket(machineId)
const terminal = new TmuxBackend()
const server = createServer((_req, res) => { res.statusCode = 404; res.end() })
const local = attachLocalWsServer(server, { machineId, backend })
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const port = (server.address() as { port: number }).port
const command = `${[process.execPath, '--import', loader, join(cliRoot, 'src/cli.ts')].map(quote).join(' ')} team --port ${port}`
backend.teamCommand = command
const call = (payload: Record<string, unknown>) => teamRpc({ machineId, port }, 'team', payload)
const agents: Array<{ id: string; engine: AgentEngine; pane: string; cwd: string; session: string; transcript: string | null; offset: number; ingest: (line: string) => LiveEvent[]; starts: number; ends: number }> = []
const capture = (id: string) => captureTmuxPane(registry.byAgent(id)!.tmuxPane, 120, { ansi: true, visible: true })
const input = new SessionInputController({
  getSession: id => registry.byAgent(id),
  validateRuntime: async row => (await checkSessionRuntime(row)).state === 'alive',
  beforeTeamWrite: async row => teamWriteHold(row.engine, await capture(row.agentId)),
  inject: (id, text) => sendToTmux(registry.byAgent(id)!.tmuxPane, text),
  injectTeam: async (id, text, deliveryId) => {
    const reason = teamWriteHold(registry.byAgent(id)!.engine, await capture(id))
    if (reason || !backend.teamCanWrite(deliveryId)) return { state: 'failed', dispatch: 'not_started', reason: reason ?? 'team_waiting_control' }
    return sendToTmux(registry.byAgent(id)!.tmuxPane, text)
  },
  sendKey: (id, key) => sendKeyToTmux(registry.byAgent(id)!.tmuxPane, key), capture,
  onDelivery: event => { backend.teamDelivery(event); console.log(`[delivery] ${event.deliveryId.split(':').at(-1)} ${event.state} ${event.reason ?? ''}`) },
  onError: (_id, message) => console.error(`[input] ${message}`),
})
backend.onMessage = (id, text, deliveryId) => input.submit(id, text, deliveryId)
backend.onCancelOrchestratorMessage = id => input.cancelDelivery(id)
const deadline = Date.now() + 6 * 60_000
let interrupted = false
const interrupt = () => { interrupted = true }
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt)
const sleep = () => new Promise<void>(resolve => setTimeout(resolve, 350))
async function stopFixtureLeader(): Promise<void> {
  const socket = join(root, 'grok-leader.sock')
  if (!existsSync(socket)) return
  // Grok's leader may outlive its terminal client. Only processes holding this
  // fixture's unique socket are candidates; never use the global `leader kill`.
  const owners = await exec('lsof', ['-t', '--', socket], { timeout: 5000 }).catch(error => {
    if (error.code === 1) return { stdout: '' }
    throw error
  })
  for (const value of new Set(owners.stdout.trim().split(/\s+/).filter(Boolean))) {
    assert(/^\d+$/.test(value) && Number(value) > 1, 'Invalid fixture leader PID')
    const pid = Number(value)
    const { stdout: command } = await exec('ps', ['-p', value, '-o', 'comm='])
    assert.equal(basename(command.trim()), basename(binaries.grok), 'Refuse to stop an unexpected socket owner')
    process.kill(pid, 'SIGTERM')
    const stoppedBy = Date.now() + 5000
    for (;;) {
      try { process.kill(pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
        throw error
      }
      assert(Date.now() < stoppedBy, 'The disposable Grok leader did not stop')
      await sleep()
    }
  }
}
function files(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { recursive: true }).map(String).filter(f => f.endsWith('.jsonl')).map(f => join(directory, f))
}
async function poll(): Promise<void> {
  assert(!interrupted, 'Live acceptance was interrupted; cleaning up its disposable sessions')
  assert(Date.now() < deadline, 'Live acceptance reached its six-minute limit')
  for (const a of agents) {
    if (!a.transcript) {
      if (a.engine === 'claude') {
        const folder = join(homedir(), '.claude', 'projects', a.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
        a.transcript = files(folder).find(f => f.endsWith(`${a.session}.jsonl`)) ?? null
      } else if (a.engine === 'codex') {
        a.transcript = files(join(profiles, 'codex', 'sessions')).find(f => {
          try { return JSON.parse(readFileSync(f, 'utf8').split('\n')[0]).payload?.cwd === a.cwd } catch { return false }
        }) ?? null
      } else a.transcript = files(join(profiles, 'grok', 'sessions')).find(f => f.includes(a.session) && f.endsWith('updates.jsonl')) ?? null
    }
    if (!a.transcript) continue
    const lines = readFileSync(a.transcript, 'utf8').split('\n')
    while (a.offset < lines.length - 1) {
      for (const event of a.ingest(lines[a.offset++])) {
        if (event.type === 'turn_started') { a.starts++; input.onTurnStarted(a.id, event.payload.userMessage) }
        if (event.type === 'turn_ended') { a.ends++; input.onTurnEnded(a.id) }
      }
    }
    assert(a.starts <= 9, 'Bounded live model turn limit exceeded')
  }
}
const evidence: Record<string, unknown> = { root, machineId, teamId, engines, fullAcceptance: engines.length === 3, passed: false }
console.log(JSON.stringify({ root, port, machineId, teamId }))
try {
  // Copy credentials only after setup reaches the cleanup-protected region. Import or
  // listener failures above therefore cannot strand authentication files in the fixture.
  for (const engine of peerEngines) {
    const source = join(homedir(), `.${engine}`, 'auth.json')
    const target = join(profiles, engine, 'auth.json')
    if (existsSync(source)) { copyFileSync(source, target); chmodSync(target, 0o600) }
  }
  await tmux('new-session', '-d', '-s', 'fixture-anchor', '/bin/sleep', '600')
  await tmux('set-option', '-g', 'default-size', '150x50')
  const facts: Record<string, string> = Object.fromEntries(peerEngines.map(engine => [engine, `${engine.toUpperCase()}_FACT_${randomBytes(8).toString('hex')}`]))
  for (const engine of engines) {
    const cwd = join(root, engine); mkdirSync(cwd)
    await exec('git', ['init', '-q', cwd])
    if (facts[engine]) writeFileSync(join(cwd, 'FACT.txt'), facts[engine] + '\n')
    const boundary = `You are in an isolated Harness communication acceptance test. Work only in ${cwd}. Do not install anything, edit global settings, publish, deploy, spawn agents, or access unrelated files. Use only shell/file tools and the provided Harness team commands. Keep answers short. You will receive a team introduction shortly. `
    const task = engine === 'claude'
      ? `Once the Harness team introduction arrives, ask ${peerEngines.map(engine => `@${engine}`).join(' and ')} for the exact content of their FACT.txt, using one team ask command per peer. Do not inspect their directories yourself. You must obtain every fact as a correlated team answer. Wait for answer notifications and write RESULT.txt in your workspace containing every fact, one per line, only after every answer arrives. For now respond READY and wait for the introduction.`
      : 'Your FACT.txt is your local knowledge. When a teammate asks for it, read it and reply explicitly with the exact fact using the team reply command. Do not reveal it until asked. For now respond READY and wait.'
    const session = randomUUID()
    if (engine === 'codex') writeFileSync(join(profiles, 'codex', 'config.toml'), `model_reasoning_effort = "low"\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n[sandbox_workspace_write]\nnetwork_access = true\n`)
    const args = engine === 'claude'
      ? ['--safe-mode', '--setting-sources', '', '--permission-mode', 'auto', '--model', 'sonnet', '--effort', 'low', '--session-id', session, '--append-system-prompt', boundary, task]
      : engine === 'codex'
        ? ['--no-alt-screen', '--approve-for-me', '-C', cwd, boundary + task]
        : ['--no-alt-screen', '--leader-socket', join(root, 'grok-leader.sock'), '--no-subagents', '--disable-web-search', '--no-plan', '--permission-mode', 'auto', '--max-turns', '12', '--session-id', session, '--rules', boundary, task]
    const created = await terminal.create({ cwd, label: `team-test-${engine}`, command: [binaries[engine], ...args] })
    assert.equal(created.state, 'succeeded')
    if (created.state !== 'succeeded') throw new Error('Native engine did not launch')
    const pane = created.runtime.paneId
    const pending = registry.openPendingAgent({ engine, cwd, runtimes: [created.runtime], defaultName: engine })!
    registry.setLaunch(pending.agentId, { state: 'ready' })
    const claudeState = newTurnState(), codex = new CodexNormalizer('live'), grok = new GrokNormalizer()
    const ingest = engine === 'claude' ? (line: string) => lineToEvents(line, claudeState) : engine === 'codex' ? (line: string) => codex.ingest(line) : (line: string) => grok.ingest(line)
    const agent = { id: pending.agentId, engine, pane, cwd, session, transcript: null as string | null, offset: 0, ingest, starts: 0, ends: 0 }
    agents.push(agent)
    let trusted = false
    for (;;) {
      await poll()
      const screen = await capture(agent.id)
      if (screen && /Approve in your browser to finish signing in|Waiting for approval\.\.\.|Sign in to (?:Grok|Claude|Codex)/i.test(screen)) {
        writeFileSync(join(root, `${engine}-startup.txt`), screen)
        throw new Error(`${engine} requires browser sign-in before live acceptance can continue`)
      }
      const plainScreen = stripVTControlCharacters(screen ?? '')
      if (!trusted && /Yes, I trust/.test(plainScreen)) {
        trusted = true
        // The fixture created this empty workspace and seeded the only task file.
        // Newer Claude releases default to "No, exit". Select the named consent
        // option explicitly instead of assuming Enter means trust.
        if (/^\s*❯\s*No, exit/m.test(plainScreen)) await tmux('send-keys', '-t', pane, 'Down')
        await tmux('send-keys', '-t', pane, 'Enter')
      }
      const identity = await resolvePaneEngineProcess(pane, engine)
      if (identity) registry.openProcessAgent({ agentId: agent.id, engine, processIdentity: identity, runtimes: [created.runtime], cwd })
      if (agent.ends > 0 && teamWriteHold(engine, screen) === null) break
      if (Date.now() > deadline - 240_000) {
        writeFileSync(join(root, `${engine}-startup.txt`), screen ?? '')
        throw new Error(`${engine} did not reach a verified idle boundary in two minutes; inspect its startup capture`)
      }
      await sleep()
    }
    console.log(`[native] ${engine} ready with real transcript events`)
  }
  await call({ action: 'create', id: teamId, name: 'Native cross-engine acceptance', members: agents.map(a => ({ name: a.engine, role: a.engine === 'claude' ? 'Ask peers and write the combined result' : `Knows its own FACT.txt`, machineId, agentId: a.id })) })
  const result = join(root, 'claude', 'RESULT.txt')
  while (!existsSync(result)) { await poll(); await sleep() }
  const output = readFileSync(result, 'utf8')
  assert(Object.values(facts).every(fact => output.includes(fact)), 'The asking agent must use every actual peer answer')
  const snapshot = await call({ action: 'get', teamId })
  const exchanges = (snapshot.team as { exchanges: any[] }).exchanges
  assert.equal(exchanges.length, peerEngines.length)
  assert(exchanges.every(e => e.origin === 'agent' && e.state === 'answered' && e.answer.origin === 'agent'))
  for (const fact of Object.values(facts)) assert(exchanges.some(e => e.answer.text.includes(fact)))
  Object.assign(evidence, { passed: true, exchanges, turns: agents.map(a => ({ engine: a.engine, started: a.starts, ended: a.ends })), result: output })
  console.log(`[PASS] Claude asked ${peerEngines.join(' and ')}, received explicit answers through the daemon, and used them in RESULT.txt${engines.length < 3 ? ' (partial engine coverage)' : ''}`)
} catch (error) {
  evidence.error = String(error)
  for (const a of agents) writeFileSync(join(root, `${a.engine}-final.txt`), await capture(a.id) ?? '')
  console.error(String(error))
  process.exitCode = 1
} finally {
  for (const a of agents) input.forget(a.id)
  // A failed socket cleanup must not skip stopping the fixture's model processes or
  // removing its copied credentials. Wait for process cleanup before removing files,
  // since a still-running provider client can refresh and rewrite its auth file.
  const cleanup = await Promise.allSettled([local.close(), backend.stop(), tmux('kill-server')])
  cleanup.push(...await Promise.allSettled([stopFixtureLeader()]))
  for (const engine of ['codex', 'grok']) rmSync(join(profiles, engine, 'auth.json'), { force: true })
  const failures = cleanup.filter(result => result.status === 'rejected')
  if (failures.length) {
    evidence.cleanupErrors = failures.map(result => String((result as PromiseRejectedResult).reason))
    evidence.passed = false
    process.exitCode = 1
  }
  await new Promise<void>(resolve => server.close(() => resolve()))
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt)
  console.log(`Evidence: ${join(root, 'evidence.json')}`)
}

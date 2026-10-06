// Opt-in installed Claude TUI, real reviewed delivery, scripted localhost model.
// No user pane, paid provider, schedule, physical microphone or app UI is exercised.
// Experimental opt-in check: setup incompatibility fails explicitly; default CI skips it.
// CLAUDE_PATH selects the executable, otherwise PATH is used. REVIEWED_VENDOR_EVIDENCE
// may name an output folder; omitted, each run gets a fresh ignored .harness/validation folder.
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, writeFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isolatedTmux, type IsolatedTmux } from '../testing/isolatedTmux.js'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import type { CablePort } from './cableSession.js'

const run = process.env.RUN_REVIEWED_VENDOR === '1' ? describe : describe.skip
let evidence = ''
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(join(root, e.name)) : [join(root, e.name)]))).flat()
}

run.sequential('installed Claude command acceptance (localhost model)', () => {
  let server: IsolatedTmux
  let modules: {
    frame: typeof import('./cableFrame.js'), session: typeof import('./cableSession.js'),
    host: typeof import('./cableHost.js'), log: typeof import('./dialLog.js'),
    registry: typeof import('../lib/registry.js'), reviewed: typeof import('../lib/reviewedInput.js'),
    terminals: typeof import('../lib/terminalBackendCoordinator.js'), tmux: typeof import('../lib/tmuxBackend.js'),
    process: typeof import('../lib/tmux.js'), input: typeof import('../lib/sessionInput.js'),
    preflight: typeof import('../teams/preflight.js'), device: typeof import('../lib/autonomous-device/input.js'), env: typeof import('../config/env.js'),
  }
  const originalHome = process.env.HOME, originalCodex = process.env.CODEX_HOME
  beforeAll(async () => {
    const requestedEvidence = process.env.REVIEWED_VENDOR_EVIDENCE?.trim()
    if (requestedEvidence) evidence = resolve(requestedEvidence)
    else {
      const validationRoot = fileURLToPath(new URL('../../../.harness/validation/', import.meta.url))
      await mkdir(validationRoot, { recursive: true })
      evidence = await mkdtemp(join(validationRoot, 'reviewed-vendor-'))
    }
    await mkdir(evidence, { recursive: true })
    server = await isolatedTmux()
    vi.stubEnv('TMUX_TMPDIR', server.root); vi.stubEnv('TMUX', undefined); vi.stubEnv('TMUX_PANE', undefined)
    vi.stubEnv('ADAPTER_COMPUTER_ID_FILE', join(server.root, 'computer-id'))
    vi.stubEnv('ADAPTER_COMPUTER_ID', '123456781234123412341234567890ab')
    vi.stubEnv('HARNESS_LOGS_DIR', join(server.root, 'logs'))
    vi.stubEnv('CLAUDE_PROJECTS_DIR', join(server.root, 'vendor'))
    vi.stubEnv('DISABLE_HOOK_INSTALL', 'true'); vi.stubEnv('DISABLE_GRID_INSTALL', 'true')
    const [frame, session, host, log, registry, reviewed, terminals, tmux, processModule, input, device, env, preflight] = await Promise.all([
      import('./cableFrame.js'), import('./cableSession.js'), import('./cableHost.js'), import('./dialLog.js'),
      import('../lib/registry.js'), import('../lib/reviewedInput.js'), import('../lib/terminalBackendCoordinator.js'),
      import('../lib/tmuxBackend.js'), import('../lib/tmux.js'), import('../lib/sessionInput.js'),
      import('../lib/autonomous-device/input.js'), import('../config/env.js'), import('../teams/preflight.js'),
    ])
    modules = { frame, session, host, log, registry, reviewed, terminals, tmux, process: processModule, input, device, env, preflight }
  }, 30_000)
  afterAll(async () => {
    expect(process.env.HOME).toBe(originalHome); expect(process.env.CODEX_HOME).toBe(originalCodex)
    await server?.close()
    if (server) await writeFile(join(evidence, 'cleanup.json'), JSON.stringify({ socket: server.socket, socketRemoved: !existsSync(server.socket), rootRemoved: !existsSync(server.root) }))
    vi.unstubAllEnvs()
  })

  it.each(['goal', 'loop'] as const)('recognizes reviewed /%s in the owned vendor process', async intent => {
    const deadline = Date.now() + 85_000
    const root = join(server.root, 'vendor', intent), config = join(root, 'config'), work = join(root, 'work')
    await mkdir(config, { recursive: true }); await mkdir(work, { recursive: true })
    const sessionId = randomUUID(), marker = `PRO_${intent.toUpperCase()}_${randomUUID().slice(0, 8)}`
    const requests: unknown[] = [], frames: Record<string, unknown>[] = [], observations: string[] = []
    let pane = '', cable: InstanceType<typeof modules.session.CableSession> | undefined
    let failure = '', transcript = '', latest = '', activeRequests = 0, vendorPid = 0
    let vendor: unknown = null, processExited: boolean | null = null
    const objective = intent === 'goal' ? `Reply ${marker} once. Do not use tools.` : `Explain ${marker}. Do not create any schedule or use tools.`
    const provider = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) { body += String(chunk); if (body.length > 1_000_000) { res.writeHead(413).end(); return } }
      if (req.url?.endsWith('/count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":100}'); return }
      if (!req.url?.startsWith('/v1/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return }
      const parsed = JSON.parse(body)
      requests.push(parsed)
      if (requests.length > 4) { res.writeHead(429).end('{"error":{"type":"rate_limit_error","message":"Fixture request cap"}}'); return }
      activeRequests++
      const answer = `HARNESS_READY ${marker}. No tools or schedules were used.`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event: Record<string, unknown>) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({ type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: parsed.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } })
      send({ type: 'content_block_stop', index: 0 })
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 15 } })
      send({ type: 'message_stop' }); res.end(); activeRequests--
    })
    const until = async (label: string, check: () => Promise<boolean>, stageMs = 30_000) => {
      const stageDeadline = Math.min(deadline, Date.now() + stageMs)
      while (Date.now() < stageDeadline) { if (await check()) return; await new Promise(r => setTimeout(r, 150)) }
      throw Error(`Timed out: ${label}; last screen: ${latest.slice(-5000)}`)
    }
    try {
      const claude = resolveBinaryOnPath(modules.env.env.CLAUDE_PATH ?? 'claude')
      if (!claude) throw Error('Vendor setup unavailable: set CLAUDE_PATH to an executable or put claude on PATH')
      await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve) })
      const port = (provider.address() as { port: number }).port
      const args = [resolve(claude), '--bare', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--setting-sources', '', '--settings', '{}', '--model', 'claude-sonnet-4-6', '--session-id', sessionId]
      const childEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color', CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'synthetic-not-a-real-key',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' }
      const executable = await realpath(args[0])
      vendor = { executable, sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
        version: (await promisify(execFile)(args[0], ['--version'], { env: childEnv, timeout: 5000 })).stdout.trim() }
      const command = ['/usr/bin/env', '-i', ...Object.entries(childEnv).map(([k, v]) => `${k}=${v}`), ...args].map(quote).join(' ')
      pane = await server.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', `vendor-${intent}`, '-x', '100', '-y', '35', '-c', work, command)
      const setupStates = new Set<string>()
      const emptyComposer = (capture: string) => {
        const plain = stripVTControlCharacters(capture)
        return /[─━]{8,}\s*\n\s*❯[^\n]*\n[─━]{8,}/u.test(plain)
          && modules.preflight.teamWriteHold('claude', capture) === null
      }
      await until('setup: no verified empty Claude composer', async () => {
        latest = await server.run('capture-pane', '-p', '-e', '-t', pane)
        const plain = stripVTControlCharacters(latest)
        const setup = plain.includes('Do you want to use this API key?') && plain.includes('hetic-not-a-real-key') ? 'fixture-api-key'
          : plain.includes('Choose the text style') ? 'theme'
          : plain.includes('Security notes:') && plain.includes('Press Enter to continue') ? 'security-notes'
          : plain.includes('Yes, I trust this folder') && plain.includes(work) ? 'owned-workspace-trust'
          : ''
        if (setup) {
          if (!setupStates.has(setup)) {
            setupStates.add(setup); observations.push(`Normal first-run setup: ${setup}`)
            if (setup === 'owned-workspace-trust' && /❯\s*No, exit/u.test(plain)) await server.run('send-keys', '-t', pane, 'Down')
            if (setup === 'fixture-api-key' && /❯\s*No/u.test(plain)) await server.run('send-keys', '-t', pane, 'Up')
            await server.run('send-keys', '-t', pane, 'Enter')
          }
          return false
        }
        return emptyComposer(latest)
      }, 25_000)
      // Bootstrap establishes a vendor-written transcript before binding real registry state.
      await server.run('send-keys', '-t', pane, '-l', 'Reply HARNESS_READY only. Do not use tools.')
      await server.run('send-keys', '-t', pane, 'Enter')
      await until('vendor transcript and completed bootstrap', async () => {
        transcript = (await files(config)).find(p => p.endsWith(`${sessionId}.jsonl`)) ?? ''
        latest = await server.run('capture-pane', '-p', '-e', '-t', pane)
        return !!transcript && latest.includes('HARNESS_READY') && emptyComposer(latest)
      })
      const found = await modules.process.lookupPaneEngineProcess(pane, 'claude')
      if (!found.ok) throw Error(`Discovery: ${found.reason}`)
      vendorPid = found.identity.pid
      const runtime = { backend: 'tmux' as const, paneId: pane }
      const opened = modules.registry.registry.openProcessAgent({ engine: 'claude', cwd: work, processIdentity: found.identity, runtimes: [runtime] })
      if (!opened) throw Error('Real registry refused owned process')
      const bound = modules.registry.registry.register({ engine: 'claude', sessionId, transcriptPath: transcript, cwd: work,
        processIdentity: found.identity, runtimes: [runtime], source: 'owned-vendor-fixture' })
      if (!bound) throw Error('Real registry refused vendor transcript binding')
      const row = bound.entry, terminals = new modules.terminals.TerminalBackendCoordinator([new modules.tmux.TmuxBackend()], ['tmux'])
      const input = new modules.input.SessionInputController({ getSession: id => modules.registry.registry.byAgent(id), validateRuntime: async () => true,
        inject: async () => { throw Error('Legacy injection forbidden') }, sendKey: async () => true, onError: () => {} })
      const writer = new modules.device.AutonomousDeviceInput({ getSession: id => modules.registry.registry.byAgent(id), validateRuntime: async () => true,
        inject: async () => { throw Error('Legacy injection forbidden') }, sendKey: async () => true, capture: async () => '',
        acquireControl: id => input.acquireControl(id, { forAnswer: true }), acquireReviewedControl: id => input.acquireControl(id),
        legacySubmit: () => { throw Error('Legacy submit forbidden') }, legacyCancel: () => false, onDelivery: () => {}, onInputStatus: () => {} })
      const reviewed = new modules.reviewed.ReviewedInput({ session: id => modules.registry.registry.byAgent(id), terminals,
        acquire: id => writer.acquireReviewed(id), isTurnOpen: () => activeRequests > 0 })
      const host = new modules.host.DaemonCableHost({ machineName: () => 'Owned vendor fixture', machineId: () => 'local-fixture', computerId: () => 'fixture',
        sendTurn: () => { throw Error('Legacy cable input forbidden') }, prepareReviewed: (id, mode) => reviewed.prepare(id, mode),
        stopTurn: () => {}, answer: () => {}, recent: () => [], recentAsks: () => [], log: line => observations.push(line) })
      host.setSwarms({ active: 'owned-tab', swarms: [{ id: 'owned-tab', name: 'Owned fixture', agentIds: [row.agentId], panes: 1 }], tiles: [] })
      host.setDesk([row.agentId]); await host.listAgents()
      vi.spyOn(host, 'transcribe').mockResolvedValue(objective)
      let incoming!: (bytes: Buffer) => void
      const decoder = new modules.frame.CableDecoder()
      let portOpen = true
      const virtual: CablePort = { path: '/dev/owned-vendor-fixture', get isOpen() { return portOpen }, close: async () => { portOpen = false },
        write: async bytes => { decoder.feed(Buffer.from(bytes), frame => {
          if (frame.type === modules.frame.CableType.Json) frames.push(JSON.parse(Buffer.from(frame.payload).toString()))
        }) } }
      cable = new modules.session.CableSession(host, new modules.log.DialLog(join(root, 'logs')), async bytes => { incoming = bytes; return virtual })
      cable.start(); await until('cable open', async () => !!incoming)
      const say = (msg: Record<string, unknown>) => incoming(Buffer.from(modules.frame.encodeCableFrame(modules.frame.CableType.Json, Buffer.from(JSON.stringify(msg)))))
      say({ t: 'hello', proto: 3, mac: 'AA:BB:CC:DD:EE:FE', product: 'harness', hw: 'harness-pro', fw: 'fixture' })
      say({ t: 'voice.begin', agentId: row.agentId, cmd: intent, uploadId: marker, sr: 16000 })
      incoming(Buffer.from(modules.frame.encodeCableFrame(modules.frame.CableType.Pcm, Buffer.alloc(320))))
      say({ t: 'voice.end', uploadId: marker, review: true })
      await until('reviewed draft', async () => frames.some(f => f.t === 'voice.draft' || f.t === 'voice.error'))
      const draft = frames.find(f => f.t === 'voice.draft')
      if (!draft) throw Error(`Draft refused: ${JSON.stringify(frames.filter(f => f.t === 'voice.error'))}`)
      say({ t: 'draft.command', draftId: draft.id, revision: draft.revision, requestId: 'vendor-send', op: 'send' })
      await until('actual input receipt', async () => frames.some(f => f.requestId === 'vendor-send'))
      expect(frames.find(f => f.requestId === 'vendor-send')).toMatchObject({ sent: true })
      const { claudeSideAsk } = await import('../lib/sessionSearch/transcript.js')
      await until('vendor command recognition record', async () => {
        const lines = (await readFile(transcript, 'utf8')).split('\n')
        if (intent === 'goal') return lines.some(line => claudeSideAsk(line) === objective)
        const records = lines.flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
        const command = records.find(row => row.type === 'user' && row.message?.content ===
          `<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>${objective}</command-args>`)
        return !!command && records.some(row => row.type === 'user' && row.isMeta === true && row.turnCompanion === true
          && row.parentUuid === command.uuid && row.message?.content?.some?.((part: { type?: string, text?: string }) =>
            part.type === 'text' && part.text?.startsWith('# /loop — schedule a recurring or self-paced prompt')
            && part.text.endsWith(`## Input\n\n${objective}`)))
      })
      expect(requests.length).toBeLessThanOrEqual(4)
      const all = await files(root)
      expect(all.some(p => p.endsWith('scheduled_tasks.json'))).toBe(false)
      observations.push(`${intent}: vendor transcript recognition; not a goal completion or schedule receipt`)
    } catch (error) { failure = String(error); throw error }
    finally {
      if (pane) latest = await server.run('capture-pane', '-p', '-t', pane).catch(() => latest)
      await cable?.stop()
      if (pane) await server.run('kill-pane', '-t', pane).catch(() => {})
      if (vendorPid) {
        for (let i = 0; i < 20; i++) {
          try { process.kill(vendorPid, 0) } catch { processExited = true; break }
          await new Promise(r => setTimeout(r, 25))
        }
        processExited ??= false
      }
      provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()))
      await writeFile(join(evidence, `${intent}-vendor.json`), JSON.stringify({ intent, failure, sessionId, marker, vendor, vendorPid, processExited, observations, frames, requests, latest,
        limitations: ['scripted localhost model', 'no app UI', 'no physical cable or STT', 'Loop recognition only'] }, null, 2))
      if (vendorPid) expect(processExited).toBe(true)
      if (transcript) await writeFile(join(evidence, `${intent}-transcript.jsonl`), await readFile(transcript, 'utf8').catch(() => ''))
    }
  }, 90_000)
})

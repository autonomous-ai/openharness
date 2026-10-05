import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import * as authSession from '../lib/authSession.js'
import { summarizeOrchestratorReply, parseOrchestratorArgs, localOrchestratorRequest, orchestratorCommand, flowRunCommand, parseFlowArgs, resolveFlowPath } from './command.js'

describe('orchestrator tool output', () => {
  it('keeps large projects readable without discarding worker results or mutating UI state', () => {
    const reply = { project: {
      id: 'a'.repeat(32), state: 'active', fingerprint: 'private-request-hash',
      tasks: [{ id: 'shape', prompt: 'long brief'.repeat(2000), summary: 'Verified', artifacts: [{ path: 'shape.step', sha256: 'a'.repeat(64) }] }],
      messages: Array.from({ length: 200 }, (_, i) => ({ id: String(i), text: 'long conversation'.repeat(1500), delivery: 'started' })),
    } }
    const output = summarizeOrchestratorReply(reply)
    expect(JSON.stringify(output).length).toBeLessThan(8000)
    expect(output).toMatchObject({ project: { tasks: [{ id: 'shape', summary: 'Verified', artifacts: [{ path: 'shape.step' }] }] } })
    expect(reply.project.messages).toHaveLength(200)
    expect(reply.project.tasks[0].prompt.length).toBeGreaterThan(10000)
  })
  it('keeps coded refusals unchanged and parses scoped steering receipts', () => {
    const error = { error: 'TASK_INACTIVE', detail: 'Add a revision task.' }
    expect(summarizeOrchestratorReply(error)).toBe(error)
    expect(parseOrchestratorArgs(['--port', '1234', '--machine', 'fixture', 'steer', 'a'.repeat(32), 'shape', '2', 'Use millimeters', 'b'.repeat(32)]).payload).toMatchObject({
      action: 'steer', taskId: 'shape', attempt: 2, text: 'Use millimeters', messageId: 'b'.repeat(32),
    })
  })
  it('handles sparse and non-project replies without inventing a transcript', () => {
    for (const project of [null, 3, [], 'no project']) {
      const reply = { project }; expect(summarizeOrchestratorReply(reply)).toBe(reply)
    }
    expect(summarizeOrchestratorReply({ project: {} })).toEqual({ project: { tasks: [], deliveries: [] } })
    expect(summarizeOrchestratorReply({ project: { messages: [{ text: 'No receipt' }] } })).toEqual({ project: { tasks: [], deliveries: [] } })
  })
})

describe('orchestrator argument validation', () => {
  const id = 'a'.repeat(32)
  afterEach(() => vi.restoreAllMocks())
  const parse = (...args: string[]) => parseOrchestratorArgs(['--port', '1234', '--machine', 'local-test', ...args]).payload
  it.each(['list', 'catalog', 'status', 'resume'])('parses %s without changing its identity', action => {
    expect(parse(action, 'project')).toEqual({ action, id: 'project' })
  })
  it('parses plan, both result outcomes, scoped cancel/retry, completion and chat', () => {
    expect(parse('plan', 'project', '[{"id":"x"}]')).toEqual({ action: 'plan', id: 'project', tasks: [{ id: 'x' }] })
    expect(parse('plan', 'project').tasks).toBeNull()
    for (const action of ['finish', 'fail']) expect(parse(action, 'project', 'task', '2', 'verified', 'a.step', 'b.png')).toEqual({ action, id: 'project', taskId: 'task', attempt: 2, summary: 'verified', artifacts: ['a.step', 'b.png'] })
    for (const action of ['retry', 'cancel']) {
      expect(parse(action, 'project', 'task')).toEqual({ action, id: 'project', taskId: 'task' })
      expect(parse(action, 'project')).toEqual({ action, id: 'project' })
    }
    expect(parse('complete', 'project', 'verified').summary).toBe('verified')
    expect(parse('message', 'project', 'hello').messageId).toMatch(/^[a-f0-9]{32}$/)
    expect(parse('message', 'project', 'hello', 'fixed').messageId).toBe('fixed')
    expect(parse('steer', 'project', 'task', '1', 'hello').messageId).toMatch(/^[a-f0-9]{32}$/)
  })
  it('parses approve and reject', () => {
    expect(parse('approve', id, 'ok', '--decision', 'ship', '--comment', 'go')).toEqual({ action: 'approve', id, taskId: 'ok', decision: 'ship', comment: 'go' })
    expect(parse('reject', id, 'ok', '--attempt', '3')).toEqual({ action: 'reject', id, taskId: 'ok', attempt: 3 })
    expect(() => parse('reject', id, 'ok', '--decision', 'x')).toThrow('reject takes --attempt and --comment only.')
    expect(() => parse('approve', id, 'ok', '--bogus', 'x')).toThrow('approve takes --attempt, --decision and --comment.')
    expect(() => parse('approve', id, 'ok', '--comment')).toThrow('--comment needs a value.')
    expect(() => parse('approve', id, 'ok', '--attempt', 'two')).toThrow('--attempt takes a whole number from 1.')
    expect(() => parse('approve', id)).toThrow('Usage: harness orchestrator approve <project> <task> [--attempt N] [--decision ID] [--comment TEXT]')
    expect(() => parse('reject', id, '--attempt', '1')).toThrow('Usage: harness orchestrator reject <project> <task> [--attempt N] [--comment TEXT]')
  })
  it('answers the current attempt when none is given, only while it waits', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const request = vi.fn()
      .mockResolvedValueOnce({ project: { tasks: [{ id: 'ok', state: 'waiting', attempt: 2 }] } })
      .mockResolvedValueOnce({ project: { id } })
    expect(await orchestratorCommand(['--port', '1', '--machine', 'm', 'approve', id, 'ok'], { request })).toBe(0)
    expect(request.mock.calls[0][2]).toEqual({ action: 'status', id })
    expect(request.mock.calls[1][2]).toMatchObject({ action: 'approve', taskId: 'ok', attempt: 2 })
    request.mockReset().mockResolvedValueOnce({ project: { tasks: [{ id: 'ok', state: 'succeeded', attempt: 2 }] } })
    expect(await orchestratorCommand(['--port', '1', '--machine', 'm', 'approve', id, 'ok'], { request })).toBe(1)
    expect(error).toHaveBeenCalledWith('ok is not waiting for a decision (state succeeded).')
    expect(request).toHaveBeenCalledTimes(1)
    request.mockReset().mockResolvedValueOnce({ project: { tasks: [] } })
    expect(await orchestratorCommand(['--port', '1', '--machine', 'm', 'reject', id, 'nope'], { request })).toBe(1)
    expect(error).toHaveBeenCalledWith('nope is not waiting for a decision (state unknown).')
    request.mockReset().mockResolvedValueOnce({})
    expect(await orchestratorCommand(['--port', '1', '--machine', 'm', 'reject', id, 'nope'], { request })).toBe(1)
    request.mockReset().mockResolvedValueOnce({ error: 'PROJECT_NOT_FOUND', detail: 'x' })
    expect(await orchestratorCommand(['--port', '1', '--machine', 'm', 'reject', id, 'ok'], { request })).toBe(1)
    request.mockReset().mockResolvedValueOnce({ project: { id } })
    expect(await orchestratorCommand(['--port', '1', '--machine', 'm', 'reject', id, 'ok', '--attempt', '4'], { request })).toBe(0)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed JSON, unknown commands, missing identity and invalid ports', () => {
    expect(() => parse('plan', 'project', '{')).toThrow()
    expect(() => parse('install')).toThrow(/Usage/)
    for (const port of ['0', '65536', '1.1', 'no']) expect(() => parseOrchestratorArgs(['--port', port, '--machine', 'local', 'list'])).toThrow(/running local daemon/)
    expect(() => parseOrchestratorArgs(['--port', '1234', '--machine'])).toThrow(/identity/)
  })
  it('uses a saved local identity and safely formats untyped configuration failures', async () => {
    vi.spyOn(authSession, 'readAuthSession').mockReturnValue({ machineId: 'saved-machine' } as ReturnType<typeof authSession.readAuthSession>)
    expect(parseOrchestratorArgs(['--port', '1234', 'list']).machineId).toBe('saved-machine')
    vi.spyOn(authSession, 'readAuthSession').mockImplementation(() => { throw 'untyped configuration failure' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await orchestratorCommand(['list'])).toBe(1)
    expect(error).toHaveBeenCalledWith('Orchestrator request failed.')
  })
})

describe('real loopback orchestrator transport', () => {
  const servers: WebSocketServer[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { for (const client of server.clients) client.terminate(); server.close(() => resolve()) })))
  })
  async function server(mode: 'ok' | 'refusal' | 'disconnect' | 'invalid' | 'silent' = 'ok') {
    const ws = new WebSocketServer({ port: 0, host: '127.0.0.1' }); servers.push(ws)
    await new Promise<void>(resolve => ws.once('listening', resolve))
    const received: any[] = []
    ws.on('connection', socket => socket.on('message', data => {
      const frame = JSON.parse(data.toString()); received.push(frame)
      if (mode === 'disconnect') { socket.close(); return }
      if (mode === 'invalid') { socket.send('{'); return }
      if (mode === 'silent') return
      if (frame.type === 'machine_select') socket.send(JSON.stringify({ type: 'connected' }))
      else {
        socket.send(JSON.stringify({ type: 'orchestrator_changed', payload: { requestId: 'unrelated' } }))
        socket.send(JSON.stringify({ type: 'orchestrator_result', payload: { requestId: frame.payload.requestId, ...(mode === 'refusal' ? { error: 'PROJECT_INACTIVE' } : { projects: [] }) } }))
      }
    }))
    return { port: (ws.address() as { port: number }).port, received, ws }
  }
  it('selects the machine and correlates replies by receipt rather than unsolicited events', async () => {
    const peer = await server()
    expect(await localOrchestratorRequest(peer.port, 'test-machine', { action: 'list' })).toMatchObject({ projects: [] })
    expect(peer.received[0]).toEqual({ type: 'machine_select', payload: { machineId: 'test-machine', localProtocolVersion: 1 } })
    expect(peer.received[1].payload).toMatchObject({ action: 'list', requestId: expect.stringMatching(/^[a-f0-9]{32}$/) })
  })
  it.each([['disconnect', /disconnected/], ['invalid', /invalid response/], ['silent', /did not confirm/]] as const)('fails safely on %s without retrying', async (mode, message) => {
    const peer = await server(mode)
    await expect(localOrchestratorRequest(peer.port, 'machine', { action: 'list' }, 50)).rejects.toThrow(message)
    expect(peer.received.filter(frame => frame.type === 'machine_select')).toHaveLength(1)
  })
  it('surfaces connection errors and command exit codes', async () => {
    const peer = await server()
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await orchestratorCommand(['--port', String(peer.port), '--machine', 'machine', 'list'])).toBe(0)
    expect(JSON.parse(output.mock.calls[0][0]).projects).toEqual([])
    const refusal = await server('refusal')
    expect(await orchestratorCommand(['--port', String(refusal.port), '--machine', 'machine', 'list'])).toBe(1)
    expect(await orchestratorCommand(['--port', '0', '--machine', 'machine', 'list'])).toBe(1)
    expect(error).toHaveBeenCalled()
    await new Promise<void>(resolve => peer.ws.close(() => resolve()))
    await expect(localOrchestratorRequest(peer.port, 'machine', { action: 'list' })).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('flow run command', () => {
  let dir: string, out: string[], err: string[]
  const catalog = [{ id: 'test/cad', name: 'cad', description: '', engine: 'claude', viewer: false }]
  const io = (extra: Record<string, unknown> = {}) => ({ cwd: dir, home: join(dir, 'home'), out: (t: string) => { out.push(t) }, err: (t: string) => { err.push(t) }, catalog: () => catalog, engineSupported: (e: string) => ['claude', 'codex'].includes(e), ...extra })
  const flow = 'spec: 1\nname: demo\ninputs: { word: { required: true } }\ntasks:\n  - { id: a, harness: test/cad, prompt: "Say $inputs.word" }\n  - { id: b, run: "true", depends_on: [a] }\n'
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'flow-cli-')); out = []; err = []; mkdirSync(join(dir, '.harness/flows'), { recursive: true }); writeFileSync(join(dir, '.harness/flows/demo.yaml'), flow) })
  afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

  it('parses options and inputs on the first =', () => {
    expect(parseFlowArgs(['demo', '--input', 'q=a=b', '--input', 'e=', '--dry-run', '--cwd', '/p', '--engine', 'codex', '--parallelism', '2', '--bypass-permission', '--port', '9', '--machine', 'm']))
      .toEqual({ flow: 'demo', inputs: { q: 'a=b', e: '' }, dryRun: true, bypassPermission: true, cwd: '/p', engine: 'codex', parallelism: 2, port: 9, machine: 'm' })
  })
  it.each([
    [['demo', '--input', 'q=1', '--input', 'q=2'], 'Duplicate input: q'],
    [['demo', '--input', 'novalue'], '--input name=value'],
    [['demo', '--input'], '--input name=value'],
    [['demo', '--cwd'], '--cwd needs a value'],
    [['demo', '--parallelism', 'x'], '--parallelism takes a whole number from 1 to 6'],
    [['demo', '--parallelism', '9'], '--parallelism takes a whole number from 1 to 6'],
    [['demo', '--wat'], 'Unknown option: --wat'],
    [['demo', 'extra'], 'Usage: harness orchestrator run'],
    [[], 'Usage: harness orchestrator run'],
  ])('rejects %j', (argv, message) => { expect(() => parseFlowArgs(argv)).toThrow(message) })
  it('finds flows by path, in the project, then at home, and refuses ambiguity', () => {
    const isFile = (p: string) => existsSync(p) && statSync(p).isFile()
    expect(resolveFlowPath('.harness/flows/demo.yaml', dir, join(dir, 'home'), isFile)).toEqual({ path: join(dir, '.harness/flows/demo.yaml'), byName: false })
    expect(resolveFlowPath('demo', dir, join(dir, 'home'), isFile)).toEqual({ path: join(dir, '.harness/flows/demo.yaml'), byName: true })
    mkdirSync(join(dir, 'home/.harness/flows'), { recursive: true }); writeFileSync(join(dir, 'home/.harness/flows/mine.yml'), flow)
    expect(resolveFlowPath('mine', dir, join(dir, 'home'), isFile).path).toBe(join(dir, 'home/.harness/flows/mine.yml'))
    writeFileSync(join(dir, '.harness/flows/demo.json'), '{}')
    expect(() => resolveFlowPath('demo', dir, join(dir, 'home'), isFile)).toThrow('keep one')
    expect(() => resolveFlowPath('nope', dir, join(dir, 'home'), isFile)).toThrow('No flow named nope')
    expect(() => resolveFlowPath('./missing.yaml', dir, join(dir, 'home'), isFile)).toThrow('No flow file at ./missing.yaml')
  })
  it('dry-runs without a daemon or machine identity', async () => {
    const request = vi.fn()
    expect(await flowRunCommand(['demo', '--input', 'word=hi', '--dry-run'], io({ request }))).toBe(0)
    expect(request).not.toHaveBeenCalled()
    const printed = JSON.parse(out.join(''))
    expect(printed).toMatchObject({ flow: { name: 'demo', path: join(dir, '.harness/flows/demo.yaml') }, engine: 'claude', inputs: { word: 'hi' }, warnings: [expect.stringContaining('Task a')] })
    expect(printed.tasks.map((t: { id: string }) => t.id)).toEqual(['a', 'b'])
    expect(err.join('')).toContain('warning: Task a has neither outputs nor timeout')
  })
  it.each([
    [['demo', '--dry-run'], {}, 'Missing required input: word'],
    [['demo', '--dry-run', '--input', 'word=x'], { catalog: () => [] }, 'test/cad is not an installed harness on this machine'],
    [['demo', '--dry-run', '--input', 'word=x', '--engine', 'gemini'], {}, 'gemini cannot run orchestrator work here'],
  ])('reports %j problems on stderr with exit 1', async (argv, extra, message) => {
    expect(await flowRunCommand(argv, io(extra))).toBe(1)
    expect(err.join('')).toContain(message)
  })
  it('points a flow-declared engine this machine cannot run at its line', async () => {
    writeFileSync(join(dir, '.harness/flows/other.yaml'), 'spec: 1\nname: other\nengine: gemini\ntasks: [{ id: a, run: "true" }]\n')
    expect(await flowRunCommand(['other', '--dry-run'], io())).toBe(1)
    expect(err.join('')).toContain('other.yaml:3:9: engine: gemini cannot run orchestrator work here.')
  })
  it('checks engine harnesses and warns when a file name and flow name differ', async () => {
    writeFileSync(join(dir, '.harness/flows/other.yaml'), 'spec: 1\nname: renamed\nengine: codex\ndescription: Two steps\ntasks: [{ id: a, harness: "engine:gemini", prompt: p }]\n')
    expect(await flowRunCommand(['other', '--dry-run'], io())).toBe(1)
    expect(err.join('')).toContain('engine:gemini cannot run orchestrator work here')
    err = []
    writeFileSync(join(dir, '.harness/flows/other.yaml'), 'spec: 1\nname: renamed\nengine: codex\ndescription: Two steps\ntasks: [{ id: a, harness: "engine:claude", prompt: p, timeout: 5m }]\n')
    expect(await flowRunCommand(['other', '--dry-run'], io())).toBe(0)
    expect(err.join('')).toContain('other.yaml declares name renamed')
    expect(JSON.parse(out.join(''))).toMatchObject({ engine: 'codex' })
  })
  it('needs no harness for approval and cancel tasks', async () => {
    writeFileSync(join(dir, '.harness/flows/other.yaml'), 'spec: 1\nname: other\ntasks: [{ id: ok, approval: Ship? }, { id: stop, cancel: no, depends_on: [ok] }]\n')
    expect(await flowRunCommand(['other', '--dry-run'], io({ catalog: () => [] }))).toBe(0)
  })
  it('starts the flow on the daemon and prints the project', async () => {
    const request = vi.fn(async () => ({ project: { id: 'p', state: 'active', tasks: [], messages: [] } }))
    expect(await flowRunCommand(['demo', '--input', 'word=hi', '--port', '1234', '--machine', 'm', '--engine', 'codex', '--parallelism', '2'], io({ request }))).toBe(0)
    const [port, machine, payload] = request.mock.calls[0] as unknown as [number, string, Record<string, unknown>]
    expect([port, machine]).toEqual([1234, 'm'])
    expect(payload).toMatchObject({ action: 'start', engine: 'codex', parallelism: 2, prompt: 'Flow demo', cwd: dir, bypassPermission: false, inputs: { word: 'hi' }, flow: { path: join(dir, '.harness/flows/demo.yaml'), source: flow } })
    expect(payload.id).toMatch(/^[a-f0-9]{32}$/)
    expect(JSON.parse(out.join(''))).toMatchObject({ project: { id: 'p' } })
    writeFileSync(join(dir, '.harness/flows/described.yaml'), 'spec: 1\nname: described\ndescription: Two steps\ntasks: [{ id: a, run: "true" }]\n')
    request.mockResolvedValueOnce({ error: 'ENGINE_UNSUPPORTED', detail: 'no' } as never)
    expect(await flowRunCommand(['described', '--port', '1234', '--machine', 'm'], io({ request }))).toBe(1)
    expect((request.mock.calls[1] as unknown as [number, string, Record<string, unknown>])[2]).toMatchObject({ prompt: 'described: Two steps' })
    expect('parallelism' in (request.mock.calls[1] as unknown as [number, string, Record<string, unknown>])[2]).toBe(false)
  })
  it('falls back to the saved identity and default port, and refuses without either', async () => {
    const request = vi.fn(async () => ({ project: { id: 'p', tasks: [], messages: [] } }))
    const session = vi.spyOn(authSession, 'readAuthSession').mockReturnValue({ machineId: 'saved' } as ReturnType<typeof authSession.readAuthSession>)
    expect(await flowRunCommand(['demo', '--input', 'word=hi'], io({ request }))).toBe(0)
    expect((request.mock.calls[0] as unknown as [number, string])[1]).toBe('saved')
    session.mockReturnValue(null as ReturnType<typeof authSession.readAuthSession>)
    expect(await flowRunCommand(['demo', '--input', 'word=hi'], io({ request }))).toBe(1)
    expect(err.join('')).toContain('machine identity are required')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('refuses what the daemon would refuse, naming the input but never its value', async () => {
    const request = vi.fn()
    const huge = 'x'.repeat(32_769)
    writeFileSync(join(dir, '.harness/flows/big.yaml'), 'spec: 1\nname: big\ninputs: { word: { required: true } }\ntasks: [{ id: a, run: "true", timeout: 1m }]\n')
    for (const extra of [['--dry-run'], []]) {
      err = []
      expect(await flowRunCommand(['big', '--input', `word=${huge}`, ...extra], io({ request }))).toBe(1)
      expect(err.join('')).toContain('inputs.word')
      expect(err.join('')).not.toContain('xxxx')
    }
    expect(request).not.toHaveBeenCalled()
  })
  it('reports untyped failures safely', async () => {
    expect(await flowRunCommand(['demo', '--dry-run', '--input', 'word=x'], io({ catalog: () => { throw 'boom' } }))).toBe(1)
    expect(err.join('')).toBe('Flow run failed.\n')
  })
  it('uses the process streams and the installed catalog by default', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'cwd').mockReturnValue(dir)
    expect(await flowRunCommand(['demo', '--dry-run', '--input', 'word=x'], { home: join(dir, 'home'), catalog: () => catalog })).toBe(0)
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"name": "demo"'))
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('warning: Task a has neither outputs nor timeout'))
  })
  it('routes run through the orchestrator command', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await orchestratorCommand(['--port', '1', 'run'])).toBe(1)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('Usage: harness orchestrator run'))
  })
})

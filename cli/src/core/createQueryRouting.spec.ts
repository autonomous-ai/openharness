import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { fakeCore } from '../testing/fakeCore.js'
import { answerAgentQuery } from './agentQueries.js'
import { answerDaemonQuery, answerExperimentQuery, createForExperiment } from './experimentQueries.js'
import { createServiceLinks, type ServiceFrame, type ServiceLinksOptions } from './serviceLinks.js'
import { createWifiLink } from './wifiLink.js'

// Execute main's actual dispatcher expression: a copied chain would conceal an ordering regression.
const source = ts.createSourceFile('main.ts', readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const compositions: ts.Expression[] = []
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createServiceLinks') {
    const options = node.arguments[0]
    if (options && ts.isObjectLiteralExpression(options)) for (const property of options.properties) {
      if (ts.isPropertyAssignment(property) && property.name.getText(source) === 'answer') compositions.push(property.initializer)
    }
  }
  ts.forEachChild(node, visit)
}
visit(source)
if (compositions.length !== 1) throw new Error('Expected exactly one service query composition')
const program = ts.transpileModule(`(${compositions[0].getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const token = 'c'.repeat(48)
const payload = { dsh: 'fixture/package', engine: 'claude', cwd: '/fixture/work', prompt: null, name: null, bypassPermission: false, requireUnusedWorkspace: true }

function setup(questionAnswer: (...args: unknown[]) => unknown = () => null) {
  const core = fakeCore({ agents: { create: vi.fn(async () => ({ ok: true as const, agentId: 'created' })) } })
  const wifiLink = createWifiLink({ core, notify: () => true }), empty = { answer: () => null }
  const followed = vi.fn(() => ({ following: true })), resolved = vi.fn(async () => ({ agentId: 'agent' }))
  const dispatch = runInNewContext(program, {
    coreApi: core, backend: { reportUsage: vi.fn() }, streamEndpoints: new Set(), clientStreams: { serving: vi.fn() },
    frameParts: empty, questionControls: { answer: questionAnswer }, modelControls: empty, nativeControls: empty,
    engineReaders: empty, gatewayLink: { answer: () => ({ from: 'gateway' }) }, agentLife: { followed }, deliveries: empty,
    messagesLink: { answer: () => ({ from: 'messages' }) }, TURN_DELIVERERS: ['wifi'], answerConversationQuery: resolved,
    answerConnectorsQuery: () => null, answerSharedMachinesQuery: () => null, sharedMachinesAccount: {},
    answerDaemonQuery, answerExperimentQuery, experiments: new Set(['orchestrator', 'sharing', 'cloud']), terminalWatch: empty,
    orchestratorLink: empty, viewersLink: empty, workspacesLink: empty, storeLink: empty, modelsLink: empty,
    devicesLink: empty, wifiLink, answerShellQuery: () => null, agentCleanupLink: empty, recapsLink: empty, answerAgentQuery,
  }, { timeout: 1_000 }) as ServiceLinksOptions['answer']
  const links = createServiceLinks({ token, owned: { wifi: [], orchestrator: [], gateway: [], messages: [] }, answer: dispatch, log: () => {} })
  return { core, dispatch, links, followed, resolved }
}

describe('actual main create query routing', () => {
  it('lets an already admitted creation settle after its service disconnects without replay', async () => {
    let release!: () => void, entered!: () => void, current = true
    const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
    const t = setup()
    const create = vi.fn(async () => { entered(); await gate; return { ok: true, session: { agentId: 'created' } } as const })
    vi.mocked(t.core.agents.create).mockImplementation(request => createForExperiment(create as never, request))
    const answer = t.dispatch('wifi', 'create', payload, { current: () => current, ownsRequest: () => false })
    await waiting; current = false; release()
    expect(await answer).toEqual({ ok: true, agentId: 'created' })
    expect(create).toHaveBeenCalledExactlyOnceWith({ ...payload, grid: null, codexHome: null, agent: null, permissionMode: null })
  })
  it('refuses a connection revoked while the preceding dispatcher awaits', async () => {
    let release!: () => void, entered!: () => void, current = true
    const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
    const t = setup(async () => { entered(); await gate; return null })
    const answer = t.dispatch('wifi', 'create', payload, { current: () => current, ownsRequest: () => false })
    await waiting; current = false; release()
    expect(await answer).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(t.core.agents.create).not.toHaveBeenCalled()
  })
  it('delivers an authenticated WiFi create to its existing owner before the experiment refusal', async () => {
    const t = setup(), frames: ServiceFrame[] = []
    const link = t.links.accept('wifi', token, { sendFrame: frame => { frames.push(frame); return true } }, () => {})!
    try {
      link.receive({ type: 'service_query', payload: { ...payload, query: 'create', requestId: 'create-1' } })
      await vi.waitFor(() => expect(frames).toHaveLength(1))
      expect(frames[0]).toEqual({ type: 'service_query_result', payload: { requestId: 'create-1', ok: true, agentId: 'created' } })
      expect(t.core.agents.create).toHaveBeenCalledExactlyOnceWith(payload)
    } finally { link.closed() }
  })

  it('keeps ordinary readers and existing experiment grants separate', async () => {
    const t = setup(), authority = { current: () => true, ownsRequest: () => false }
    expect(await t.dispatch('wifi', 'machine', {}, authority)).toEqual({ id: t.core.machine.id() })
    expect(await t.dispatch('wifi', 'follow_agents', {}, authority)).toEqual({ following: true })
    expect(await t.dispatch('wifi', 'resolve', { id: 'agent' }, authority)).toEqual({ agentId: 'agent' })
    expect(await t.dispatch('wifi', 'count', { metric: 'fixture' }, authority)).toEqual({ ok: true })
    expect(await t.dispatch('gateway', 'backend', {}, authority)).toEqual({ from: 'gateway' })
    expect(await t.dispatch('messages', 'create', {}, authority)).toEqual({ from: 'messages' })
    for (const query of ['shown', 'stop_turn', 'windows', 'backend', 'observer_key', 'observer_send']) {
      expect(await t.dispatch('wifi', query, {}, authority)).toEqual({ error: 'NOT_AN_EXPERIMENT' })
    }
    expect(await t.dispatch('orchestrator', 'create', { engine: 'claude', cwd: '/fixture/work', prompt: 'task', name: 'fixture' }, authority))
      .toEqual({ ok: true, agentId: 'created' })
    expect(t.core.agents.create).toHaveBeenCalledExactlyOnceWith({ engine: 'claude', cwd: '/fixture/work', dsh: null, prompt: 'task', name: 'fixture', bypassPermission: false })
  })

  it('refuses missing authentication and never admits work queued by a closed service connection', async () => {
    const t = setup(), frames: ServiceFrame[] = [], sink = { sendFrame: (frame: ServiceFrame) => { frames.push(frame); return true } }
    expect(t.links.accept('wifi', 'wrong', sink, () => {})).toBeNull()
    expect(t.links.accept('unknown', token, sink, () => {})).toBeNull()
    const link = t.links.accept('wifi', token, sink, () => {})!
    link.receive({ type: 'service_query', payload: { ...payload, query: 'create', requestId: 'stale' } })
    link.closed()
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(frames[0]).toMatchObject({ payload: { error: 'SERVICE_UNAVAILABLE' } })
    expect(t.core.agents.create).not.toHaveBeenCalled()
  })
})

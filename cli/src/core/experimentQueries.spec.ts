import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { EXPERIMENTS, EXPERIMENT_BACKEND_ROUTES, experimentBackendAllowed } from './api.js'
import { answerExperimentQuery, answerDaemonQuery, createForExperiment, createRouteRefusals } from './experimentQueries.js'

const agent = (agentId: string) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: '/w' }) as RegisteredSession
const experiments = new Set(['orchestrator'])

describe('the cloud agents\' doors', () => {
  it('are the cloud service\'s alone, and carry its harnesses and questions to the core', async () => {
    const cloud = { publish: vi.fn(), ask: vi.fn(), unask: vi.fn() }
    const core = fakeCore({ cloud })
    const both = new Set(['orchestrator', 'cloud'])
    expect(await answerExperimentQuery(core, both, 'cloud', 'cloud_publish', { harnesses: [{ agentId: 'cloud_1' }] })).toEqual({})
    expect(cloud.publish).toHaveBeenLastCalledWith([{ agentId: 'cloud_1' }])
    await answerExperimentQuery(core, both, 'cloud', 'cloud_publish', { harnesses: 'x' })
    expect(cloud.publish).toHaveBeenLastCalledWith([])
    await answerExperimentQuery(core, both, 'cloud', 'cloud_ask', { agentId: 'cloud_1', questionId: 'cloud_q_1', requestId: 'the-link-s-own', question: { text: 'Which?', choices: [] } })
    expect(cloud.ask).toHaveBeenCalledWith('cloud_1', 'cloud_q_1', { text: 'Which?', choices: [] })
    await answerExperimentQuery(core, both, 'cloud', 'cloud_ask', {})
    expect(cloud.ask).toHaveBeenLastCalledWith('', '', {})
    await answerExperimentQuery(core, both, 'cloud', 'cloud_unask', { agentId: 'cloud_1', questionId: 'cloud_q_1' })
    expect(cloud.unask).toHaveBeenCalledWith('cloud_1', 'cloud_q_1')
    expect(await answerExperimentQuery(core, both, 'orchestrator', 'cloud_publish', {})).toEqual({ error: 'NOT_CLOUD' })
    expect(await answerExperimentQuery(fakeCore(), both, 'cloud', 'cloud_publish', {})).toEqual({ error: 'NOT_CLOUD' })
  })
})

describe('what an experiment in its own process may ask of the core', () => {
  // The native-turn record went with #3901: nothing in the core answers for it, and its query is no longer one an experiment
  // may ask.
  it('answers no native-turn query', async () => {
    expect(await answerExperimentQuery(fakeCore(), experiments, 'orchestrator', 'native_turns', { agentId: 'native' })).toBeNull()
  })

  it('shows the live agents as the apps are shown them: name, terminal and harness', async () => {
    const core = fakeCore({
      agents: {
        live: () => [agent('a1'), agent('a2')],
        displayName: (session) => `name of ${session.agentId}`,
        terminalAvailable: (agentId) => agentId === 'a1',
        runtimeProfile: session => session.agentId === 'a1' ? 'runtime-v1:a1:claude:opus@high' : null,
        dsh: (session) => (session.agentId === 'a1' ? { viewerUrl: 'http://127.0.0.1:1/' } as never : null),
      },
    })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'shown', {})).toEqual({
      agents: [
        { ...agent('a1'), displayName: 'name of a1', terminalAvailable: true, selectedModel: 'runtime-v1:a1:claude:opus@high', dshContext: { viewerUrl: 'http://127.0.0.1:1/' } },
        { ...agent('a2'), displayName: 'name of a2', terminalAvailable: false, selectedModel: null, dshContext: null },
      ],
    })
  })

  it('creates an agent as asked, and refuses a request it cannot read', async () => {
    const create = vi.fn(async () => ({ ok: true as const, agentId: 'made' }))
    const core = fakeCore({ agents: { create } })
    const request = { engine: 'claude', cwd: '/w', dsh: 'cad', prompt: 'Plan it', name: 'Director', bypassPermission: true }
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'create', request)).toEqual({ ok: true, agentId: 'made' })
    expect(create).toHaveBeenLastCalledWith(request)
    await answerExperimentQuery(core, experiments, 'orchestrator', 'create', { ...request, dsh: '', bypassPermission: 'yes' })
    expect(create).toHaveBeenLastCalledWith({ ...request, dsh: null, bypassPermission: false })
    for (const bad of [{ ...request, engine: 3 }, { ...request, cwd: '' }, { ...request, prompt: null }, { ...request, name: undefined }]) {
      expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'create', bad)).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    }
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('stops a turn, and tells the windows a change notice and nothing else', async () => {
    const stop = vi.fn()
    const windows = vi.fn()
    const core = fakeCore({ turns: { stop }, clients: { windows } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'stop_turn', { agentId: 'a1' })).toEqual({})
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'stop_turn', {})).toEqual({})
    expect(stop.mock.calls).toEqual([['a1']])
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'windows', { frame: { type: 'orchestrator_changed', payload: { id: 'p', revision: 2 } } })).toEqual({})
    expect(windows).toHaveBeenCalledWith({ type: 'orchestrator_changed', payload: { id: 'p', revision: 2 } })
    for (const frame of [undefined, { type: 'agents_list', payload: {} }, { type: 'orchestrator_changed' }, { type: 'orchestrator_changed', payload: 'x' }]) {
      expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'windows', { frame })).toEqual({ error: 'INVALID_FRAME' })
    }
    expect(windows).toHaveBeenCalledOnce()
  })

  it('says how an agent\'s shell reaches this daemon', async () => {
    const core = fakeCore({ daemon: { command: `'node' 'cli.js'`, port: 18473, machineId: () => 'machine-7', autonomousEnv: 'staging' } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'daemon', {})).toEqual({ command: `'node' 'cli.js'`, port: 18473, machineId: 'machine-7', autonomousEnv: 'staging' })
  })

  // The audit of 2026-11-12 (docs/design/2026-11-12-core-audit.md, Security 2): every `/api/` path was signed for every
  // experiment, so a process that reads other accounts' messages could call any route of the account's backend as the
  // account: its device keys, its connected services' vault, its machines.
  it('signs an experiment\'s backend call only on a route its service declared, by method and whole path', async () => {
    const backend = vi.fn(async () => ({ status: 200, body: { success: true } }))
    const core = fakeCore({ account: { backend } })
    const all = new Set(Object.keys(EXPERIMENTS))
    const said: string[] = []
    const refusals = createRouteRefusals((line) => said.push(line))
    const ask = (service: string, method: unknown, path: unknown) => answerExperimentQuery(core, all, service, 'backend', { method, path, body: { a: 1 } }, refusals)
    const share = '0b0e1c2d-3f4a-4b5c-8d6e-7f8091a2b3c4'
    const declared: Array<[string, string, string]> = [
      // Share: a grant's and a link's publication and removal. The router: Jev's hosted decision.
      ['sharing', 'PUT', `/api/harness-shares/${share}`], ['sharing', 'DELETE', `/api/harness-shares/${share}`],
      ['sharing', 'PUT', `/api/harness-links/${share}`], ['sharing', 'DELETE', `/api/harness-links/${share}`],
      ['router', 'POST', '/api/route/jev'],
    ]
    for (const [service, method, path] of declared) {
      expect(await ask(service, method, path), `${service} ${method} ${path}`).toEqual({ status: 200, body: { success: true } })
      expect(backend).toHaveBeenLastCalledWith(method, path, { a: 1 })
    }
    const refused: Array<[string, unknown, unknown]> = [
      // Another part of the account's backend, whoever asks.
      ['sharing', 'GET', '/api/device-keys'], ['sharing', 'GET', '/api/connector-vault'], ['sharing', 'DELETE', '/api/machines/m1'],
      ['sharing', 'PUT', '/api/machines/m1/share'], ['sharing', 'GET', '/api/machines?all=1'], ['sharing', 'GET', '/api/machines'],
      ['sharing', 'GET', '/api/auth/me'], ['router', 'POST', '/api/route/agents'],
      ['orchestrator', 'PATCH', '/api/agent-messages/tabs/t1'], ['memory', 'GET', '/api/auth/me'], ['cloud', 'POST', `/api/harness-shares/${share}`],
      // A method its service never uses there.
      ['sharing', 'GET', `/api/harness-shares/${share}`], ['sharing', 'POST', `/api/harness-links/${share}`], ['router', 'GET', '/api/route/jev'],
      // A path that climbs out of its API, or is not whole segments of it.
      ['sharing', 'PUT', `/api/harness-shares/${share}/../../device-keys`], ['sharing', 'PUT', `/api/harness-shares/%2e%2e/device-keys`],
      ['sharing', 'PUT', `/api/harness-shares/${share}%2F..%2F..%2Fdevice-keys`], ['sharing', 'PUT', `/api/harness-shares//${share}`],
      ['sharing', 'PUT', '/api/harness-shares/'], ['sharing', 'PUT', `/api/harness-sharesx/${share}`], ['sharing', 'PUT', `/api/harness-shares/${share}#x`],
      ['sharing', 'PUT', `/api/harness-shares/${share}\n`], ['sharing', 'PUT', `/api/harness-shares\\..\\device-keys`],
      ['sharing', 'PUT', `https://evil.example/api/harness-shares/${share}`],
      ['sharing', 'PUT', '/api/harness-shares/not-a-share'], ['sharing', 'PUT', `/api/harness-shares/${share}/x`], ['sharing', 'PUT', `/api/harness-shares/${share}?x=1`],
      ['sharing', 'PUT', '/api/harness-shares/../device-keys'], ['router', 'POST', '/api/route/jev/x'], ['router', 'POST', '/api/route/jev?x=1'],
      // Not a call at all.
      ['sharing', 'TRACE', `/api/harness-shares/${share}`], ['sharing', 'PUT', undefined], ['sharing', undefined, `/api/harness-shares/${share}`], ['sharing', 'PUT', 7],
    ]
    backend.mockClear()
    for (const [service, method, path] of refused) expect(await ask(service, method, path), `${service} ${String(method)} ${String(path)}`).toEqual({ error: 'ROUTE_NOT_DECLARED' })
    expect(backend).not.toHaveBeenCalled()
    // Each is said in the core's log: its process hears only that the call failed.
    expect(said[0]).toBe('[services] sharing asked for a backend route which it has not declared, and was refused: GET /api/device-keys (core/api.ts)')
    // A call that sends no body is made with none. And with no refusals handed in, the core's own are used.
    await answerExperimentQuery(core, all, 'sharing', 'backend', { method: 'DELETE', path: `/api/harness-shares/${share}` })
    expect(backend).toHaveBeenLastCalledWith('DELETE', `/api/harness-shares/${share}`, undefined)
  })

  it('says a refused route once for each service, method and shape, without its query, and stops at a bound for each service', () => {
    const lines: string[] = []
    const refuse = createRouteRefusals((line) => lines.push(line))
    const never = () => false
    expect(refuse('sharing', 'GET', '/api/device-keys?since=1&self=m1', never)).toEqual({ error: 'ROUTE_NOT_DECLARED' })
    expect(refuse('sharing', 'GET', '/api/device-keys?since=2', never)).toEqual({ error: 'ROUTE_NOT_DECLARED' })
    expect(lines).toEqual(['[services] sharing asked for a backend route which it has not declared, and was refused: GET /api/device-keys (core/api.ts)'])
    // An id in a path is not a new route: a loop over a tab's deliveries is one line, not one for each.
    for (const id of ['d1', 'd2', '6730a1b2c3d4e5f601234567']) refuse('sharing', 'DELETE', `/api/harness-links/t1/agents/a1/deliveries/${id}`, never)
    expect(lines.slice(1)).toEqual(['[services] sharing asked for a backend route which it has not declared, and was refused: DELETE /api/harness-links/:id/agents/:id/deliveries/:id (core/api.ts)'])
    // A declared path refused for its query says so: the path is not what to look for.
    refuse('sharing', 'GET', '/api/harness-links/list?after=a b', (method, path) => method === 'GET' && path === '/api/harness-links/list')
    expect(lines[2]).toBe('[services] sharing asked for a backend route with a query that holds a space, a # or a character that is not printable, and was refused: GET /api/harness-links/list (core/api.ts)')
    // What is not text, or not printable, is said as it can be, and never at length.
    refuse('sharing', undefined, 7, never)
    refuse('sharing', 'GET', `/api/x\n[services] forged line\u0007 ${'y'.repeat(400)}`, never)
    expect(lines[3]).toBe('[services] sharing asked for a backend route which it has not declared, and was refused: undefine :id (core/api.ts)')
    expect(lines[4]).toMatch(/refused: GET \/api\/x\?\[services\] forged line\? y+ \(core\/api\.ts\)$/)
    expect(lines[4]!.length).toBeLessThan(300)
    // A process that asks for route after route fills no log: sixteen of a service's are said, then that it stops.
    for (let i = 0; i < 200; i++) refuse('sharing', 'GET', `/api/other/${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}`, never)
    expect(lines).toHaveLength(17)
    expect(lines[16]).toBe('[services] sharing: further refused backend routes are not said')
    // Another service's are still said.
    refuse('router', 'GET', '/api/device-keys', never)
    expect(lines[17]).toBe('[services] router asked for a backend route which it has not declared, and was refused: GET /api/device-keys (core/api.ts)')
  })

  it('has every experiment declare its backend routes, if only that it calls none', () => {
    expect(Object.keys(EXPERIMENT_BACKEND_ROUTES).sort()).toEqual(Object.keys(EXPERIMENTS).sort())
    for (const service of ['orchestrator', 'memory', 'cloud']) expect(EXPERIMENT_BACKEND_ROUTES[service]).toEqual([])
    expect(experimentBackendAllowed('messages', 'GET', '/api/agent-messages')).toBe(false)
  })

  // A route a service starts to call and does not declare fails here, not on a person's computer: every backend path written
  // in an experiment's own code is one its service may call, by the method written beside it when one is. What a path is
  // built with stands in as `x`, or as a share's id.
  it('holds every backend path written in an experiment\'s code to the routes its service declared', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
    // Named with `/` on every platform: the lists below are matched as written.
    const sources = (dir: string): string[] => readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? sources(`${dir}/${entry.name}`) : /\.ts$/.test(entry.name) && !/\.(spec|test|e2e)\.ts$/.test(entry.name) ? [`${dir}/${entry.name}`] : [])
    const OWN: Record<string, string[]> = {
      sharing: [...sources('sharing'), 'services/sharing.ts'],
      router: ['services/router.ts', ...sources('lib/jev')],
      orchestrator: [...sources('orchestrator'), 'services/orchestrator.ts'],
      memory: ['services/memory.ts'],
      cloud: [...sources('cloud'), 'services/cloud.ts'],
    }
    // Written there and not a call through the core's sign-in, each with what it is.
    const NOT_A_CALL: Record<string, string> = {}
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
    /** The method written beside a path, when it is: `backend(core, 'POST', path)`, `publish(revoked ? 'DELETE' : 'PUT', path)`. */
    const methodsBeside = (node: ts.Node): string[] => {
      const call = node.parent
      const before = ts.isCallExpression(call) ? call.arguments[call.arguments.indexOf(node as ts.Expression) - 1] : undefined
      const named = (part: ts.Node | undefined): string[] => part && ts.isStringLiteralLike(part) && METHODS.includes(part.text) ? [part.text] : []
      return before && ts.isConditionalExpression(before) ? [...named(before.whenTrue), ...named(before.whenFalse)] : named(before)
    }
    const written: string[] = [], wrong: string[] = []
    for (const [service, files] of Object.entries(OWN)) {
      for (const file of files) {
        const source = ts.createSourceFile(file, readFileSync(join(SRC, ...file.split('/')), 'utf8'), ts.ScriptTarget.Latest, true)
        const visit = (node: ts.Node): void => {
          const built = (id: string): string | null => ts.isStringLiteralLike(node) ? node.text
            : ts.isTemplateExpression(node) ? node.head.text + node.templateSpans.map((span) => `${id}${span.literal.text}`).join('') : null
          const path = built('x')
          if (path?.startsWith('/api/')) {
            const methods = methodsBeside(node)
            written.push(`${file} ${methods.join('|')}${methods.length ? ' ' : ''}${path}`)
            const routes = EXPERIMENT_BACKEND_ROUTES[service]!
            const declared = (method: string | null) => ['x', '0b0e1c2d-3f4a-4b5c-8d6e-7f8091a2b3c4'].some((id) => routes.some((route) => (method === null || route.method === method) && route.path.test(built(id)!)))
            const allowed = methods.length ? methods.every(declared) : declared(null)
            if (!allowed && !NOT_A_CALL[`${file} ${path}`]) wrong.push(`${service}: ${file} ${methods.join('|')} ${path}`)
          }
          ts.forEachChild(node, visit)
        }
        visit(source)
      }
    }
    expect(wrong, 'Declare the route in EXPERIMENT_BACKEND_ROUTES (core/api.ts), in the pull request that says why the service calls it.').toEqual([])
    for (const exception of Object.keys(NOT_A_CALL)) expect(written, `${exception} is no longer written: remove it`).toContain(exception)
    // It finds what it checks, with the method where one is written: Share's grants, the router's one call.
    expect(written).toContain('sharing/owner.ts DELETE|PUT /api/harness-shares/x')
    expect(written).toContain('lib/jev/jevClient.ts /api/route/jev')
  })

  it('has Share\'s welcomes signed by the key the gateway holds, and says why it could not', async () => {
    const publicKey = vi.fn(async () => 'cHVi')
    const signWelcome = vi.fn(async () => 'c2ln')
    const core = fakeCore({ account: { observerKey: { publicKey, signWelcome } } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_key', { op: 'public' })).toEqual({ key: 'cHVi' })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_key', { op: 'sign', machineId: 'm', shareId: 's', peer: 'p', ephemeral: 'e' })).toEqual({ key: 'c2ln' })
    expect(signWelcome).toHaveBeenCalledWith('m', 's', 'p', 'e')
    signWelcome.mockRejectedValueOnce(new Error('not a welcome to an observer'))
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_key', {})).toEqual({ error: 'not a welcome to an observer' })
    publicKey.mockRejectedValueOnce('odd')
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_key', { op: 'public' })).toEqual({ error: 'odd' })
  })

  it('tells Share which account is signed in here, and no other experiment', async () => {
    const identity = vi.fn(async (): Promise<{ accountId: string; email: string } | null> => ({ accountId: 'u-bob', email: 'bob@x.io' }))
    const core = fakeCore({ account: { identity } })
    const withShare = new Set(['orchestrator', 'sharing'])
    expect(await answerExperimentQuery(core, withShare, 'sharing', 'account', {})).toEqual({ accountId: 'u-bob', email: 'bob@x.io' })
    identity.mockResolvedValueOnce(null)
    expect(await answerExperimentQuery(core, withShare, 'sharing', 'account', {})).toEqual({ error: 'ACCOUNT_UNAVAILABLE' })
    // Any other service's `account` is its own link's to answer: models asks it for the grid name.
    expect(await answerExperimentQuery(core, withShare, 'orchestrator', 'account', {})).toBeNull()
    expect(await answerExperimentQuery(core, withShare, 'models', 'account', {})).toBeNull()
    expect(identity).toHaveBeenCalledTimes(2)
  })

  it('sends Share\'s sealed frame to one of its observers, and nothing that is not one', async () => {
    const observer = vi.fn(() => true)
    const core = fakeCore({ clients: { observer } })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_send', { connId: 'observer:ken', type: 'observer_frame', payload: { __e2e: {} } })).toEqual({ sent: true })
    expect(observer).toHaveBeenCalledWith('observer:ken', 'observer_frame', { __e2e: {} })
    for (const bad of [{ connId: 'remote-1', type: 'observer_frame', payload: {} }, { connId: 'observer:ken', type: 'agents_list', payload: {} }, { connId: 'observer:ken', type: 'observer_frame' }]) {
      expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'observer_send', bad)).toEqual({ error: 'INVALID_FRAME' })
    }
    expect(observer).toHaveBeenCalledOnce()
  })

  it('answers none of these for a process that is not an experiment, and leaves other queries to whoever answers them', async () => {
    const core = fakeCore()
    expect(await answerExperimentQuery(core, experiments, 'gateway', 'create', {})).toEqual({ error: 'NOT_AN_EXPERIMENT' })
    expect(await answerExperimentQuery(core, experiments, 'orchestrator', 'live', {})).toBeNull()
  })

  it('creates an experiment\'s agent as the window\'s agent_create does, with nothing of its own beyond what it asked', async () => {
    const request = { engine: 'claude' as const, cwd: '/w', dsh: 'cad', prompt: 'Plan it', name: 'Director', bypassPermission: false }
    const create = vi.fn(async () => ({ ok: true as const, session: agent('made') }))
    expect(await createForExperiment(create as never, request)).toEqual({ ok: true, agentId: 'made' })
    expect(create).toHaveBeenCalledWith({ ...request, grid: null, codexHome: null, agent: null, permissionMode: null })
    create.mockResolvedValueOnce({ ok: false, error: 'ENGINE_MISSING', detail: 'not here' } as never)
    expect(await createForExperiment(create as never, request)).toEqual({ ok: false, error: 'ENGINE_MISSING', detail: 'not here' })
    create.mockResolvedValueOnce({ ok: false, error: 'ENGINE_MISSING' } as never)
    expect(await createForExperiment(create as never, request)).toEqual({ ok: false, error: 'ENGINE_MISSING' })
    expect(await createForExperiment(null, request)).toEqual({ ok: false, error: 'UNSUPPORTED', detail: 'This daemon cannot create agents.' })
  })
})

describe('what the add-ons of a device that is this machine ask of the core', () => {
  it('is told this daemon\'s address, though not an experiment, and nothing else of the experiments\' doors', async () => {
    const core = fakeCore({ daemon: { machineId: () => 'm_account' } as never })
    expect(answerDaemonQuery(core, 'machineAddons', 'daemon')).toEqual({ command: 'harness', port: 18473, machineId: 'm_account', autonomousEnv: 'prod' })
    // The experiments' check alone would refuse it: the reason the core asks this first (core/main.ts).
    expect(await answerExperimentQuery(core, experiments, 'machineAddons', 'daemon', {})).toEqual({ error: 'NOT_AN_EXPERIMENT' })
    expect(answerDaemonQuery(core, 'machineAddons', 'shown')).toBeNull()
    expect(answerDaemonQuery(core, 'wifi', 'daemon')).toBeNull()
  })

  it('is told to Hachi\'s service and the agent cleanup, which reach this daemon and the owner\'s other machines as a tool does', () => {
    const core = fakeCore({ daemon: { machineId: () => 'm_account' } as never })
    for (const service of ['hachi', 'agentCleanup']) expect(answerDaemonQuery(core, service, 'daemon')).toMatchObject({ port: 18473, machineId: 'm_account' })
  })
})


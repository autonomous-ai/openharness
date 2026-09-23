import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { RegisteredSession } from '../registry.js'
import type { DshRegistryEntry } from '../../dsh/registry.js'
const state = vi.hoisted(() => ({ agents: [] as RegisteredSession[], catalog: [] as DshRegistryEntry[] }))
vi.mock('../registry.js', () => ({ registry: { list: () => state.agents, terminalAvailable: () => true } }))
vi.mock('../../dsh/catalog.js', () => ({ refreshDshRegistry: async () => state.catalog, catalogEntry: (id: string) => state.catalog.find(e => e.id === id) }))
import { env } from '../../config/env.js'
import * as engineLaunch from '../engineLaunch.js'
import { installDsh } from '../../dsh/install.js'
import { installedDsh, invalidateInstalledDsh } from '../../dsh/installed.js'
import { materializeWorkspace } from '../../dsh/materialize.js'
import { createDeviceStore, deviceStorePackages } from './storeRuntime.js'
import { DeviceStoreResultSchema } from './storeContract.js'
import { HARNESS_MONOREPO } from '../../dsh/registry.js'

let root: string, original: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'device-store-runtime-')))
  original = env.DSH_DIR; env.DSH_DIR = join(root, 'installed'); invalidateInstalledDsh()
  state.agents = []; state.catalog = []
  // Run real fixture shell scripts, without sourcing the operator's login profile.
  vi.spyOn(engineLaunch, 'interactiveEngineShell').mockReturnValue(null)
})
afterEach(() => { vi.restoreAllMocks(); env.DSH_DIR = original; invalidateInstalledDsh(); rmSync(root, { recursive: true, force: true }) })
async function setup() {
  const source = join(root, 'package'); mkdirSync(join(source, 'template'), { recursive: true })
  writeFileSync(join(source, 'harness.json'), JSON.stringify({ spec: 1, id: 'test/robot-fixture', name: 'Robot fixture', engine: 'claude',
    toolchain: { setup: 'setup.sh', doctor: 'doctor.sh' }, workspace: { template: 'template', marker: 'scene.txt' }, agent: { instructions: 'AGENTS.md' } }))
  writeFileSync(join(source, 'setup.sh'), '#!/bin/sh\nprintf installed > dependency\n', { mode: 0o755 })
  writeFileSync(join(source, 'doctor.sh'), '#!/bin/sh\nif [ -f dependency ]; then echo "ok dependency"; else echo "miss dependency"; exit 1; fi\n', { mode: 0o755 })
  writeFileSync(join(source, 'AGENTS.md'), 'Fixture instructions, no model calls.\n')
  writeFileSync(join(source, 'template', 'scene.txt'), 'fixture scene\n')
  const installed = await installDsh({ source, link: true })
  expect(installed.ok).toBe(true)
  const cwd = join(root, 'workspace'); mkdirSync(cwd)
  const create = vi.fn(async (input: Parameters<NonNullable<import('../../backendSocket.js').BackendSocket['onCreateAgent']>>[0]) => {
    await materializeWorkspace(installedDsh(input.dsh!)!, input.cwd)
    const session = { agentId: 'fixture-agent', sessionId: 'native-conversation', active: true, cwd: input.cwd, dsh: input.dsh, engine: input.engine, launch: { state: 'ready' } } as RegisteredSession
    state.agents.push(session)
    return { ok: true as const, session }
  })
  const store = createDeviceStore({ dataDir: join(root, 'state'), machineId: 'mac', create })
  const request = { type: 'agent.prepare', requestId: randomUUID(), machineId: 'mac', packageId: 'test/robot-fixture', workspace: { kind: 'existing', path: cwd }, idempotencyKey: 'prepare' }
  return { source, cwd, create, store, request }
}
describe('device Store production adapter with real local package scripts', () => {
  it('uses actual installed inventory, doctor and materialization with safe creation arguments', async () => {
    const f = await setup()
    const reply = await f.store.request('lamp', f.request)
    const id = (reply.operation as { operationId: string }).operationId
    await vi.waitFor(() => expect(f.store.get('lamp', id).state).toBe('ready'))
    expect(f.store.get('lamp', id).doctor).toEqual(['test/robot-fixture: ok dependency'])
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: f.cwd, dsh: 'test/robot-fixture', prompt: null, bypassPermission: false, permissionMode: null, grid: null, codexHome: null }))
    const req = { type: 'store.inspect', requestId: randomUUID(), packageId: 'test/robot-fixture' }
    const response = { type: 'store.inspect_result', requestId: req.requestId, ...await f.store.request('lamp', req) }
    expect(DeviceStoreResultSchema.parse(response)).toMatchObject({ package: { installed: true, catalog: false, readiness: { state: 'passed' } }, candidates: [{ agentId: 'fixture-agent', runtime: 'ready' }] })
  })
  it('reports a real doctor failure without spawning', async () => {
    const f = await setup(); rmSync(join(f.source, 'dependency'))
    const reply = await f.store.request('lamp', f.request), id = (reply.operation as { operationId: string }).operationId
    await vi.waitFor(() => expect(f.store.get('lamp', id)).toMatchObject({ state: 'needs_user_action', error: { code: 'DEPENDENCY_NOT_READY' } }))
    expect(f.create).not.toHaveBeenCalled()
  })
  it('canonicalizes symlinks and refuses a workspace held by another session', async () => {
    const f = await setup(), link = join(root, 'alias'); symlinkSync(f.cwd, link)
    state.agents.push({ agentId: 'other', cwd: f.cwd, dsh: null, engine: 'codex', active: true } as RegisteredSession)
    const reply = await f.store.request('lamp', { ...f.request, workspace: { kind: 'existing', path: link } })
    const id = (reply.operation as { operationId: string }).operationId
    await vi.waitFor(() => expect(f.store.get('lamp', id)).toMatchObject({ error: { code: 'WORKSPACE_IN_USE' } }))
    expect(f.create).not.toHaveBeenCalled()
  })
  it('checks official source identity and all uninstalled viewer dependencies', async () => {
    const entry: DshRegistryEntry = { id: 'autonomous/blender', name: 'Blender', engine: 'claude', verified: true, repo: HARNESS_MONOREPO,
      path: 'store/agents/blender', viewerUse: 'autonomous/model-viewer' }
    state.catalog = [entry]
    expect(await deviceStorePackages()).toMatchObject([{ installAllowed: false }])
    state.catalog.push({ id: 'autonomous/model-viewer', name: '3D viewer', kind: 'viewer', verified: true, repo: HARNESS_MONOREPO, path: 'store/viewers/model-viewer' })
    expect(await deviceStorePackages()).toMatchObject([{ installAllowed: true }])
    state.catalog[1].repo = 'https://github.com/someone/else'
    expect(await deviceStorePackages()).toMatchObject([{ installAllowed: false }])
  })
})

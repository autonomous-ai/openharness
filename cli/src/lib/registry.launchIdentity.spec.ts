import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registry, matchesLaunchReceipt } from './registry.js'
import { REGISTRY_WRITE_DEADLINE_MS } from './registryPersistence.js'
import { removeRegistryAgent } from '../testing/registryFixtures.js'

vi.mock('node:perf_hooks', async original => ({ ...await original<object>(), performance: { now: () => 0 } }))
const deadline = await vi.hoisted(() => import('../testing/registryDeadline.js'))
vi.mock('node:fs/promises', original => deadline.slowSyncFsPromises(original))

const runtime = { backend: 'tmux' as const, paneId: '%70' }
const first = { pid: 7001, startMarker: 'one', executable: '/fixture/codex' }
const second = { pid: 7002, startMarker: 'two', executable: '/fixture/codex' }
const id = '33333333-3333-4333-8333-333333333333'
let directory = ''
// No test here means the write deadline to pass: how fast this machine writes the registry never fails them.
beforeEach(() => { deadline.holdRegistryDeadline(REGISTRY_WRITE_DEADLINE_MS) })
afterEach(async () => {
  for (const entry of registry.list()) await removeRegistryAgent(registry, entry.agentId)
  await registry.flush()
  rmSync(directory, { recursive: true, force: true })
})

/** An agent bound to a conversation, then relaunched: its launch is published `ready` (restart.ts). */
async function relaunched() {
  directory = mkdtempSync(join(tmpdir(), 'launch-identity-'))
  const home = join(directory, 'codex'), transcript = join(home, 'sessions', `rollout-${id}.jsonl`)
  mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id, cwd: directory, source: 'cli' } }) + '\n')
  const hook = (processIdentity: typeof first) => registry.register({ engine: 'codex', sessionId: id, transcriptPath: transcript,
    codexHome: home, cwd: directory, runtimes: [runtime], processIdentity }, { verifiedNativeSource: true })
  const admitted = (await registry.openPendingAgent({ engine: 'codex', runtimes: [runtime], cwd: directory, codexHome: home }))!
  registry.updateProcessIdentity(admitted.agentId, first)
  await registry.flush()
  expect(await hook(first)).not.toBeNull()
  expect((await registry.confirmLaunch(admitted.agentId, { processIdentity: second, grid: null })).state).toBe('confirmed')
  return { agentId: admitted.agentId, hook }
}

it('a relaunched engine re-registering its own conversation leaves the next request\'s target unchanged', async () => {
  const { agentId, hook } = await relaunched()
  // A second restart, queued behind the first, captures its target now (restart.ts).
  const target = structuredClone(registry.byAgent(agentId)!)
  expect(target.launch).toEqual({ state: 'ready' })
  // The relaunched engine's own SessionStart commits after (hookServer.ts).
  expect(await hook(second)).not.toBeNull()
  expect(registry.byAgent(agentId)!.launch).toBeUndefined()
  expect(matchesLaunchReceipt(registry.byAgent(agentId), target)).toBe(true)
})

it('a launch that did change still ends the receipt', async () => {
  const { agentId } = await relaunched()
  const target = structuredClone(registry.byAgent(agentId)!)
  registry.setLaunch(agentId, { state: 'starting', nativeToken: '11111111-1111-1111-1111-111111111111' })
  expect(matchesLaunchReceipt(registry.byAgent(agentId), target)).toBe(false)
})

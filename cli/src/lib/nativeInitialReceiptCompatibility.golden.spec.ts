/** Former first-create receipts before adding explicit native allocation
 * provenance. Fixed platform, UUIDs and paths make this independent of host. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint, type AgentCreationOutcome } from './agentCreationReceipt.js'

vi.mock('node:crypto', async original => ({ ...await original<object>(), randomUUID: () => '00000000-0000-4000-8000-000000000001' }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the initial receipt golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
const path = fileURLToPath(new URL('./__fixtures__/native-initial-receipt-compatibility.golden.json', import.meta.url))
const record = process.env.RECORD_NATIVE_INITIAL_RECEIPT_GOLDEN === '1'
const expected = record ? {} : JSON.parse(readFileSync(path, 'utf8'))
const captured: Record<string, unknown> = {}
const id = 'original-create-golden-request'
const input = { engine: 'cursor', cwd: '/fixture/project', prompt: 'Fixture prompt', grid: null }
const request = { kind: 'native-create-v1', input, selection: null, label: 'harness-cursor-original', local: true }
const fingerprint = creationFingerprint(input), held = { service: 'launch', detail: 'Waiting for the original launch.' }
const check = (call: () => unknown) => {
  try { return { value: call() ?? null } }
  catch (error) { return { error: (error as { code?: string }).code ?? 'unavailable' } }
}

it.each(['linux', 'darwin'])('keeps former first-create receipt behavior on %s', async platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'initial-receipt-golden-')))
  try {
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    vi.stubEnv('TZ', 'UTC')
    const observations: Record<string, unknown> = {}
    for (const mode of ['pending', 'cancelled', 'unconfirmed', 'created', 'failed'] as const) {
      const directory = join(root, mode); mkdirSync(directory, { mode: 0o700 })
      const receipts = new AgentCreationReceipts(directory), prepared: unknown[] = []
      let dispatched = 0
      const status = await receipts.runIntent(id, fingerprint, request, held, async (saved, authority) => {
        prepared.push({ saved, current: authority.current() })
        if (mode === 'pending' || mode === 'cancelled') return null
        return async (): Promise<AgentCreationOutcome> => {
          dispatched++
          if (mode === 'created') return { state: 'created', agentId: 'fixture-agent' }
          if (mode === 'failed') return { state: 'failed', error: 'FIXTURE_REFUSAL' }
          return { state: 'unconfirmed' }
        }
      })
      if (mode === 'cancelled') receipts.cancelIntent(id)
      const cold = new AgentCreationReceipts(directory)
      const retried = await cold.runIntent(id, fingerprint, { ...request, label: 'harness-cursor-later', local: false }, held, async saved => {
        prepared.push({ saved }); return null
      })
      observations[mode] = { status, cold: cold.status(id), retried, prepared, dispatched,
        conflict: check(() => cold.has(id, 'f'.repeat(64))),
        rearmWitness: check(() => cold.readNativeRelaunchProcess(id, { request, fingerprint })),
        rearmCompletion: check(() => cold.readNativeRelaunchCompletion(id, { request, fingerprint })),
        notDispatched: check(() => cold.readNativeRelaunchNotDispatched(id, { request, fingerprint })),
      }
    }
    captured[platform] = observations
    if (!record) expect(observations).toEqual(expected[platform])
  } finally {
    Object.defineProperty(process, 'platform', original); vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
afterAll(() => { if (record) writeFileSync(path, JSON.stringify(captured, null, 2) + '\n') })

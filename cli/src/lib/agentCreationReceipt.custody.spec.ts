import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fault = vi.hoisted(() => ({ inode: undefined as number | undefined, attempts: 0 }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, closeSync: (fd: number) => {
    const fail = actual.fstatSync(fd).ino === fault.inode
    actual.closeSync(fd)
    if (fail) { fault.attempts++; throw new Error('fixture close uncertainty') }
  } }
})

let root: string
beforeEach(() => { vi.resetModules(); root = mkdtempSync(join(tmpdir(), 'receipt-custody-')); fault.inode = undefined; fault.attempts = 0 })
afterEach(() => { fault.inode = undefined; rmSync(root, { recursive: true, force: true }) })

it.each(['primary', 'hold', 'claim', 'result'] as const)('preserves shared cleanup uncertainty from the %s read and refuses more acquisition', async part => {
  const { AgentCreationReceipts, creationFingerprint } = await import('./agentCreationReceipt.js')
  const { StateFileCleanupUnconfirmed } = await import('./secureState.js')
  const directory = join(root, 'agent-creations'), id = 'receipt-custody-fixture', request = { fixture: true }
  const receipts = new AgentCreationReceipts(directory)
  await receipts.runIntent(id, creationFingerprint(request), request, { service: 'models', detail: 'Waiting.' }, async (_request, authority) => {
    authority.hold({ service: 'models', detail: 'Still waiting.' })
    return part === 'claim' || part === 'result' ? async () => ({ state: 'created', agentId: 'fixture' }) : null
  })
  const path = part === 'primary' ? `${id}.json` : part === 'hold' ? `${id}.hold` : `${id}.json.${part}`
  fault.inode = statSync(join(directory, path)).ino
  expect(() => new AgentCreationReceipts(directory).status(id)).toThrow(StateFileCleanupUnconfirmed)
  expect(() => new AgentCreationReceipts(directory).status('another-receipt-fixture')).toThrow(StateFileCleanupUnconfirmed)
  expect(fault.attempts).toBe(1)
})

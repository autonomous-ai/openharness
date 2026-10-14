/** Record the former completion/cleanup behavior before sharing their retained
 * receipt checks. Only disposable files are read; no engine or daemon runs. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import { AgentCreationReceipts, creationFingerprint } from './agentCreationReceipt.js'
import type { NativeArchiveLink } from './nativeArchive.js'

vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the receipt golden') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
const path = fileURLToPath(new URL('./__fixtures__/native-receipt-cleanup.golden.json', import.meta.url))
const record = process.env.RECORD_NATIVE_RECEIPT_GOLDEN === '1'
const expected = record ? {} : JSON.parse(readFileSync(path, 'utf8'))
const captured: Record<string, unknown> = {}
const id = 'native-cleanup-golden-request', agentId = 'fixture-agent'
const link: NativeArchiveLink = { version: 1, agentId, requestId: id, launchToken: 'native-cleanup-golden-token', target: 'a'.repeat(64) }
const owner = { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: 234, birth: '123456', namespace: 'linux:4:5' }
const request = { kind: 'native-rearm', creationId: id, operation: 'resume', source: 'saved', agentId,
  launchToken: link.launchToken, target: link.target, permissionMode: 'full', sourceProcess: {
    processKey: `${owner.boot}\0cursor\0${42}\0${12345}`, namespace: owner.namespace } }
const fingerprint = creationFingerprint({ kind: 'native-rearm', agentId, operation: 'resume', source: 'saved', permissionMode: 'full' })
const outcome = { state: 'created' as const, agentId, resumed: true }
const fence = { verify() {}, current() {} }
const check = (call: () => unknown) => {
  try { return { value: call() ?? null } }
  catch (error) { return { error: (error as { code?: string }).code ?? 'retained-evidence-changed' } }
}

it.each(['linux', 'darwin'])('keeps original receipt cleanup outcomes on %s', async platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'receipt-cleanup-golden-')))
  const observations: Record<string, unknown> = {}
  try {
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    vi.stubEnv('TZ', 'UTC')
    for (const mode of ['missing', 'tombstone', 'pending', 'cancelled', 'uncertain', 'not-dispatched', 'failed', 'witness', 'created']) {
      const directory = join(root, mode); mkdirSync(directory, { mode: 0o700 })
      const receipts = new AgentCreationReceipts(directory)
      if (mode === 'tombstone') receipts.cancelIntent(id)
      else if (mode !== 'missing') {
        await receipts.runIntent(id, fingerprint, request, { service: 'native', detail: 'Waiting for the original allocation.' }, async () =>
          mode === 'pending' || mode === 'cancelled' ? null : async () => {
            if (mode === 'witness' || mode === 'created') receipts.recordNativeRelaunchProcess(id, { fingerprint, request }, owner, fence)
            if (mode === 'not-dispatched' || mode === 'failed') return { state: 'failed', error: mode === 'failed' ? 'OTHER_FAILURE' : 'NATIVE_REARM_NOT_DISPATCHED' }
            return { state: 'unconfirmed' }
          })
        if (mode === 'cancelled') receipts.cancelIntent(id)
        if (mode === 'created') receipts.confirmNativeRelaunch(id, { fingerprint, request, outcome }, fence)
      }
      const cold = new AgentCreationReceipts(directory)
      const completed = () => cold.readNativeRelaunchCompletion(id, { fingerprint, request })
      const cleanup = () => cold.readNativeResumeCleanup(link)
      observations[mode] = {
        status: check(() => cold.status(id)),
        completion: check(() => { const proof = completed(); proof.verify(); return proof.outcome }),
        cleanup: check(() => { const { verify, ...proof } = cleanup(); verify(); return proof }),
        foreignRequest: check(() => cold.readNativeRelaunchCompletion(id, { fingerprint, request: { ...request, launchToken: 'other-original-token' } })),
        foreignLink: check(() => cold.readNativeResumeCleanup({ ...link, target: 'b'.repeat(64) })),
      }
      if (mode === 'created' || mode === 'cancelled') {
        const invalidations: Record<string, unknown> = {}
        for (const part of ['', 'claim', 'result', 'confirmation', 'process']) {
          const cleanupProof = cleanup(), completionProof = mode === 'created' ? completed() : null
          const file = join(directory, `${id}.json${part && '.' + part}`)
          let bytes: Buffer | undefined
          try { bytes = readFileSync(file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          if (bytes) renameSync(file, file + '.previous')
          writeFileSync(file, bytes ?? '{}', { mode: 0o600 })
          invalidations[part || 'primary'] = { cleanup: check(cleanupProof.verify), completion: completionProof ? check(completionProof.verify) : null }
          rmSync(file)
          if (bytes) renameSync(file + '.previous', file)
        }
        observations[mode + ':retained'] = invalidations
      }
    }
    captured[platform] = observations
    if (!record) expect(captured[platform]).toEqual(expected[platform])
  } finally {
    Object.defineProperty(process, 'platform', original); vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
afterAll(() => { if (record) writeFileSync(path, JSON.stringify(captured, null, 2) + '\n') })

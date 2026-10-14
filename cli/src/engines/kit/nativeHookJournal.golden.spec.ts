/** Former effect order, recorded before adding the client-only outbox log kind. */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { createNativeHookJournal } from './nativeHookJournal.js'

vi.mock('node:fs', async original => ({ ...await original<object>(),
  fsync: (_fd: number, done: (error: Error | null) => void) => queueMicrotask(() => done(null)),
}))
const ids = vi.hoisted(() => ({ value: 0 }))
vi.mock('node:crypto', async original => ({ ...await original<object>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.value).padStart(12, '0')}`,
}))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => 0 } }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the hook journal golden') }
  return { execFile: forbidden, exec: forbidden, execSync: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
const GOLDEN = new URL('../../__fixtures__/native-hook-journal.golden.json', import.meta.url)
const RECORD = process.env.RECORD_NATIVE_HOOK_JOURNAL_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

it('preserves intake, exclusive order, durable result and crash refusal', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-journal-golden-')))
  const check = (name: string, value: unknown) => {
    captured[name] = JSON.parse(JSON.stringify(value))
    if (!RECORD) expect({ name, value: captured[name] }).toEqual({ name, value: expected[name] })
  }
  const refusal = async (work: () => unknown) => {
    try { await work(); return 'unexpected success' } catch (error) { return { name: (error as Error).name, message: (error as Error).message } }
  }
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    vi.stubEnv('TZ', 'UTC'); vi.stubEnv('TMPDIR', '/tmp')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-11T00:00:00Z') })
    const directory = join(root, 'history'), processKey = 'linux:fixture-boot\u0000codex\u0000123\u0000t:456'
    const journal = () => createNativeHookJournal({ directory, processKey })
    const first = { id: 'fixture-delivery-0001', fingerprint: hash('first'), agentId: 'fixture-agent',
      conversationId: 'fixture-conversation', firedAt: Date.now(), payload: { hookEvent: 'UserPromptSubmit', prompt: 'fixture prompt' } }
    const second = { ...first, id: 'fixture-delivery-0002', fingerprint: hash('second') }
    const original = journal()
    await original.retain(first); await journal().retain(second)
    const claim = await original.claim(first.id, first.agentId)
    check('claim', { id: claim.id, token: claim.token })
    check('contending', await refusal(() => journal().claim(second.id, second.agentId)))
    const result = { status: 200, reply: { ok: true }, promptAt: first.firedAt }
    await claim.finish(result)
    check('duplicate', (await journal().retain(first)).result)
    check('conflict', await refusal(() => journal().retain({ ...first, fingerprint: hash('changed') })))
    const uncertain = await original.claim(second.id, second.agentId)
    original.close()
    check('closed', await refusal(() => uncertain.finish({ status: 200 })))
    check('interrupted', await refusal(() => journal().claim(second.id, second.agentId)))
    const recovered = await journal().snapshot()
    await recovered.confirm(); recovered.verify()
    check('recovered', { length: recovered.length, active: recovered.active && { id: recovered.active.id, token: recovered.active.token },
      deliveries: [...recovered.deliveries].map(([id, item]) => ({ id, intake: item.intake, result: item.result, token: item.resultToken })) })
    // Record real on-disk schemas and links. Paths/inodes live only in the
    // bootstrap metadata; every effect record below is independent of the host.
    const records = Array.from({ length: recovered.length }, (_, index) => {
      const name = `${String(index).padStart(8, '0')}.json`
      const text = readFileSync(join(directory, name), 'utf8')
      expect(readFileSync(join(`${directory}.witnesses`, name), 'utf8')).toBe(text)
      return JSON.parse(text)
    })
    check('records', records)
  } finally {
    vi.useRealTimers(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platform)
    rmSync(root, { recursive: true, force: true })
  }
})

afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  else expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})

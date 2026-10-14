/** Actual OS processes share no JS reservations or claim objects. */
import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import type { NativeHookIntake } from './nativeHookJournal.js'

const processKey = 'linux:fixture-boot\u0000codex\u00005100\u0000t:1234'
const intake = (id = 'fixture-delivery-0001', agentId = 'agent-one'): NativeHookIntake => ({
  id, agentId, fingerprint: createHash('sha256').update(id).digest('hex'), conversationId: 'conversation-one',
  firedAt: 1791590400123, payload: { prompt: 'private fixture prompt' },
})
let bundleRoot: string, root: string, directory: string, script: string
type Reply = { ok: boolean; value?: any; error?: string }
type Worker = ReturnType<typeof worker>
const workers = new Set<Worker>()

beforeAll(() => {
  bundleRoot = realpathSync(mkdtempSync(join(tmpdir(), 'hook-journal-process-bundle-')))
  script = join(bundleRoot, 'journal.mjs')
  buildSync({ stdin: { resolveDir: process.cwd(), sourcefile: 'journal-fixture.ts', contents: `
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { createNativeHookJournal, createNativeHookOutboxLog } from ${JSON.stringify(resolve('src/engines/kit/nativeHookJournal.ts'))}
    import { createNativeHookCatalog } from ${JSON.stringify(resolve('src/engines/kit/nativeHookCatalog.ts'))}
    import { createNativeHookStagePool } from ${JSON.stringify(resolve('src/engines/kit/nativeHookStaging.ts'))}
    const [directory, encodedKey, options] = process.argv.slice(2), processKey = JSON.parse(encodedKey)
    const { outbox, catalog: allocated, maxGenerations, terminalGenerations, ...limits } = JSON.parse(options)
    const dead = new Set(), claims = new Map()
    const pool = allocated && createNativeHookStagePool({ root: directory,
      writer: { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid: process.pid, birth: '12345' },
      verifyWriter: () => {}, closeWriter: () => {}, maxGenerations, terminalGenerations,
      // Only the parent fixture's observed child exit supplies this proof.
      dead: async writer => dead.has(writer.pid) && writer.birth === '12345',
    })
    const catalog = allocated && createNativeHookCatalog({ root: directory, verifyRoot: () => {}, pool })
    let cachedJournal
    const journalForRequest = async () => cachedJournal ??= allocated ? await catalog.effects(processKey)
      : (outbox ? createNativeHookOutboxLog : createNativeHookJournal)({ directory, processKey, ...limits })
    let pauseKind, pauseNextSync = false, release
    const link = fs.linkSync, flush = fs.fsync
    fs.linkSync = (source, target) => {
      link(source, target)
      if (pauseKind && (allocated ? String(target).startsWith(directory + '/') && String(target).includes('.history.witnesses/')
        : String(target).startsWith(directory + '.witnesses/'))
        && JSON.parse(fs.readFileSync(target, 'utf8')).event?.kind === pauseKind) {
        pauseKind = undefined; pauseNextSync = true
      }
    }
    fs.fsync = (fd, done) => {
      if (!pauseNextSync) { flush(fd, done); return }
      pauseNextSync = false
      // The kernel flush is real. Only its completion delivery is paused: the
      // competing OS process can observe the exclusively published witness.
      flush(fd, error => { release = () => done(error); process.send({ event: 'paused' }) })
    }
    syncBuiltinESMExports()
    process.on('message', async ({ request, operation, value }) => {
      try {
        let result
        const journal = await journalForRequest()
        if (operation === 'retain') {
          const delivery = await journal.retain(value)
          result = { intake: delivery.intake, result: delivery.result, acknowledgements: delivery.acknowledgements && [...delivery.acknowledgements] }
        } else if (operation === 'snapshot') {
          const snapshot = await journal.snapshot(); snapshot.verify()
          result = { previous: snapshot.previous, active: snapshot.active,
            length: snapshot.length, deliveries: [...snapshot.deliveries.values()].map(item => ({ intake: item.intake, result: item.result,
              acknowledgements: item.acknowledgements && [...item.acknowledgements] })) }
        } else if (operation === 'ack') {
          await journal.acknowledge(value.id, value.fingerprint, value.phase)
        } else if (operation === 'claim') {
          const claim = await journal.claim(value.id, value.agentId, value.inspected)
          claim.verify(); claims.set(claim.id, claim); result = { token: claim.token }
        } else if (operation === 'finish') {
          const claim = claims.get(value.id); await claim.finish(value.result); result = { token: claim.token }
        } else if (operation === 'verify') { claims.get(value.id).verify(); result = true
        } else if (operation === 'pause') { pauseKind = 'claim'
        } else if (operation === 'pause-ack') { pauseKind = 'ack'
        } else if (operation === 'consume-normal') {
          for (let index = 0; index < value; index++) { const lease = await pool.acquire(); await lease.close() }
        } else if (operation === 'dead') { for (const pid of value) dead.add(pid)
        } else if (operation === 'release') { if (!release) throw Error('No paused flush'); release(); release = undefined
        } else throw Error('Unknown fixture operation')
        process.send({ request, ok: true, value: result })
      } catch (error) { process.send({ request, ok: false, error: String(error) }) }
    })
    process.send({ event: 'ready' })
  ` }, outfile: script, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
})
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-journal-process-')))
  directory = join(root, 'history')
  mkdirSync(join(root, 'home'), { mode: 0o700 })
})
afterEach(async () => {
  await Promise.all([...workers].map(worker => worker.kill()))
  workers.clear(); rmSync(root, { recursive: true, force: true })
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

function worker(options: { outbox?: boolean; maxRecords?: number; catalog?: boolean; maxGenerations?: number; terminalGenerations?: number } = {}) {
  // Catalogs own an existing private root; direct logs must create their own
  // directory only after publishing bootstrap authority.
  if (options.catalog) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const child: ChildProcess = fork(script, [directory, JSON.stringify(processKey), JSON.stringify(options)], {
    execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'),
      CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), TZ: 'UTC', TMPDIR: '/tmp' },
  })
  let request = 0, stderr = '', closed = false
  const pending = new Map<number, (value: Reply) => void>()
  const events = new Map<string, () => void>()
  child.stderr!.on('data', bytes => { stderr += bytes })
  const ready = new Promise<void>(done => { events.set('ready', done) })
  child.on('message', (message: any) => {
    if (message.event) { events.get(message.event)?.(); events.delete(message.event) }
    else { pending.get(message.request)?.(message); pending.delete(message.request) }
  })
  const exited = new Promise<void>(done => child.once('close', () => {
    closed = true
    for (const settle of pending.values()) settle({ ok: false, error: `Private writer exited: ${stderr}` })
    pending.clear(); done()
  }))
  const value = {
    pid: child.pid!,
    async call(operation: string, value?: unknown): Promise<Reply> {
      await ready
      if (closed) return { ok: false, error: 'Private writer already exited' }
      const id = ++request
      return new Promise(done => {
        const timer = setTimeout(() => {
          pending.delete(id); child.kill('SIGKILL'); done({ ok: false, error: `Private writer exceeded its deadline: ${stderr}` })
        }, 12_000)
        pending.set(id, result => { clearTimeout(timer); done(result) })
        child.send({ request: id, operation, value })
      })
    },
    event: (name: string) => new Promise<void>(done => { events.set(name, done) }),
    async kill() { if (!closed) child.kill('SIGKILL'); await exited },
  }
  workers.add(value)
  return value
}
async function accepted(writer: Worker, operation: string, value?: unknown) {
  const reply = await writer.call(operation, value)
  expect(reply, reply.error).toMatchObject({ ok: true })
  return reply.value
}

it.each([false, true])('grants one effect to separate cores with distinct/same IDs (same=%s)', async same => {
  const a = worker(), b = worker(), first = intake(), second = same ? first : intake('fixture-delivery-0002', 'agent-two')
  await accepted(a, 'retain', first)
  if (!same) await accepted(b, 'retain', second)
  const replies = await Promise.all([a.call('claim', first), b.call('claim', second)])
  expect(replies.filter(reply => reply.ok)).toHaveLength(1)
  expect(replies.filter(reply => !reply.ok)).toHaveLength(1)
  expect(replies.find(reply => !reply.ok)!.error)
    .toMatch(/Native hook delivery is held:|Hook preparation is waiting:|Error: EEXIST:/)
  const owner = replies[0].ok ? a : b, body = replies[0].ok ? first : second
  const snapshot = await accepted(worker(), 'snapshot')
  expect(snapshot.active).toMatchObject({ id: body.id, token: replies.find(reply => reply.ok)!.value.token })
  await accepted(owner, 'finish', { id: body.id, result: { accepted: true } })
  expect((await accepted(worker(), 'snapshot')).active).toBeUndefined()
}, 30_000)

it('rejects another agent view of an already retained ID in the same process namespace', async () => {
  const a = worker(), b = worker(), first = intake(), impostor = { ...first, agentId: 'agent-two' }
  await accepted(a, 'retain', first)
  expect(await b.call('retain', impostor)).toMatchObject({ ok: false, error: expect.stringContaining('different agent owner') })
  expect(await b.call('claim', impostor)).toMatchObject({ ok: false, error: expect.stringContaining('cannot dispatch') })
  await accepted(a, 'claim', first)
  await accepted(a, 'finish', { id: first.id, result: { accepted: true } })
}, 30_000)

it('keeps a paused exclusive publisher as the only owner when a peer repairs its mirror', async () => {
  const a = worker(), b = worker(), first = intake(), second = intake('fixture-delivery-0002', 'agent-two')
  await accepted(a, 'retain', first); await accepted(b, 'retain', second)
  await accepted(a, 'pause')
  const paused = a.event('paused'), claim = a.call('claim', first)
  await paused
  const snapshot = await accepted(b, 'snapshot')
  expect(snapshot.active).toMatchObject({ id: first.id, agentId: first.agentId })
  expect(await b.call('claim', second)).toMatchObject({ ok: false, error: expect.stringContaining('earlier native hook effect') })
  await accepted(a, 'release')
  expect(await claim).toMatchObject({ ok: true, value: { token: snapshot.active.token } })
  await accepted(a, 'verify', first)
  await accepted(a, 'finish', { id: first.id, result: { accepted: true } })
  await accepted(b, 'claim', second)
  await accepted(b, 'finish', { id: second.id, result: { accepted: true } })
  expect((await accepted(worker(), 'snapshot')).deliveries.map((row: any) => row.result)).toEqual([{ accepted: true }, { accepted: true }])
}, 30_000)

it('holds an unconfirmed claim after SIGKILL instead of granting a replacement permission', async () => {
  const a = worker(), first = intake(), second = intake('fixture-delivery-0002', 'agent-two')
  await accepted(a, 'retain', first); await accepted(a, 'retain', second); await accepted(a, 'pause')
  const paused = a.event('paused'), claiming = a.call('claim', first)
  await paused; await a.kill()
  expect(await claiming).toMatchObject({ ok: false })
  const recovered = worker(), snapshot = await accepted(recovered, 'snapshot')
  expect(snapshot.active).toMatchObject({ id: first.id, agentId: first.agentId })
  expect(await recovered.call('claim', first)).toMatchObject({ ok: false, error: expect.stringContaining('earlier native hook effect') })
  expect(await recovered.call('claim', second)).toMatchObject({ ok: false, error: expect.stringContaining('earlier native hook effect') })
  expect(snapshot.deliveries.map((row: any) => row.result)).toEqual([undefined, undefined])
}, 30_000)

it('finishes catalog-backed work across separate OS writers after normal staging reaches its limit', async () => {
  const options = { catalog: true, maxGenerations: 4, terminalGenerations: 3 }
  const a = worker(options), b = worker(options), first = intake(), second = intake('fixture-delivery-0002', 'agent-two')
  await accepted(a, 'retain', first); await accepted(b, 'retain', second)
  await accepted(a, 'consume-normal', 6)
  expect(await b.call('retain', intake('fixture-delivery-0003'))).toMatchObject({ ok: false, error: expect.stringContaining('generation capacity') })
  await accepted(a, 'pause')
  const paused = a.event('paused'), claiming = a.call('claim', first)
  await paused
  const snapshot = await accepted(b, 'snapshot')
  expect(snapshot.active).toMatchObject({ id: first.id })
  await accepted(a, 'release')
  const claimed = await claiming
  expect(claimed, claimed.error).toMatchObject({ ok: true, value: { token: snapshot.active.token } })
  await accepted(a, 'finish', { id: first.id, result: { accepted: true } })
  await accepted(b, 'claim', second)
  await accepted(b, 'finish', { id: second.id, result: { accepted: true } })
  expect((await accepted(worker(options), 'snapshot')).deliveries.map((row: any) => row.result)).toEqual([{ accepted: true }, { accepted: true }])
  expect(readdirSync(directory).filter(name => name.endsWith('.allocation.witness'))).toHaveLength(1)
  expect(readdirSync(directory, { recursive: true }).map(String).some(name => name.endsWith('.tmp'))).toBe(false)
}, 30_000)

it('keeps a catalog-backed uncertain claim held after a real writer dies at terminal cutover', async () => {
  const options = { catalog: true, maxGenerations: 4, terminalGenerations: 3 }
  const a = worker(options), first = intake()
  await accepted(a, 'retain', first); await accepted(a, 'consume-normal', 7); await accepted(a, 'pause')
  const paused = a.event('paused'), claiming = a.call('claim', first)
  await paused; await a.kill()
  expect(await claiming).toMatchObject({ ok: false })
  const recovered = worker(options)
  await accepted(recovered, 'dead', [a.pid])
  expect((await accepted(recovered, 'snapshot')).active).toMatchObject({ id: first.id })
  expect(await recovered.call('claim', first)).toMatchObject({ ok: false, error: expect.stringContaining('earlier native hook effect') })
  expect(readdirSync(directory).filter(name => name.endsWith('.allocation.witness'))).toHaveLength(1)
  expect(readdirSync(directory, { recursive: true }).map(String).some(name => name.endsWith('.tmp'))).toBe(false)
}, 30_000)

it('refuses a frontier inspected before another process adds an equal-time delivery', async () => {
  const a = worker(), b = worker(), first = intake(), second = intake('fixture-delivery-0002', 'agent-two')
  await accepted(a, 'retain', first)
  const inspected = await accepted(a, 'snapshot')
  await accepted(b, 'retain', second)
  expect(await a.call('claim', { ...first, inspected })).toMatchObject({ ok: false, error: expect.stringContaining('order changed after inspection') })
  expect((await accepted(a, 'snapshot')).active).toBeUndefined()
  const fresh = await accepted(b, 'snapshot')
  await accepted(b, 'claim', { ...second, inspected: fresh })
  await accepted(b, 'finish', { id: second.id, result: { accepted: true } })
  expect(await a.call('claim', { ...first, inspected })).toMatchObject({ ok: false, error: expect.stringContaining('order changed after inspection') })
}, 30_000)

it('restores a completed receipt after process exit without accepting a changed retry', async () => {
  const a = worker(), first = intake()
  await accepted(a, 'retain', first); await accepted(a, 'claim', first)
  await accepted(a, 'finish', { id: first.id, result: { accepted: true, status: 200, reply: { ok: true } } })
  await a.kill()
  const b = worker()
  expect((await accepted(b, 'retain', first)).result).toEqual({ accepted: true, status: 200, reply: { ok: true } })
  expect(await b.call('claim', first)).toMatchObject({ ok: false, error: expect.stringContaining('cannot dispatch') })
  expect(await b.call('retain', { ...first, fingerprint: 'f'.repeat(64), payload: { prompt: 'changed' } }))
    .toMatchObject({ ok: false, error: expect.stringContaining('HOOK_DELIVERY_CONFLICT') })
}, 30_000)

it('reserves every outbox phase against separate clients contending for the last capacity', async () => {
  const a = worker({ outbox: true, maxRecords: 3 }), b = worker({ outbox: true, maxRecords: 3 })
  // Establish authority before the two clients race for one immutable frontier.
  await accepted(a, 'snapshot')
  const first = { ...intake(), phases: ['registration', 'stop'] }, second = { ...intake('fixture-delivery-0002'), phases: ['registration', 'stop'] }
  const attempts = await Promise.all([a.call('retain', first), b.call('retain', second)])
  expect(attempts.filter(attempt => attempt.ok)).toHaveLength(1)
  expect(attempts.find(attempt => !attempt.ok)?.error).toMatch(/Native hook delivery is held:|Hook preparation is waiting:|Error: EEXIST:/)
  const body = attempts[0].ok ? first : second, other = attempts[0].ok ? second : first
  await accepted(a, 'ack', { ...body, phase: 'registration' })
  expect(await b.call('retain', other)).toMatchObject({ ok: false, error: expect.stringContaining('capacity cannot retain terminal outcomes') })
  await accepted(b, 'ack', { ...body, phase: 'stop' })
  const snapshot = await accepted(worker({ outbox: true, maxRecords: 3 }), 'snapshot')
  expect(snapshot.length).toBe(3)
  expect(snapshot.deliveries).toHaveLength(1)
  expect(snapshot.deliveries[0].acknowledgements).toEqual(['registration', 'stop'])
}, 30_000)

it('restores an outbox registration ACK after SIGKILL without acknowledging linked Stop', async () => {
  const a = worker({ outbox: true }), body = { ...intake(), phases: ['registration', 'stop'] }
  await accepted(a, 'retain', body); await accepted(a, 'pause-ack')
  const paused = a.event('paused'), acknowledgement = a.call('ack', { ...body, phase: 'registration' })
  await paused; await a.kill()
  expect(await acknowledgement).toMatchObject({ ok: false })
  const recovered = worker({ outbox: true }), snapshot = await accepted(recovered, 'snapshot')
  expect(snapshot.deliveries[0].acknowledgements).toEqual(['registration'])
  // Confirmation grants no effect claim and consumes no duplicate ACK record.
  await accepted(recovered, 'ack', { ...body, phase: 'registration' })
  expect((await accepted(recovered, 'snapshot')).length).toBe(2)
  await accepted(recovered, 'ack', { ...body, phase: 'stop' })
  expect((await accepted(recovered, 'snapshot')).deliveries[0].acknowledgements).toEqual(['registration', 'stop'])
}, 30_000)

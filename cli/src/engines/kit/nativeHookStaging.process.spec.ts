/** Private OS writers do not share JavaScript reservations or cleanup leases. */
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let bundle: string, root: string, directory: string, script: string
type Reply = { ok: boolean; value?: any; error?: string }
const workers = new Set<ReturnType<typeof worker>>()
beforeAll(() => {
  bundle = realpathSync(mkdtempSync(join(tmpdir(), 'hook-stage-process-bundle-')))
  script = join(bundle, 'stage.mjs')
  buildSync({ stdin: { resolveDir: process.cwd(), sourcefile: 'stage-fixture.ts', contents: `
    import fs from 'node:fs'
    import { join } from 'node:path'
    import { syncBuiltinESMExports } from 'node:module'
    import { createNativeHookStagePool } from ${JSON.stringify(resolve('src/engines/kit/nativeHookStaging.ts'))}
    import { inspectHookFile, runHookPreparation } from ${JSON.stringify(resolve('src/engines/kit/nativeHookFiles.ts'))}
    const [directory] = process.argv.slice(2), dead = new Set(), leases = new Map()
    const pool = createNativeHookStagePool({ root: directory,
      writer: { boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', namespace: 'linux:4:5', pid: process.pid, birth: '12345' },
      verifyWriter: () => {},
      closeWriter: () => {},
      // Only the parent test's observed child exit grants this fixture proof.
      // Production supplies exact kernel boot/PID/birth evidence separately.
      dead: async writer => dead.has(writer.pid) && writer.birth === '12345',
    })
    let next = 0, pause = false, release
    const flush = fs.fsync
    fs.fsync = (fd, done) => {
      if (!pause || !fs.fstatSync(fd).isFile()) { flush(fd, done); return }
      pause = false
      flush(fd, error => { release = () => done(error); process.send({ event: 'paused' }) })
    }
    syncBuiltinESMExports()
    process.on('message', async ({ request, operation, value }) => {
      try {
        let result
        if (operation === 'acquire') {
          const lease = await pool.acquire(), token = ++next
          leases.set(token, lease); result = token
        } else if (operation === 'publish') {
          const lease = leases.get(value.token), target = join(directory, value.name)
          await runHookPreparation([target], attempt => inspectHookFile(target, 0o600).replace(value.text, attempt, true, lease.stage))
        } else if (operation === 'stage') {
          const stage = leases.get(value.token).stage(join(directory, value.name))
          fs.writeFileSync(stage.path, value.text, { mode: 0o600 }); result = stage.path
        } else if (operation === 'close') { await leases.get(value).close()
        } else if (operation === 'dead') { for (const pid of value) dead.add(pid)
        } else if (operation === 'pause') { pause = true
        } else if (operation === 'release') { if (!release) throw Error('No paused flush'); release(); release = undefined
        } else throw Error('Unknown private fixture operation')
        process.send({ request, ok: true, value: result })
      } catch (error) { process.send({ request, ok: false, error: String(error) }) }
    })
    process.send({ event: 'ready' })
  ` }, outfile: script, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
})
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hook-stage-process-')))
  directory = join(root, 'staging'); mkdirSync(directory, { mode: 0o700 })
  mkdirSync(join(root, 'home'), { mode: 0o700 })
})
afterEach(async () => {
  await Promise.all([...workers].map(writer => writer.kill()))
  workers.clear(); rmSync(root, { recursive: true, force: true })
})
afterAll(() => rmSync(bundle, { recursive: true, force: true }))

function worker() {
  const child = fork(script, [directory], { execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'),
      ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), TZ: 'UTC', TMPDIR: '/tmp' },
  })
  let request = 0, stderr = '', closed = false
  const pending = new Map<number, (reply: Reply) => void>(), events = new Map<string, () => void>()
  const ready = new Promise<void>(done => events.set('ready', done))
  child.stderr!.on('data', bytes => { stderr += bytes })
  child.on('message', (message: any) => {
    if (message.event) { events.get(message.event)?.(); events.delete(message.event) }
    else { pending.get(message.request)?.(message); pending.delete(message.request) }
  })
  const exited = new Promise<void>(done => child.once('close', () => {
    closed = true
    for (const settle of pending.values()) settle({ ok: false, error: 'Private writer exited: ' + stderr })
    pending.clear(); done()
  }))
  const value = {
    pid: child.pid!,
    async call(operation: string, value?: unknown): Promise<Reply> {
      await ready
      if (closed) return { ok: false, error: 'Private writer has exited' }
      const id = ++request
      return new Promise(done => {
        const timer = setTimeout(() => { pending.delete(id); child.kill('SIGKILL'); done({ ok: false, error: 'Private writer exceeded its deadline: ' + stderr }) }, 10_000)
        pending.set(id, reply => { clearTimeout(timer); done(reply) })
        child.send({ request: id, operation, value })
      })
    },
    event: (name: string) => new Promise<void>(done => events.set(name, done)),
    async kill() { if (!closed) child.kill('SIGKILL'); await exited },
  }
  workers.add(value); return value
}
async function accepted(writer: ReturnType<typeof worker>, operation: string, value?: unknown) {
  const reply = await writer.call(operation, value)
  expect(reply, reply.error).toMatchObject({ ok: true }); return reply.value
}
async function occupySeven() {
  const owner = worker()
  for (let index = 0; index < 7; index++) await accepted(owner, 'acquire')
  return owner
}

it('grants the last lane to exactly one of two separate OS writers', async () => {
  await occupySeven()
  const first = worker(), second = worker()
  const replies = await Promise.all([first.call('acquire'), second.call('acquire')])
  expect(replies.filter(reply => reply.ok)).toHaveLength(1)
  expect(replies.filter(reply => !reply.ok)).toHaveLength(1)
  expect(replies.find(reply => !reply.ok)!.error).toMatch(/Hook preparation is waiting: native hook staging:|Error: EEXIST:/)
  const winner = replies[0].ok ? first : second, token = replies.find(reply => reply.ok)!.value
  await accepted(winner, 'publish', { token, name: 'receipt', text: 'exclusive bytes' })
  expect(readFileSync(join(directory, 'receipt'), 'utf8')).toBe('exclusive bytes')
  expect(readdirSync(directory, { recursive: true }).filter(name => String(name).endsWith('.tmp'))).toEqual([])
  await accepted(winner, 'close', token)
}, 30_000)

it('recovers a SIGKILL during a real file flush without publishing its interrupted payload', async () => {
  await occupySeven()
  const original = worker(), token = await accepted(original, 'acquire')
  await accepted(original, 'pause')
  const paused = original.event('paused')
  const pending = original.call('publish', { token, name: 'interrupted', text: 'original bytes' })
  await paused
  const abandoned = readdirSync(directory, { recursive: true }).map(String).filter(name => name.endsWith('.tmp'))
  expect(abandoned).toHaveLength(1)
  expect(existsSync(join(directory, 'interrupted'))).toBe(false)
  await original.kill(); expect((await pending).ok).toBe(false)
  const replacement = worker()
  await accepted(replacement, 'dead', [original.pid])
  const next = await accepted(replacement, 'acquire')
  expect(existsSync(join(directory, abandoned[0]))).toBe(false)
  expect(existsSync(join(directory, 'interrupted'))).toBe(false)
  await accepted(replacement, 'publish', { token: next, name: 'recovered', text: 'replacement bytes' })
  expect(readFileSync(join(directory, 'recovered'), 'utf8')).toBe('replacement bytes')
  await accepted(replacement, 'close', next)
}, 30_000)

it('holds a live paused writer and refuses to borrow its lane', async () => {
  await occupySeven()
  const original = worker(), token = await accepted(original, 'acquire')
  const stage = await accepted(original, 'stage', { token, name: 'private', text: 'owned bytes' })
  const competitor = worker(), reply = await competitor.call('acquire')
  expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('another writer') })
  expect(readFileSync(stage, 'utf8')).toBe('owned bytes')
}, 30_000)

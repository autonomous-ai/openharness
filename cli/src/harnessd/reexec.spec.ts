import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HANDOVER_WAIT_MS, PROBE_ANSWER, PROBE_COMMAND, PROBE_TIMEOUT_MS, REEXEC_LIMIT, RESUME_ENV, createReexec, decodeResume, encodeResume, fingerprint,
  readMarker, recoverFailedReexec, removeMarker, runProbe, sha256File, writeMarker, type HandOverDeps, type ProbeResult, type ReexecDeps,
} from './reexec.js'
import type { ReexecOutcome, ResumeState } from './supervisor.js'

const state = (over: Partial<ResumeState> = {}): ResumeState => ({
  restarts: 2, lastExit: 'code 75', lastExitReason: 'update', update: 'pending', claimed: true, reexecs: 0, unproven: 0, ...over,
})

describe('which bundle', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-reexec-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is told by the sha256 of its bytes, or null when it cannot be read', () => {
    const file = join(dir, 'cli.js')
    writeFileSync(file, 'one')
    const one = fingerprint(file)
    expect(one).toBe(createHash('sha256').update('one').digest('hex'))
    writeFileSync(file, 'two')
    expect(fingerprint(file)).not.toBe(one)
    expect(fingerprint(join(dir, 'none.js'))).toBeNull()
    expect(fingerprint(dir)).toBeNull()
  })

  it('reads it a piece at a time, to the same sha256 as all its bytes at once, empty or not', () => {
    // A bundle is megabytes: more than one piece, and a last piece that is not whole.
    const file = join(dir, 'cli.js')
    const bytes = randomBytes(3 * 64 * 1024 + 123)
    writeFileSync(file, bytes)
    expect(sha256File(file)).toBe(createHash('sha256').update(bytes).digest('hex'))
    writeFileSync(file, '')
    expect(sha256File(file)).toBe(createHash('sha256').update('').digest('hex'))
  })
})

describe('the state a master hands on', () => {
  it('reads back what was written', () => {
    expect(decodeResume(encodeResume(state()))).toEqual(state())
    expect(decodeResume(encodeResume(state({ lastExit: null, lastExitReason: null, update: null, claimed: false })))).toEqual(state({ lastExit: null, lastExitReason: null, update: null, claimed: false }))
  })

  it('is none when absent, and refused when it is not one this code can read', () => {
    expect(decodeResume(undefined)).toBeNull()
    expect(decodeResume('{not json')).toBeNull()
    for (const wrong of [
      { restarts: -1 }, { restarts: 1.5 }, { lastExit: 3 }, { lastExitReason: 'bored' }, { update: 'probation' }, { claimed: 'yes' },
      { reexecs: -1 }, { reexecs: '1' }, { unproven: 0.5 }, { unproven: null },
    ]) expect(decodeResume(JSON.stringify({ ...state(), ...wrong })), JSON.stringify(wrong)).toBeNull()
  })

  it('hands on who handed over, and reads nothing it does not know as a handover', () => {
    const handed = state({ claimed: true, handover: { from: 4242, token: 'tok' } })
    expect(decodeResume(encodeResume(handed))).toEqual(handed)
    expect(decodeResume(JSON.stringify({ ...state(), handover: { from: 'x', token: 'tok' } }))).toBeNull()
    expect(decodeResume(JSON.stringify({ ...state(), handover: { from: 1, token: '' } }))).toBeNull()
    expect(decodeResume(JSON.stringify({ ...state(), handover: null }))).toBeNull()
    expect(decodeResume(JSON.stringify({ ...state(), handover: { from: 0, token: 'tok' } }))).toBeNull()
    expect(decodeResume(JSON.stringify({ ...state(), handover: { from: 1, token: 7 } }))).toBeNull()
  })
})

describe('the marker', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-marker-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is written whole, read back, and removed', () => {
    const file = join(dir, 'harnessd-reexec.json')
    expect(readMarker(file)).toBeNull()
    writeMarker(file, { pid: 42, from: 'a', to: 'b', at: 1 })
    expect(readMarker(file)).toEqual({ pid: 42, from: 'a', to: 'b', at: 1 })
    writeMarker(file, { pid: 42, from: null, to: 'b', at: 1 })
    expect(readMarker(file)).toEqual({ pid: 42, from: null, to: 'b', at: 1 })
    removeMarker(file)
    removeMarker(file)
    expect(readMarker(file)).toBeNull()
  })

  it('is no marker when it is not one', () => {
    const file = join(dir, 'harnessd-reexec.json')
    for (const wrong of [{ pid: 'x', to: 'b', at: 1, from: null }, { pid: 1, to: 2, at: 1, from: null }, { pid: 1, to: 'b', at: 'now', from: null }, { pid: 1, to: 'b', at: 1, from: 3 }]) {
      writeFileSync(file, JSON.stringify(wrong))
      expect(readMarker(file), JSON.stringify(wrong)).toBeNull()
    }
  })

  it('reads a marker\'s handover token, and refuses one that is not text', () => {
    const file = join(dir, 'harnessd-reexec.json')
    writeMarker(file, { pid: 1, from: null, to: 'b', at: 2, handover: 'tok' })
    expect(readMarker(file)).toEqual({ pid: 1, from: null, to: 'b', at: 2, handover: 'tok' })
    writeFileSync(file, JSON.stringify({ pid: 1, from: null, to: 'b', at: 2, handover: 7 }))
    expect(readMarker(file)).toBeNull()
  })

  it('leaves no temporary file behind when it cannot be written', () => {
    // Something that is not a marker where it would go: the rename fails, as a write on a full disk does.
    const file = join(dir, 'harnessd-reexec.json')
    mkdirSync(join(file, 'in-the-way'), { recursive: true })
    expect(() => writeMarker(file, { pid: 42, from: 'a', to: 'b', at: 1 })).toThrow()
    expect(readdirSync(dir)).toEqual(['harnessd-reexec.json'])
    // Nor does it fail over a temporary file it cannot clear.
    mkdirSync(join(dir, 'harnessd-reexec.json.43.tmp', 'in-the-way'), { recursive: true })
    expect(() => writeMarker(file, { pid: 43, from: 'a', to: 'b', at: 1 })).toThrow()
  })

  it('is removed even when something odd sits where it was, without throwing', () => {
    const odd = join(dir, 'harnessd-reexec.json')
    mkdirSync(odd)
    expect(() => removeMarker(odd)).not.toThrow()
  })
})

describe('a re-execution that never came up', () => {
  const recover = (over: Partial<Parameters<typeof recoverFailedReexec>[0]> = {}) => {
    const calls: string[] = []
    const result = recoverFailedReexec({
      marker: { pid: 7, from: 'old', to: 'new', at: 1 }, pid: 99, alive: () => false, current: () => 'new',
      restoreUpdate: () => calls.push('restore'), removeMarker: () => calls.push('remove'), log: (line) => calls.push(line), ...over,
    })
    return { result, calls }
  }

  it('is rolled back when the process that re-executed is gone and its bundle is still on disk', () => {
    expect(recover()).toEqual({ result: true, calls: ['remove', 'restore', '[harnessd] the master that re-executed on the new bundle (pid 7) never brought a core up — rolled back to the previous bundle'] })
  })

  it('is let be when there is none, when it is this process\'s own, when its process lives, or when the bundle moved on', () => {
    expect(recover({ marker: null })).toEqual({ result: false, calls: [] })
    expect(recover({ pid: 7 })).toEqual({ result: false, calls: [] })
    expect(recover({ alive: () => true })).toEqual({ result: false, calls: [] })
    expect(recover({ current: () => 'newer' })).toEqual({ result: false, calls: ['remove'] })
  })
})

describe('the probe', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-probe-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const script = (body: string) => {
    const file = join(dir, 'bundle.cjs')
    writeFileSync(file, body)
    return file
  }

  it('passes a bundle whose master answers, and says why one that does not fails', async () => {
    const ok = await runProbe(process.execPath, [script(`console.log('loading'); console.log(${JSON.stringify(PROBE_ANSWER)} + ' · protocol 2')`), PROBE_COMMAND], process.env).result
    expect(ok).toEqual({ ok: true, detail: `${PROBE_ANSWER} · protocol 2` })
    // A bundle from before probes: its usage on stdout, the reason on stderr, which is what is said.
    expect(await runProbe(process.execPath, [script(`console.error('Unknown command: ' + process.argv[2]); console.log('Usage: harness …\\n  harness --help'); process.exit(1)`), PROBE_COMMAND], process.env).result)
      .toEqual({ ok: false, detail: `Unknown command: ${PROBE_COMMAND}` })
    // An answer on stderr is no answer.
    expect(await runProbe(process.execPath, [script(`console.error(${JSON.stringify(PROBE_ANSWER)})`), PROBE_COMMAND], process.env).result)
      .toEqual({ ok: false, detail: PROBE_ANSWER })
    expect(await runProbe(process.execPath, [script('console.log("something else")'), PROBE_COMMAND], process.env).result)
      .toEqual({ ok: false, detail: 'something else' })
    expect(await runProbe(process.execPath, [script('process.exit(4)')], process.env).result).toEqual({ ok: false, detail: 'exit 4' })
    expect(await runProbe(process.execPath, [script('process.kill(process.pid, "SIGKILL")')], process.env).result).toEqual({ ok: false, detail: 'signal SIGKILL' })
    expect(await runProbe(join(dir, 'no-node'), [], process.env).result).toEqual({ ok: false, detail: expect.stringContaining('ENOENT') })
  })

  it('gives up on one that does not answer in time, and can be abandoned', async () => {
    const hung = script('setInterval(() => {}, 1000)')
    expect(await runProbe(process.execPath, [hung], process.env, 300).result).toEqual({ ok: false, detail: 'no answer within 300 ms' })
    const running = runProbe(process.execPath, [hung], process.env)
    running.cancel()
    expect(await running.result).toEqual({ ok: false, detail: 'signal SIGKILL' })
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
  })

  it('survives a child that has no output to read and cannot be killed', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: () => { throw new Error('ESRCH') } }) as unknown as ChildProcess
    vi.useFakeTimers()
    try {
      const running = runProbe('node', [], {}, 100, () => child)
      running.cancel()
      vi.advanceTimersByTime(100)
      expect(await running.result).toEqual({ ok: false, detail: 'no answer within 100 ms' })
      child.emit('close', 0, null)
    } finally { vi.useRealTimers() }
  })
})

describe('re-executing', () => {
  let calls: string[]
  let probes: Array<{ args: string[]; env: NodeJS.ProcessEnv; settle: (result: ProbeResult) => void; cancelled: boolean }>
  let outcomes: ReexecOutcome[]
  let stopping: boolean
  let onDisk: string | null
  let execs: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }>
  let stopped: Array<() => void>

  const make = (over: Partial<ReexecDeps> = {}) => createReexec({
    own: 'old', current: () => onDisk, nodePath: '/opt/node', execArgv: ['--flag'], scriptPath: '/opt/cli.js',
    env: { KEEP: '1' }, pid: 4242,
    execve: (file, args, env) => { execs.push({ file, args, env }) },
    exists: () => true,
    probe: (args, env) => {
      let settle!: (result: ProbeResult) => void
      const entry = { args, env, settle: (result: ProbeResult) => settle(result), cancelled: false }
      probes.push(entry)
      return { result: new Promise<ProbeResult>((resolve) => { settle = resolve }), cancel: () => { entry.cancelled = true } }
    },
    stopChildren: (done) => { calls.push('stop children'); stopped.push(done) },
    startChildren: () => calls.push('start children'),
    writeMarker: (marker) => calls.push(`marker ${JSON.stringify(marker)}`),
    removeMarker: () => calls.push('remove marker'),
    stopping: () => stopping,
    now: () => 1_000,
    log: (line) => calls.push(line),
    ...over,
  })
  const settle = async (result: ProbeResult) => { probes.at(-1)!.settle(result); await new Promise((done) => setImmediate(done)) }

  beforeEach(() => {
    calls = []
    probes = []
    outcomes = []
    stopping = false
    onDisk = 'new'
    execs = []
    stopped = []
  })

  it('does nothing when the bundle on disk is this master\'s own, or cannot be read', () => {
    const { reexec } = make()
    onDisk = 'old'
    reexec(state(), (outcome) => outcomes.push(outcome))
    onDisk = null
    reexec(state(), (outcome) => outcomes.push(outcome))
    expect(outcomes).toEqual(['same', 'same'])
    expect(calls).toEqual([])
  })

  it('keeps this master where this Node cannot re-execute, and says so once', () => {
    const { reexec } = make({ execve: null })
    reexec(state(), (outcome) => outcomes.push(outcome))
    reexec(state(), (outcome) => outcomes.push(outcome))
    expect(outcomes).toEqual(['kept', 'kept'])
    expect(calls).toEqual(['[harnessd] the bundle on disk is newer than this master, but this Node cannot re-execute a process: the master keeps its code until it restarts'])
  })

  it('keeps this master after re-executing again and again without a core coming up', () => {
    const { reexec } = make()
    reexec(state({ unproven: REEXEC_LIMIT }), (outcome) => outcomes.push(outcome))
    expect(outcomes).toEqual(['kept'])
    expect(calls).toEqual([`[harnessd] this master re-executed ${REEXEC_LIMIT} times without a core coming up — keeping its code; something keeps rewriting the bundle`])
  })

  it('stops its children, probes the bundle, leaves its marker and replaces itself, handing its state on', async () => {
    const { reexec } = make()
    reexec(state({ reexecs: 2, unproven: 1 }), (outcome) => outcomes.push(outcome))
    expect(calls).toEqual(['[harnessd] the bundle on disk is not this master\'s code — re-executing on it', 'stop children'])
    expect(probes).toEqual([])
    stopped[0]()
    expect(probes[0].args).toEqual(['--flag', '/opt/cli.js', PROBE_COMMAND])
    expect(decodeResume(probes[0].env[RESUME_ENV])).toEqual(state({ reexecs: 3, unproven: 2 }))
    expect(probes[0].env.KEEP).toBe('1')
    await settle({ ok: true, detail: PROBE_ANSWER })
    expect(calls.at(-1)).toBe(`marker ${JSON.stringify({ pid: 4242, from: 'old', to: 'new', at: 1_000 })}`)
    expect(execs).toEqual([{ file: '/opt/node', args: ['/opt/node', '--flag', '/opt/cli.js', '__harnessd'], env: probes[0].env }])
    expect(outcomes).toEqual([])
  })

  it('is replacing this master from the moment it stops its children until it carries on as itself', async () => {
    const { reexec, replacing } = make()
    onDisk = 'old'
    reexec(state(), (outcome) => outcomes.push(outcome))
    expect(replacing()).toBe(false)
    onDisk = 'new'
    reexec(state(), (outcome) => outcomes.push(outcome))
    expect(replacing()).toBe(true)
    stopped[0]()
    expect(replacing()).toBe(true)
    await settle({ ok: false, detail: 'no' })
    expect(replacing()).toBe(false)
    expect(outcomes).toEqual(['same', 'refused'])
  })

  it('carries on as itself when the probe fails or the exec does, with its children back', async () => {
    const refused = make()
    refused.reexec(state(), (outcome) => outcomes.push(outcome))
    stopped[0]()
    await settle({ ok: false, detail: 'Unknown command: __harnessd-probe' })
    expect(outcomes).toEqual(['refused'])
    expect(calls.slice(-2)).toEqual(['[harnessd] the new bundle\'s master did not answer its probe (Unknown command: __harnessd-probe) — keeping this master', 'start children'])
    expect(execs).toEqual([])

    calls = []
    const failing = make({ execve: () => { throw new Error('E2BIG') } })
    failing.reexec(state(), (outcome) => outcomes.push(outcome))
    stopped[1]()
    await settle({ ok: true, detail: PROBE_ANSWER })
    expect(outcomes).toEqual(['refused', 'kept'])
    expect(calls.slice(-3)).toEqual(['remove marker', '[harnessd] could not re-execute this master (E2BIG) — keeping it', 'start children'])

    const odd = make({ execve: () => { throw 'odd' } })
    odd.reexec(state(), (outcome) => outcomes.push(outcome))
    stopped[2]()
    await settle({ ok: true, detail: PROBE_ANSWER })
    expect(calls).toContain('[harnessd] could not re-execute this master (odd) — keeping it')
  })

  it('never execs onto a node binary or a bundle that is not there: that exec could not be caught', async () => {
    // On Node 22.23 an exec of a node binary that is gone aborts the master (exit 134), and one onto a bundle
    // that is gone ends it in the new image: neither reaches the catch, and the next master rolls back.
    for (const [gone, said] of [['/opt/node', '/opt/node'], ['/opt/cli.js', '/opt/cli.js']]) {
      calls = []
      const missing = make({ exists: (path) => path !== gone })
      missing.reexec(state(), (outcome) => outcomes.push(outcome))
      stopped.at(-1)!()
      await settle({ ok: true, detail: PROBE_ANSWER })
      expect(execs).toEqual([])
      expect(calls.slice(-3)).toEqual(['remove marker', `[harnessd] ${said} is not there to re-execute on — keeping this master`, 'start children'])
    }
    expect(outcomes).toEqual(['kept', 'kept'])
  })

  it('carries on as itself, and does not end, when its marker cannot be written (a full disk)', async () => {
    const full = make({ writeMarker: () => { throw new Error('ENOSPC: no space left on device, write') } })
    full.reexec(state(), (outcome) => outcomes.push(outcome))
    stopped[0]()
    await settle({ ok: true, detail: PROBE_ANSWER })
    expect(execs).toEqual([])
    expect(outcomes).toEqual(['kept'])
    expect(calls.slice(-2)).toEqual(['[harnessd] could not leave the re-execution marker (ENOSPC: no space left on device, write) — keeping this master', 'start children'])

    const odd = make({ writeMarker: () => { throw 'read-only' } })
    odd.reexec(state(), (outcome) => outcomes.push(outcome))
    stopped[1]()
    await settle({ ok: true, detail: PROBE_ANSWER })
    expect(outcomes).toEqual(['kept', 'kept'])
    expect(calls).toContain('[harnessd] could not leave the re-execution marker (read-only) — keeping this master')
  })

  it('does nothing more once the master is stopping, at any step, and abandons its probe', async () => {
    const first = make()
    first.reexec(state(), (outcome) => outcomes.push(outcome))
    stopping = true
    stopped[0]()
    expect(probes).toEqual([])

    stopping = false
    const second = make()
    second.reexec(state(), (outcome) => outcomes.push(outcome))
    stopped[1]()
    stopping = true
    second.cancel()
    expect(probes[0].cancelled).toBe(true)
    await settle({ ok: true, detail: PROBE_ANSWER })
    expect(execs).toEqual([])

    stopping = false
    const third = make()
    third.reexec(state(), (outcome) => outcomes.push(outcome))
    stopped[2]()
    stopping = true
    await settle({ ok: false, detail: 'no' })
    expect(outcomes).toEqual([])
    expect(calls).not.toContain('start children')
    third.cancel()
    make().cancel()
  })
})

describe('handing over, where there is no exec (Windows)', () => {
  let calls: string[]
  let outcomes: ReexecOutcome[]
  let stopping: boolean
  let launched: NodeJS.ProcessEnv[]
  const clock = { now: 1_000 }
  const make = (over: Partial<HandOverDeps> = {}, more: Partial<ReexecDeps> = {}) => createReexec({
    own: 'old', current: () => 'new', nodePath: '/opt/node', execArgv: [], scriptPath: 'C:\\h\\cli\\0.5.1\\cli.js', env: { KEEP: '1' }, pid: 4242,
    execve: null, exists: () => true,
    probe: () => ({ result: Promise.resolve({ ok: true, detail: PROBE_ANSWER }), cancel: () => {} }),
    stopChildren: (done) => { calls.push('stop children'); done() },
    startChildren: () => calls.push('start children'),
    writeMarker: (marker) => calls.push(`marker ${JSON.stringify(marker)}`),
    removeMarker: () => calls.push('remove marker'),
    stopping: () => stopping, now: () => clock.now, log: (line) => calls.push(line),
    handOver: {
      lock: async () => { calls.push('lock'); return () => calls.push('unlock') },
      launch: async (env) => { launched.push(env); return null },
      readPid: () => 4242, alive: (pid) => pid === 5151,
      sleep: async (ms) => { clock.now += ms },
      token: () => 'tok',
      leave: () => calls.push('leave'),
      ...over,
    },
    ...more,
  })
  const run = async (reexec: ReturnType<typeof make>['reexec']) => {
    reexec(state(), (outcome) => outcomes.push(outcome))
    for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done))
  }
  const REEXECUTING = '[harnessd] the bundle on disk is not this master\'s code — re-executing on it'

  beforeEach(() => { calls = []; outcomes = []; stopping = false; launched = []; clock.now = 1_000 })

  it('starts the new master through the launcher with its state, and leaves once it holds the pid file', async () => {
    let pid = 4242
    await run(make({ readPid: () => pid, sleep: async (ms) => { clock.now += ms; pid = 5151 } }).reexec)
    expect(decodeResume(launched[0]![RESUME_ENV])).toEqual({ ...state(), reexecs: 1, unproven: 1, claimed: true, handover: { from: 4242, token: 'tok' } })
    expect(launched[0]!.KEEP).toBe('1')
    // ./AGENTS.md rule 11: the master's own environment passed through, and the resume state; nothing else harnessd's.
    expect(Object.keys(launched[0]!).sort()).toEqual(['KEEP', RESUME_ENV].sort())
    expect(calls).toEqual([
      REEXECUTING, 'stop children', 'lock', `marker ${JSON.stringify({ pid: 4242, from: 'old', to: 'new', at: 1_000, handover: 'tok' })}`,
      '[harnessd] handed over to the new master (pid 5151) — leaving', 'unlock', 'leave',
    ])
    expect(outcomes).toEqual([])
  })

  it('lets go of the spawn lock as it leaves, once the new master holds the pid file, and not before', async () => {
    // The replacement never takes the lock again: the old master's release, after the pid file names the new one, is
    // what frees it. Released earlier, a `harness stop` could land on a master on its way out.
    let pid = 4242
    const pidWhenReleased: Array<number | null> = []
    await run(make({
      readPid: () => pid,
      sleep: async (ms) => { clock.now += ms; if (clock.now >= 2_000) pid = 5151 },
      lock: async () => { calls.push('lock'); return () => { pidWhenReleased.push(pid); calls.push('unlock') } },
    }).reexec)
    expect(pidWhenReleased).toEqual([5151])
    expect(calls.slice(-3)).toEqual(['[harnessd] handed over to the new master (pid 5151) — leaving', 'unlock', 'leave'])
    expect(calls.filter((call) => call === 'unlock')).toHaveLength(1)
  })

  it('keeps this master when the new one does not take over in time, taking its marker back first', async () => {
    // Nothing in the pid file, then a pid that runs nothing, then this master's own: none is a successor.
    await run(make({ readPid: () => (clock.now < 10_000 ? null : clock.now < 20_000 ? 6000 : 4242) }).reexec)
    expect(calls.slice(-4)).toEqual(['remove marker', 'unlock', `[harnessd] the new master did not take over within ${HANDOVER_WAIT_MS} ms — keeping this master`, 'start children'])
    expect(outcomes).toEqual(['kept'])
    expect(clock.now - 1_000).toBeGreaterThanOrEqual(HANDOVER_WAIT_MS)
  })

  it('leaves after all when the new one claimed the pid file as it gave up', async () => {
    await run(make({ readPid: () => (calls.includes('remove marker') ? 5151 : 4242) }).reexec)
    expect(calls.slice(-3)).toEqual(['remove marker', 'unlock', 'leave'])
    expect(outcomes).toEqual([])
  })

  it('keeps this master when the spawn lock is busy, the marker will not write, the bundle is gone or the launcher fails', async () => {
    await run(make({ lock: async () => null }).reexec)
    expect(calls.slice(-2)).toEqual(['[harnessd] the daemon spawn lock is busy — keeping this master', 'start children'])
    calls = []
    await run(make({}, { writeMarker: () => { throw new Error('ENOSPC') } }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] could not leave the re-execution marker (ENOSPC) — keeping this master', 'start children'])
    calls = []
    // A throw that is not an Error still names itself in the log (the catch's String(error) branch).
    await run(make({}, { writeMarker: () => { throw 'EROFS' } }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] could not leave the re-execution marker (EROFS) — keeping this master', 'start children'])
    calls = []
    await run(make({}, { exists: () => false }).reexec)
    expect(calls.slice(-4)).toEqual(['remove marker', 'unlock', '[harnessd] C:\\h\\cli\\0.5.1\\cli.js is not there to hand over to — keeping this master', 'start children'])
    calls = []
    await run(make({ launch: async () => 'exit 3' }).reexec)
    expect(calls.slice(-4)).toEqual(['remove marker', 'unlock', '[harnessd] could not start the new master (exit 3) — keeping this master', 'start children'])
    expect(outcomes).toEqual(['kept', 'kept', 'kept', 'kept', 'kept'])
  })

  it('does no more once the master is stopping', async () => {
    await run(make({ lock: async () => { stopping = true; return () => calls.push('unlock') } }).reexec)
    expect(calls.slice(-1)).toEqual(['unlock'])
    calls = []
    await run(make({ lock: async () => { stopping = true; return null } }).reexec)
    expect(calls.slice(-1)).toEqual(['stop children'])
    calls = []
    stopping = false
    await run(make({ launch: async () => { stopping = true; return null } }).reexec)
    expect(calls.slice(-2)).toEqual(['remove marker', 'unlock'])
    calls = []
    stopping = false
    await run(make({ sleep: async () => { stopping = true } }).reexec)
    expect(calls.includes('leave') || calls.includes('start children')).toBe(false)
    expect(outcomes).toEqual([])
  })
})

import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HANDOVER_CUTOFF_MARGIN_MS, HANDOVER_CUTOFF_MS, HANDOVER_POLL_MS, HANDOVER_STOP_BUDGET_MS, HANDOVER_WAIT_MS, PROBE_ANSWER, PROBE_COMMAND, PROBE_HANDOVER, PROBE_TIMEOUT_MS, REEXEC_LIMIT, RESUME_ENV, createReexec, decodeResume, encodeResume, fingerprint,
  mayClaimPidFile, readHandoverClaimant, readMarker, recoverFailedReexec, removeMarker, runProbe, sha256File, sweepHandovers, takeBackHandover, takeHandover,
  writeMarker, type HandOverDeps, type ProbeResult, type ReexecDeps,
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
    // One that takes a handover (Windows) says so.
    expect(await runProbe(process.execPath, [script(`console.log(${JSON.stringify(`${PROBE_ANSWER} · protocol 6 · ${PROBE_HANDOVER}`)})`), PROBE_COMMAND], process.env).result)
      .toEqual({ ok: true, detail: `${PROBE_ANSWER} · protocol 6 · ${PROBE_HANDOVER}`, handover: true })
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

describe('a handover\'s decision, where there is no exec (Windows)', () => {
  let dir: string
  let file: string
  const at = 1_000
  const inTime = () => at + 5
  const mark = (token: string): void => writeMarker(file, { pid: 4242, from: 'a', to: 'b', at, handover: token })
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'harnessd-handover-')); file = join(dir, 'harnessd-reexec.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is the replacement\'s once it took the handover, which says who took it and then cannot be taken back', () => {
    mark('tok-1')
    expect(readHandoverClaimant(file, 'tok-1')).toBeNull()
    expect(takeHandover(file, 'tok-1', 5151, inTime)).toBe(true)
    expect(readHandoverClaimant(file, 'tok-1')).toBe(5151)
    expect(takeBackHandover(file, 'tok-1', 4242)).toBe(false)
    expect(takeHandover(file, 'tok-1', 6161, inTime)).toBe(false)
    expect(readHandoverClaimant(file, 'tok-1')).toBe(5151)
    // The marker is read and removed as before: the decision is not its, and no temporary file is left.
    expect(readMarker(file)).toEqual({ pid: 4242, from: 'a', to: 'b', at, handover: 'tok-1' })
    removeMarker(file)
    expect(readdirSync(dir)).toEqual(['harnessd-reexec.json.tok-1.handover'])
  })

  it('is the master\'s once it took the handover back, and then the replacement cannot take it', () => {
    mark('tok-1')
    expect(takeBackHandover(file, 'tok-1', 4242)).toBe(true)
    expect(takeHandover(file, 'tok-1', 5151, inTime)).toBe(false)
    expect(readHandoverClaimant(file, 'tok-1')).toBeNull()
    expect(takeBackHandover(file, 'tok-1', 4242)).toBe(false)
    expect(readdirSync(dir).sort()).toEqual(['harnessd-reexec.json', 'harnessd-reexec.json.tok-1.handover'])
  })

  it('is taken only while the marker names it, and not after its cutoff', () => {
    // From the real clock when none is given: a marker this old is long past its cutoff.
    mark('tok-1')
    expect(takeHandover(file, 'tok-1', 5151)).toBe(false)
    expect(takeHandover(file, 'tok-1', 5151, () => at + HANDOVER_CUTOFF_MS + 1)).toBe(false)
    expect(takeHandover(file, 'tok-2', 5151, inTime)).toBe(false)
    removeMarker(file)
    expect(takeHandover(file, 'tok-1', 5151, inTime)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
    mark('tok-1')
    expect(takeHandover(file, 'tok-1', 5151, () => at + HANDOVER_CUTOFF_MS)).toBe(true)
  })

  it('lets the replacement claim the pid file only while the marker names its handover, and not after the cutoff', () => {
    mark('tok-1')
    expect(mayClaimPidFile(file, 'tok-1', inTime)).toBe(true)
    expect(mayClaimPidFile(file, 'tok-1', () => at + HANDOVER_CUTOFF_MS)).toBe(true)
    expect(mayClaimPidFile(file, 'tok-1', () => at + HANDOVER_CUTOFF_MS + 1)).toBe(false)
    expect(mayClaimPidFile(file, 'tok-1')).toBe(false)
    expect(mayClaimPidFile(file, 'tok-2', inTime)).toBe(false)
    removeMarker(file)
    expect(mayClaimPidFile(file, 'tok-1', inTime)).toBe(false)
  })

  it('is refused once taken when the marker went or moved on meanwhile, the decision left naming the replacement', () => {
    // The marker another handover's by the time the link is made: asked again, refused.
    mark('tok-1')
    let first = true
    expect(takeHandover(file, 'tok-1', 5151, () => { if (first) mark('tok-2'); first = false; return inTime() })).toBe(false)
    expect(readHandoverClaimant(file, 'tok-1')).toBe(5151)
    // Its cutoff passed by then.
    mark('tok-3')
    let calls = 0
    expect(takeHandover(file, 'tok-3', 5151, () => (calls++ === 0 ? inTime() : at + HANDOVER_CUTOFF_MS + 1))).toBe(false)
    expect(readHandoverClaimant(file, 'tok-3')).toBe(5151)
    expect(takeBackHandover(file, 'tok-3', 4242)).toBe(false)
  })

  it('is one per handover: one taken back is not another\'s', () => {
    expect(takeBackHandover(file, 'tok-1', 4242)).toBe(true)
    mark('tok-2')
    expect(takeHandover(file, 'tok-2', 5151, inTime)).toBe(true)
    expect(readHandoverClaimant(file, 'tok-2')).toBe(5151)
  })

  it('is swept as a later master starts, all but the handovers it is told to keep', () => {
    for (const token of ['tok-1', 'tok-2', 'tok-3']) takeBackHandover(file, token, 4242)
    mark('tok-2')
    // Not a decision: the marker's own temporary file, a decision's half-made one, another file, a name no token makes.
    for (const name of ['harnessd-reexec.json.4242.tmp', 'harnessd-reexec.json.tok-1.handover.4242.tmp', 'adapter.pid', 'harnessd-reexec.json.a.b.handover']) {
      writeFileSync(join(dir, name), '')
    }
    sweepHandovers(file, ['tok-2', undefined])
    expect(readdirSync(dir).sort()).toEqual([
      'adapter.pid', 'harnessd-reexec.json', 'harnessd-reexec.json.4242.tmp', 'harnessd-reexec.json.a.b.handover',
      'harnessd-reexec.json.tok-1.handover.4242.tmp', 'harnessd-reexec.json.tok-2.handover',
    ])
    // A folder that cannot be read: nothing to sweep.
    sweepHandovers(join(dir, 'missing', 'harnessd-reexec.json'), [])
  })

  it('reads no claimant that is not a pid', () => {
    for (const wrong of ['{', 'null', '{"pid":0}', '{"pid":"5151"}', '{"abandoned":4242}']) {
      writeFileSync(`${file}.tok-1.handover`, wrong)
      expect(readHandoverClaimant(file, 'tok-1'), wrong).toBeNull()
    }
  })

  it('refuses a token that could name a file elsewhere, and says when it cannot tell who has it', () => {
    mark('../x')
    expect(takeHandover(file, '../x', 5151, inTime)).toBe(false)
    expect(readHandoverClaimant(file, '../x')).toBeNull()
    expect(() => takeBackHandover(file, '../x', 4242)).toThrow('not a handover token')
    // Nothing decided, and nothing that says so: not known, so neither true nor false, and nothing left behind.
    mark('tok-1')
    mkdirSync(join(`${file}.tok-1.handover.4242.tmp`, 'in-the-way'), { recursive: true })
    expect(() => takeBackHandover(file, 'tok-1', 4242)).toThrow()
    mkdirSync(join(`${file}.tok-1.handover.5151.tmp`, 'in-the-way'), { recursive: true })
    expect(takeHandover(file, 'tok-1', 5151, inTime)).toBe(false)
    expect(readHandoverClaimant(file, 'tok-1')).toBeNull()
  })
})

describe('handing over, where there is no exec (Windows)', () => {
  let calls: string[]
  let outcomes: ReexecOutcome[]
  let stopping: boolean
  let launched: NodeJS.ProcessEnv[]
  /** The pid file, the handover's decision and who runs: what the master sees of the replacement. */
  let world: { pidFile: number | null; taken: boolean; claimant: number | null; running: Set<number> }
  const clock = { now: 1_000 }
  /** The replacement taking the handover and the pid file (./reexec.ts `takeHandover`). */
  const takes = (pid = 5151): void => { world.taken = true; world.claimant = pid; world.pidFile = pid }
  const make = (over: Partial<HandOverDeps> = {}, more: Partial<ReexecDeps> = {}) => createReexec({
    own: 'old', current: () => 'new', nodePath: '/opt/node', execArgv: [], scriptPath: 'C:\\h\\cli\\0.5.1\\cli.js', env: { KEEP: '1' }, pid: 4242,
    execve: null, exists: () => true,
    probe: () => ({ result: Promise.resolve({ ok: true, detail: PROBE_ANSWER, handover: true }), cancel: () => {} }),
    stopChildren: (done) => { calls.push('stop children'); done() },
    startChildren: () => calls.push('start children'),
    writeMarker: (marker) => calls.push(`marker ${JSON.stringify(marker)}`),
    removeMarker: () => calls.push('remove marker'),
    stopping: () => stopping, now: () => clock.now, log: (line) => calls.push(line),
    handOver: {
      lock: async () => { calls.push('lock'); return () => calls.push('unlock') },
      claim: () => { calls.push('claim'); world.pidFile = 4242 },
      launch: async (env) => { launched.push(env); return null },
      readPid: () => world.pidFile, alive: (pid) => world.running.has(pid),
      claimant: () => world.claimant,
      takeBack: () => { if (world.taken) return false; calls.push('take back'); return true },
      sleep: async (ms) => { clock.now += ms },
      token: () => 'tok',
      leave: () => calls.push('leave'),
      ...over,
    },
    ...more,
  })
  // Every wait is on the fake clock: enough turns of the event loop for the longest (past the cutoff, polled).
  const run = async (reexec: ReturnType<typeof make>['reexec']) => {
    reexec(state(), (outcome) => outcomes.push(outcome))
    for (let i = 0; i < 2_000; i++) await new Promise((done) => setImmediate(done))
  }
  const REEXECUTING = '[harnessd] the bundle on disk is not this master\'s code — re-executing on it'
  const KEPT_LATE = `[harnessd] the new master did not take over within ${HANDOVER_WAIT_MS} ms — keeping this master`
  const NO_CLAIM = '[harnessd] the new master took over but never claimed the pid file — keeping this master'
  const BOUND = 1_000 + HANDOVER_CUTOFF_MS + HANDOVER_CUTOFF_MARGIN_MS
  const HANDED = '[harnessd] handed over to the new master (pid 5151) — leaving'
  const NOT_YET = '[harnessd] could not take the handover back yet (EBUSY) — trying again'
  const EXIT_3 = '[harnessd] could not start the new master (exit 3) — keeping this master'
  const busy = (times = Infinity) => { let n = 0; return () => { if (n++ < times) throw new Error('EBUSY'); calls.push('take back'); return true } }

  beforeEach(() => {
    calls = []; outcomes = []; stopping = false; launched = []; clock.now = 1_000
    world = { pidFile: 999, taken: false, claimant: null, running: new Set([4242, 5151]) }
  })

  it('claims the pid file, starts the new master through the launcher with its state, and leaves once it took over', async () => {
    await run(make({ sleep: async (ms) => { clock.now += ms; takes() } }).reexec)
    expect(decodeResume(launched[0]![RESUME_ENV])).toEqual({ ...state(), reexecs: 1, unproven: 1, claimed: true, handover: { from: 4242, token: 'tok' } })
    expect(launched[0]!.KEEP).toBe('1')
    // ./AGENTS.md rule 11: the master's own environment passed through, and the resume state; nothing else harnessd's.
    expect(Object.keys(launched[0]!).sort()).toEqual(['KEEP', RESUME_ENV].sort())
    expect(calls).toEqual([
      REEXECUTING, 'stop children', 'lock', 'claim', `marker ${JSON.stringify({ pid: 4242, from: 'old', to: 'new', at: 1_000, handover: 'tok' })}`,
      HANDED, 'unlock', 'leave',
    ])
    expect(outcomes).toEqual([])
  })

  it('lets go of the spawn lock as it leaves, once the new master holds the pid file, and not before', async () => {
    // The replacement never takes the lock again: the old master's release, after the pid file names the new one, is
    // what frees it. Released earlier, a `harness stop` could land on a master on its way out.
    const pidWhenReleased: Array<number | null> = []
    await run(make({
      sleep: async (ms) => { clock.now += ms; if (clock.now >= 2_000) takes() },
      lock: async () => { calls.push('lock'); return () => { pidWhenReleased.push(world.pidFile); calls.push('unlock') } },
    }).reexec)
    expect(pidWhenReleased).toEqual([5151])
    expect(calls.slice(-3)).toEqual([HANDED, 'unlock', 'leave'])
    expect(calls.filter((call) => call === 'unlock')).toHaveLength(1)
  })

  it('takes no pid in the pid file for the new master but the one that took the handover', async () => {
    // A pid file this master never claimed holds a crash's pid, which Windows may have given to another process; and
    // whatever writes it without taking the handover (a master from another one) is not this one's replacement either.
    await run(make({ sleep: async (ms) => { clock.now += ms; world.pidFile = 7777; world.running.add(7777) } }).reexec)
    expect(calls.slice(-6)).toEqual(['take back', 'remove marker', 'claim', 'unlock', KEPT_LATE, 'start children'])
    expect(outcomes).toEqual(['kept'])
  })

  it('leaves, once the new one took the handover as it gave up, only when the pid file names it, holding the lock till then', async () => {
    const pidWhenReleased: Array<number | null> = []
    const late = 1_000 + HANDOVER_WAIT_MS + 5_000
    await run(make({
      takeBack: () => { world.taken = true; world.claimant = 5151; return false },
      sleep: async (ms) => { clock.now += ms; if (clock.now >= late) world.pidFile = 5151 },
      lock: async () => { calls.push('lock'); return () => { pidWhenReleased.push(world.pidFile); calls.push('unlock') } },
    }).reexec)
    expect(pidWhenReleased).toEqual([5151])
    expect(clock.now).toBeGreaterThanOrEqual(late)
    expect(calls.slice(-3)).toEqual([HANDED, 'unlock', 'leave'])
    expect(outcomes).toEqual([])
  })

  it('stays at the bound, the new one having taken the handover, only on a pid file that names no other process that runs', async () => {
    const tookIt = () => { world.taken = true; world.claimant = 5151; return false }
    // The pid file still this master's, the new one alive: it can claim the file no more (`mayClaimPidFile`).
    await run(make({ takeBack: tookIt }).reexec)
    expect(calls.slice(-4)).toEqual(['remove marker', 'unlock', NO_CLAIM, 'start children'])
    expect(clock.now).toBeGreaterThanOrEqual(BOUND)
    calls = []
    // A pid that runs nothing, or none: the file back.
    for (const pidFile of [7777, null]) {
      await run(make({ takeBack: tookIt, sleep: async (ms) => { clock.now += ms; if (world.taken) world.pidFile = pidFile } }).reexec)
      expect(calls.slice(-5)).toEqual(['remove marker', 'claim', 'unlock', NO_CLAIM, 'start children'])
      calls = []
    }
    expect(calls).toEqual([])
    expect(outcomes).toEqual(['kept', 'kept', 'kept'])
  })

  it('leaves at the bound, the new one having taken the handover, on a pid file it cannot read or that names another process that runs', async () => {
    const tookIt = () => { world.taken = true; world.claimant = 5151; return false }
    // Who took it never read, the pid file the new one's.
    await run(make({ claimant: () => { throw new Error('EBUSY') }, sleep: async (ms) => { clock.now += ms; takes() } }).reexec)
    expect(calls.slice(-3)).toEqual(['[harnessd] the new master took over, and the pid file names pid 5151 — leaving', 'unlock', 'leave'])
    expect(clock.now).toBeGreaterThanOrEqual(BOUND)
    calls = []; world = { pidFile: 999, taken: false, claimant: null, running: new Set([4242, 5151]) }
    // Whether it runs never known.
    await run(make({ alive: () => { throw new Error('EPERM') }, sleep: async (ms) => { clock.now += ms; takes() } }).reexec)
    expect(calls.slice(-3)).toEqual(['[harnessd] the new master took over, and the pid file names pid 5151 — leaving', 'unlock', 'leave'])
    calls = []; world = { pidFile: 999, taken: false, claimant: null, running: new Set([4242, 5151, 7777]) }
    // Another process that runs.
    await run(make({ takeBack: tookIt, sleep: async (ms) => { clock.now += ms; if (world.taken) world.pidFile = 7777 } }).reexec)
    expect(calls.slice(-3)).toEqual(['[harnessd] the new master took over, and the pid file names pid 7777 — leaving', 'unlock', 'leave'])
    calls = []
    // A pid file that cannot be read.
    await run(make({ takeBack: tookIt, readPid: () => { throw new Error('EBUSY') } }).reexec)
    expect(calls.slice(-3)).toEqual(['[harnessd] the new master took over, and the pid file cannot be read (EBUSY) — leaving', 'unlock', 'leave'])
    expect(outcomes).toEqual([])
  })

  it('counts its bounds from the handover, not from when the re-execution began', async () => {
    // Stopping the children and the probe took ten seconds.
    await run(make({ takeBack: () => { world.taken = true; world.claimant = 5151; return false } }, {
      stopChildren: (done) => { calls.push('stop children'); clock.now += 10_000; done() },
    }).reexec)
    expect(calls).toContain(`marker ${JSON.stringify({ pid: 4242, from: 'old', to: 'new', at: 11_000, handover: 'tok' })}`)
    expect(calls.slice(-2)).toEqual([NO_CLAIM, 'start children'])
    expect(clock.now).toBeGreaterThanOrEqual(BOUND + 10_000)
  })

  it('keeps this master when the new one does not take over in time, taking the handover and its marker back first', async () => {
    world.running.delete(5151)
    await run(make().reexec)
    expect(calls.slice(-5)).toEqual(['take back', 'remove marker', 'unlock', KEPT_LATE, 'start children'])
    expect(outcomes).toEqual(['kept'])
    expect(clock.now - 1_000).toBeGreaterThanOrEqual(HANDOVER_WAIT_MS)
  })

  it('keeps this master, with the pid file back, when the new one took over and then ended', async () => {
    await run(make({ sleep: async (ms) => { clock.now += ms; takes(); world.running.delete(5151) } }).reexec)
    expect(calls.slice(-5)).toEqual(['remove marker', 'claim', 'unlock', '[harnessd] the new master (pid 5151) took over and then ended — keeping this master', 'start children'])
    expect(world.pidFile).toBe(4242)
    expect(outcomes).toEqual(['kept'])
  })

  it('keeps this master when the spawn lock is busy or will not be taken, the bundle is gone, the token is not one, or the pid file or marker will not write', async () => {
    await run(make({ lock: async () => null }).reexec)
    expect(calls.slice(-2)).toEqual(['[harnessd] the daemon spawn lock is busy — keeping this master', 'start children'])
    calls = []
    // lib/daemonSpawnLock.ts's acquireSpawnLock rejects when it is busy (`SpawnLockBusyError`).
    await run(make({ lock: () => Promise.reject(new Error('held by pid 77')) }).reexec)
    expect(calls.slice(-2)).toEqual(['[harnessd] could not take the daemon spawn lock (held by pid 77) — keeping this master', 'start children'])
    calls = []
    await run(make({}, { exists: () => false }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] C:\\h\\cli\\0.5.1\\cli.js is not there to hand over to — keeping this master', 'start children'])
    calls = []
    await run(make({ token: () => '../tok' }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] the handover token "../tok" is not one a file can be named by — keeping this master', 'start children'])
    calls = []
    await run(make({ claim: () => { throw new Error('EACCES') } }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] could not claim the pid file (EACCES) — keeping this master', 'start children'])
    calls = []
    await run(make({}, { writeMarker: () => { throw new Error('ENOSPC') } }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] could not leave the re-execution marker (ENOSPC) — keeping this master', 'start children'])
    calls = []
    // A throw that is not an Error still names itself in the log (the String(error) branch).
    await run(make({}, { writeMarker: () => { throw 'EROFS' } }).reexec)
    expect(calls.slice(-3)).toEqual(['unlock', '[harnessd] could not leave the re-execution marker (EROFS) — keeping this master', 'start children'])
    expect(launched).toEqual([])
    expect(outcomes).toEqual(['kept', 'kept', 'kept', 'kept', 'kept', 'kept', 'kept'])
  })

  it('keeps this master, with the pid file back, when the launcher fails or the handover does', async () => {
    await run(make({ launch: async () => { world.pidFile = 999; return 'exit 3' } }).reexec)
    expect(calls.slice(-6)).toEqual(['take back', 'remove marker', 'claim', 'unlock', EXIT_3, 'start children'])
    calls = []
    await run(make({ launch: () => Promise.reject(new Error('spawn EACCES')) }).reexec)
    expect(calls.slice(-5)).toEqual(['take back', 'remove marker', 'unlock', '[harnessd] the handover failed (spawn EACCES) — keeping this master', 'start children'])
    calls = []
    await run(make({ sleep: () => Promise.reject(new Error('gone')) }).reexec)
    expect(calls.slice(-5)).toEqual(['take back', 'remove marker', 'unlock', '[harnessd] the handover failed (gone) — keeping this master', 'start children'])
    expect(outcomes).toEqual(['kept', 'kept', 'kept'])
  })

  it('tries again when it cannot tell whether it took the handover back, and stays only once it did', async () => {
    await run(make({ launch: async () => 'exit 3', takeBack: busy(2) }).reexec)
    expect(calls.slice(-6)).toEqual([NOT_YET, 'take back', 'remove marker', 'unlock', EXIT_3, 'start children'])
    expect(calls.filter((call) => call === NOT_YET)).toHaveLength(1)
    expect(clock.now - 1_000).toBe(2 * HANDOVER_POLL_MS)
    expect(outcomes).toEqual(['kept'])
  })

  it('tries again when it cannot tell, and goes the new master\'s way once it learns the new one took it', async () => {
    // Told by the take back...
    let n = 0
    await run(make({
      launch: async () => 'exit 3',
      takeBack: () => { if (n++ < 1) throw new Error('EBUSY'); world.taken = true; world.claimant = 5151; return false },
      sleep: async (ms) => { clock.now += ms; if (world.taken) world.pidFile = 5151 },
    }).reexec)
    expect(calls.slice(-4)).toEqual([NOT_YET, HANDED, 'unlock', 'leave'])
    calls = []; outcomes = []; clock.now = 1_000; world = { pidFile: 999, taken: false, claimant: null, running: new Set([4242, 5151]) }
    // ...or by the new master proven meanwhile: the handover never taken back.
    await run(make({ launch: async () => 'exit 3', takeBack: busy(), sleep: async (ms) => { clock.now += ms; takes() } }).reexec)
    expect(calls.slice(-4)).toEqual([NOT_YET, HANDED, 'unlock', 'leave'])
    expect(outcomes).toEqual([])
  })

  it('stays, its children back, once no new master can take over any more, when it never learned whose the handover is', async () => {
    await run(make({ launch: async () => 'exit 3', takeBack: busy() }).reexec)
    expect(calls.slice(-5)).toEqual([NOT_YET, 'remove marker', 'unlock',
      '[harnessd] could not start the new master (exit 3), and no new master can take over any more — keeping this master', 'start children'])
    expect(clock.now).toBeGreaterThanOrEqual(1_000 + HANDOVER_CUTOFF_MS + HANDOVER_CUTOFF_MARGIN_MS)
    expect(outcomes).toEqual(['kept'])
    calls = []; outcomes = []; clock.now = 1_000
    // A sleep that fails is only a pause cut short: still bounded by the clock.
    await run(make({ takeBack: busy(), sleep: async (ms) => { clock.now += ms; throw new Error('gone') } }).reexec)
    expect(calls.slice(-2)).toEqual(['[harnessd] the handover failed (gone), and no new master can take over any more — keeping this master', 'start children'])
  })

  it('stays when it cannot claim the pid file back, saying so', async () => {
    await run(make({ launch: async () => 'exit 3', readPid: () => { throw new Error('EBUSY') } }).reexec)
    expect(calls.slice(-5)).toEqual(['remove marker', '[harnessd] could not claim the pid file back (EBUSY)', 'unlock', EXIT_3, 'start children'])
    expect(outcomes).toEqual(['kept'])
  })

  it('reads who took the handover once more past the cutoff, as it removes its marker, and goes the new one\'s way', async () => {
    await run(make({ launch: async () => 'exit 3', takeBack: busy() }, { removeMarker: () => { calls.push('remove marker'); takes() } }).reexec)
    expect(calls.slice(-4)).toEqual(['remove marker', HANDED, 'unlock', 'leave'])
    expect(outcomes).toEqual([])
  })

  it('does no more once the master is stopping, and lets no replacement take over then unless it already has', async () => {
    await run(make({ lock: async () => { stopping = true; return () => calls.push('unlock') } }).reexec)
    expect(calls.slice(-1)).toEqual(['unlock'])
    calls = []
    await run(make({ lock: async () => { stopping = true; return null } }).reexec)
    expect(calls.slice(-1)).toEqual(['stop children'])
    calls = []
    stopping = false
    await run(make({ launch: async () => { stopping = true; return null } }).reexec)
    expect(calls.slice(-3)).toEqual(['take back', 'remove marker', 'unlock'])
    calls = []
    stopping = false
    await run(make({ launch: () => { stopping = true; return Promise.reject(new Error('killed')) } }).reexec)
    expect(calls.slice(-3)).toEqual(['take back', 'remove marker', 'unlock'])
    calls = []
    stopping = false
    await run(make({ sleep: async () => { stopping = true } }).reexec)
    expect(calls.slice(-3)).toEqual(['take back', 'remove marker', 'unlock'])
    calls = []
    stopping = false
    // Taken already: the replacement is the master, and its marker is not this one's to remove.
    await run(make({ sleep: async () => { stopping = true; world.taken = true } }).reexec)
    expect(calls.slice(-1)).toEqual(['unlock'])
    expect(calls).not.toContain('remove marker')
    expect(calls.includes('leave') || calls.includes('start children')).toBe(false)
    expect(outcomes).toEqual([])
  })

  it('stops, as it waits for whose the handover is, without leaving a replacement a handover to take', async () => {
    // Not known while it waits to learn, then taken back.
    await run(make({ launch: async () => 'exit 3', takeBack: busy(1), sleep: async (ms) => { clock.now += ms; stopping = true } }).reexec)
    expect(calls.slice(-4)).toEqual([NOT_YET, 'take back', 'remove marker', 'unlock'])
    calls = []; stopping = false; clock.now = 1_000
    // Not known within the stop's budget: the marker goes all the same, and with it the handover.
    await run(make({ launch: async () => { stopping = true; return null }, takeBack: busy() }).reexec)
    expect(calls.slice(-3)).toEqual([NOT_YET, 'remove marker', 'unlock'])
    expect(clock.now - 1_000).toBeGreaterThanOrEqual(HANDOVER_STOP_BUDGET_MS)
    calls = []; stopping = false; clock.now = 1_000; world.taken = true; world.claimant = 5151
    // Taken, and waiting for the pid file to name it: the new master's, so nothing to take back or remove.
    await run(make({ sleep: async (ms) => { clock.now += ms; if (clock.now > 1_000 + HANDOVER_WAIT_MS + 1_000) stopping = true } }).reexec)
    expect(calls.slice(-1)).toEqual(['unlock'])
    expect(calls).not.toContain('remove marker')
    expect(calls.includes('leave') || calls.includes('start children')).toBe(false)
    expect(outcomes).toEqual([])
  })

  it('keeps this master, handing over to nothing, when the new bundle\'s master does not say it takes a handover', async () => {
    // A bundle from before handovers would be handed the state, never take the handover, and run beside this master.
    await run(make({}, { probe: () => ({ result: Promise.resolve({ ok: true, detail: PROBE_ANSWER }), cancel: () => {} }) }).reexec)
    expect(calls).toEqual([REEXECUTING, 'stop children', '[harnessd] the new bundle\'s master cannot take a handover — keeping this master', 'start children'])
    expect(launched).toEqual([])
    expect(outcomes).toEqual(['kept'])
  })

  it('says, once the handover under way is decided, whether the new master has the pid file and the marker', async () => {
    // None under way: at once.
    let none: boolean | null = null
    make().settled((handed) => { none = handed })
    expect(none).toBe(false)
    const decided = async (launch: () => Promise<string | null>, over: Partial<HandOverDeps> = {}): Promise<boolean | null> => {
      world = { pidFile: 999, taken: false, claimant: null, running: new Set([4242, 5151]) }
      stopping = false
      let answer: boolean | null = null
      const reexec = make({
        ...over,
        launch: async () => {
          reexec.settled((handed) => { answer = handed })
          // Not before it is decided.
          calls.push(`answered ${answer}`)
          return launch()
        },
      })
      await run(reexec.reexec)
      return answer
    }
    // Left for the new master; stopped once the new one took it, as it waited or past the wait.
    expect(await decided(async () => null, { sleep: async (ms) => { clock.now += ms; takes() } })).toBe(true)
    expect(await decided(async () => { world.taken = true; world.claimant = 5151; stopping = true; return null })).toBe(true)
    expect(await decided(async () => 'exit 3', {
      takeBack: () => { world.taken = true; world.claimant = 5151; return false }, sleep: async (ms) => { clock.now += ms; stopping = true },
    })).toBe(true)
    // Stopped and taken back, or kept: this master's.
    expect(await decided(async () => { stopping = true; return null })).toBe(false)
    expect(await decided(async () => 'exit 3')).toBe(false)
    expect(calls.filter((call) => call.startsWith('answered'))).toEqual(Array(5).fill('answered null'))
    expect(outcomes).toEqual(['kept'])
  })

  it('gives a replacement that read the marker in time twenty seconds past the cutoff before this master settles', () => {
    // A stall of more than five seconds between its last check and its pid file write came after the master had settled.
    expect(HANDOVER_CUTOFF_MARGIN_MS).toBe(20_000)
    expect(HANDOVER_CUTOFF_MS).toBe(2 * HANDOVER_WAIT_MS)
  })
})

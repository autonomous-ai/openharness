// The devices' pipe as clients find it (listenerPipe.ts): its record, its token and the proof that the recorded process
// runs. The pipe is a path `<tmp>/harness-<32 hex>` here, which isPipePath takes off Windows.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureDaemonToken, newPipePath, readDaemonToken } from '../lib/windows/pipeAuth.js'
import {
  createDevicesProof, createRecordProof, DEVICES_RECORD_FILE, DEVICES_TOKEN_FILE, devicesPipe, devicesRecordPath,
  PROOF_MAX_AGE_MS, readDevicesRecord, removeDevicesRecord, writeDevicesRecord,
} from './listenerPipe.js'

// Renames refused before the real one: Windows refuses a rename over a file another process holds open, for a moment.
const fault = vi.hoisted(() => ({ refusedRenames: 0 }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (fault.refusedRenames > 0) {
      fault.refusedRenames--
      throw Object.assign(new Error('EPERM: fixture'), { code: 'EPERM' })
    }
    return actual.renameSync(...args)
  } }
})

// The table the default proof reads on Windows: here pid 4242 started an hour ago.
const table = vi.hoisted(() => ({ reads: 0 }))
vi.mock('../lib/windows/processTable.js', () => ({
  windowsProcessRows: async () => {
    table.reads++
    return [{ pid: 4242, executable: 'node.exe', startMarker: `w:${(BigInt(Date.now() - 3_600_000) + 11_644_473_600_000n) * 10_000n}` }]
  },
}))

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  fault.refusedRenames = 0
  table.reads = 0
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** [run] with this process as Windows: the writer's retry reads process.platform. */
function asWindows<T>(run: () => T): T {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
}

/** A data folder the token checks take: owner-only, under /tmp's short path. */
function dataDir(): string {
  const dir = mkdtempSync('/tmp/hn-devpipe-')
  dirs.push(dir)
  return dir
}
const pipeIn = (dir: string) => join(dir, `harness-${randomBytes(16).toString('hex')}`)
const filetime = (ms: number) => `w:${(BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n}`
const recordMtime = (dir: string) => statSync(devicesRecordPath(dir)).mtimeMs

describe('the devices record', () => {
  it('reads back what was written, from an owner-only file, with no temp file left', () => {
    const dir = dataDir()
    const pipe = pipeIn(dir)
    writeDevicesRecord(dir, { pipe, pid: 4242 })
    expect(DEVICES_RECORD_FILE).toBe('devices.json')
    expect(devicesRecordPath(dir)).toBe(join(dir, 'devices.json'))
    expect(readFileSync(devicesRecordPath(dir), 'utf8')).toBe(`{"pipe":${JSON.stringify(pipe)},"pid":4242}\n`)
    expect(statSync(devicesRecordPath(dir)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['devices.json'])
    expect(readDevicesRecord(dir)).toEqual({ pipe, pid: 4242 })
  })

  it('on Windows a rename refused for a moment is tried again, and the record ends up in place', () => {
    const dir = dataDir()
    const pipe = pipeIn(dir)
    writeDevicesRecord(dir, { pipe: pipeIn(dir), pid: 4242 })
    fault.refusedRenames = 1
    asWindows(() => writeDevicesRecord(dir, { pipe, pid: 4343 }))
    expect(fault.refusedRenames).toBe(0)
    expect(readDevicesRecord(dir)).toEqual({ pipe, pid: 4343 })
    expect(statSync(devicesRecordPath(dir)).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['devices.json'])
  })

  it('reads nothing from a missing, malformed or oversized record', () => {
    const dir = dataDir()
    const pipe = pipeIn(dir)
    expect(readDevicesRecord(dir)).toBeNull()
    const read = (text: string) => {
      writeFileSync(devicesRecordPath(dir), text)
      return readDevicesRecord(dir)
    }
    expect(read('not json')).toBeNull()
    expect(read('null')).toBeNull()
    expect(read('{}')).toBeNull()
    for (const pid of [0, 1.5, '7']) expect(read(JSON.stringify({ pipe, pid }))).toBeNull()
    expect(read(JSON.stringify({ pipe, pid: 42 }).padEnd(5_000, ' '))).toBeNull()
    expect(read(JSON.stringify({ pipe, pid: 42 }))).toEqual({ pipe, pid: 42 })
  })

  it('on Windows takes only a local pipe named harness-<id>', () => {
    const dir = dataDir()
    const id = randomBytes(16).toString('hex')
    const read = (pipe: string) => {
      writeFileSync(devicesRecordPath(dir), JSON.stringify({ pipe, pid: 42 }))
      return readDevicesRecord(dir, 'win32')
    }
    expect(read(`\\\\server\\pipe\\harness-${id}`)).toBeNull()
    expect(read(`C:\\Users\\me\\.harness\\harness-${id}`)).toBeNull()
    expect(read(pipeIn(dir))).toBeNull()
    const local = newPipePath()
    expect(read(local)).toEqual({ pipe: local, pid: 42 })
  })

  it('is removed only while it names the pipe given, and removing nothing does not throw', () => {
    const dir = dataDir()
    const pipe = pipeIn(dir)
    expect(() => removeDevicesRecord(dir, pipe)).not.toThrow()
    writeDevicesRecord(dir, { pipe: pipeIn(dir), pid: 4242 })
    removeDevicesRecord(dir, pipe)
    expect(readDevicesRecord(dir)).not.toBeNull()
    writeDevicesRecord(dir, { pipe, pid: 4242 })
    removeDevicesRecord(dir, pipe)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('devicesPipe', () => {
  const alive = () => createDevicesProof({ liveness: { alive: () => true } })

  it('is the recorded pipe with the devices token', async () => {
    const dir = dataDir()
    const pipe = pipeIn(dir)
    expect(DEVICES_TOKEN_FILE).toBe('devices-token')
    ensureDaemonToken(dir, DEVICES_TOKEN_FILE)
    writeDevicesRecord(dir, { pipe, pid: process.pid })
    expect(await devicesPipe(dir, alive())).toEqual({ pipe, token: readDaemonToken(dir, 'devices-token') })
  })

  it('is nothing with no record, with only the daemon token, or with the recorded process gone', async () => {
    const noRecord = dataDir()
    ensureDaemonToken(noRecord, DEVICES_TOKEN_FILE)
    expect(await devicesPipe(noRecord, alive())).toBeNull()

    const daemonTokenOnly = dataDir()
    ensureDaemonToken(daemonTokenOnly)
    writeDevicesRecord(daemonTokenOnly, { pipe: pipeIn(daemonTokenOnly), pid: process.pid })
    expect(await devicesPipe(daemonTokenOnly, alive())).toBeNull()

    const dir = dataDir()
    ensureDaemonToken(dir, DEVICES_TOKEN_FILE)
    writeDevicesRecord(dir, { pipe: pipeIn(dir), pid: 4242 })
    expect(await devicesPipe(dir, createDevicesProof({ liveness: { alive: () => false } }))).toBeNull()
  })

  // The devices are this account's: a pid that answers EPERM is another account's process, one that took the pid since
  // the devices exited and could have made a pipe of its name.
  it("is nothing when the recorded pid is another account's process, and no table is read", async () => {
    const dir = dataDir()
    ensureDaemonToken(dir, DEVICES_TOKEN_FILE)
    writeDevicesRecord(dir, { pipe: pipeIn(dir), pid: 4242 })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EPERM: fixture'), { code: 'EPERM' })
    })
    expect(await devicesPipe(dir, createDevicesProof())).toBeNull()
    expect(kill).toHaveBeenCalledWith(4242, 0)
    expect(table.reads).toBe(0)
  })

  // Review Focus 1: the devices process crashed and its pid was given to a process that started after the record.
  it('is nothing when the recorded pid runs a process that started after the record was written', async () => {
    const dir = dataDir()
    ensureDaemonToken(dir, DEVICES_TOKEN_FILE)
    writeDevicesRecord(dir, { pipe: pipeIn(dir), pid: 4242 })
    const rows = async () => [{ pid: 4242, executable: 'other.exe', startMarker: filetime(recordMtime(dir) + 60_000) }]
    expect(await devicesPipe(dir, createDevicesProof({ liveness: { alive: () => true, rows } }))).toBeNull()
  })
})

describe('the pid proof', () => {
  /** A folder with a token and a record of [pid]; a table where pids 4242 and 4343 started an hour before. */
  function setup(pid = 4242) {
    const dir = dataDir()
    const pipe = pipeIn(dir)
    const token = ensureDaemonToken(dir, DEVICES_TOKEN_FILE)
    writeDevicesRecord(dir, { pipe, pid })
    const started = filetime(Date.now() - 3_600_000)
    const counts = { rows: 0, alive: 0 }
    let running = true
    let clock = 1_000_000
    const proof = createDevicesProof({
      liveness: {
        alive: () => { counts.alive++; return running },
        rows: async () => {
          counts.rows++
          return [4242, 4343].map((rowPid) => ({ pid: rowPid, executable: 'node.exe', startMarker: started }))
        },
      },
      now: () => clock,
    })
    return {
      dir, pipe, token, proof, counts,
      setRunning: (value: boolean) => { running = value },
      advance: (ms: number) => { clock += ms },
    }
  }

  it('reads the table once for many calls', async () => {
    const { dir, pipe, token, proof, counts, advance } = setup()
    expect(PROOF_MAX_AGE_MS).toBe(60_000)
    for (let call = 0; call < 10; call++) {
      expect(await proof.pipe(dir)).toEqual({ pipe, token })
      advance(5_000)
    }
    expect(counts.rows).toBe(1)
    expect(counts.alive).toBe(10)
  })

  it('proves again after a minute', async () => {
    const { dir, pipe, token, proof, counts, advance } = setup()
    await proof.pipe(dir)
    advance(PROOF_MAX_AGE_MS - 1)
    await proof.pipe(dir)
    expect(counts.rows).toBe(1)
    advance(1)
    expect(await proof.pipe(dir)).toEqual({ pipe, token })
    expect(counts.rows).toBe(2)
  })

  it('proves again when the record changes', async () => {
    const { dir, proof, counts } = setup()
    await proof.pipe(dir)
    expect(counts.rows).toBe(1)

    const pipe = pipeIn(dir)
    writeDevicesRecord(dir, { pipe, pid: 4242 })
    expect((await proof.pipe(dir))?.pipe).toBe(pipe)
    expect(counts.rows).toBe(2)

    writeDevicesRecord(dir, { pipe, pid: 4343 })
    expect((await proof.pipe(dir))?.pipe).toBe(pipe)
    expect(counts.rows).toBe(3)

    await proof.pipe(dir)
    expect(counts.rows).toBe(3)
    const later = new Date(recordMtime(dir) + 10_000)
    utimesSync(devicesRecordPath(dir), later, later)
    expect((await proof.pipe(dir))?.pipe).toBe(pipe)
    expect(counts.rows).toBe(4)
  })

  it('proves again after forget', async () => {
    const { dir, proof, counts } = setup()
    await proof.pipe(dir)
    proof.forget(dir)
    await proof.pipe(dir)
    expect(counts.rows).toBe(2)
  })

  it('drops the proof when the pid is gone', async () => {
    const { dir, pipe, token, proof, counts, setRunning } = setup()
    await proof.pipe(dir)
    setRunning(false)
    expect(await proof.pipe(dir)).toBeNull()
    expect(counts.rows).toBe(1)
    setRunning(true)
    expect(await proof.pipe(dir)).toEqual({ pipe, token })
    expect(counts.rows).toBe(2)
  })

  it('holds a proof per data folder', async () => {
    const first = setup()
    const second = dataDir()
    const secondPipe = pipeIn(second)
    const secondToken = ensureDaemonToken(second, DEVICES_TOKEN_FILE)
    writeDevicesRecord(second, { pipe: secondPipe, pid: 4343 })
    const { proof, counts } = first

    await proof.pipe(first.dir)
    expect(await proof.pipe(second)).toEqual({ pipe: secondPipe, token: secondToken })
    await proof.pipe(first.dir)
    await proof.pipe(second)
    expect(counts.rows).toBe(2)

    proof.forget(first.dir)
    await proof.pipe(second)
    expect(counts.rows).toBe(2)
    expect(await proof.pipe(first.dir)).toEqual({ pipe: first.pipe, token: first.token })
    expect(counts.rows).toBe(3)
  })

  // As recordedProcessDead reads it: no table is no proof of death, and no proof of life to hold either.
  it('dials when the table cannot be read, and reads it again on the next call', async () => {
    const dir = dataDir()
    const pipe = pipeIn(dir)
    const token = ensureDaemonToken(dir, DEVICES_TOKEN_FILE)
    writeDevicesRecord(dir, { pipe, pid: 4242 })
    let reads = 0
    const proof = createDevicesProof({
      liveness: { alive: () => true, rows: async () => { reads++; throw new Error('no table') } },
      now: () => 1_000_000,
    })
    expect(await proof.pipe(dir)).toEqual({ pipe, token })
    expect(await proof.pipe(dir)).toEqual({ pipe, token })
    expect(reads).toBe(2)
  })

  // The daemon's record is another file in the same folder (deviceClaude/inbox.ts): neither proof stands for the other.
  it('a record proof is held per record file', async () => {
    const dir = dataDir()
    const token = ensureDaemonToken(dir, DEVICES_TOKEN_FILE)
    const started = filetime(Date.now() - 3_600_000)
    let rows = 0
    let clock = 1_000_000
    const proof = createRecordProof({
      liveness: { alive: () => true, rows: async () => { rows++; return [{ pid: 4242, executable: 'node.exe', startMarker: started }] } },
      now: () => clock,
    })
    const records = ['first.json', 'second.json'].map((name) => {
      const file = join(dir, name)
      const pipe = pipeIn(dir)
      writeFileSync(file, JSON.stringify({ pipe, pid: 4242 }))
      return { file, pipe, read: () => ({ record: { pipe, pid: 4242 }, mtimeMs: statSync(file).mtimeMs, token }) }
    })
    for (const { file, pipe, read } of records) expect(await proof.pipe(file, read)).toEqual({ pipe, token })
    expect(rows).toBe(2)
    clock += PROOF_MAX_AGE_MS - 1_000
    for (const { file, pipe, read } of records) expect(await proof.pipe(file, read)).toEqual({ pipe, token })
    expect(rows).toBe(2)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecDone } from './patientExec.js'
import { checkPidRuntime } from './deleteAgentFallback.js'
import { processRows, readProcessRows, setProcessTableSource, type ProcessRow } from './processTable.js'

const requests = vi.hoisted(() => [] as { args: readonly string[]; done: ExecDone; settled: boolean }[])
const ticks = vi.hoisted(() => vi.fn<(pid: number) => number | null>(() => null))
vi.mock('./patientExec.js', () => ({ patientExec: () => (_file: string, args: readonly string[], _options: unknown, done: ExecDone) => {
  requests.push({ args, done, settled: false })
} }))
vi.mock('./processLiveness.js', async original => ({ ...await original<object>(), processStartTicks: ticks }))
// Synthetic identities cannot collide with this worker in a Linux PID namespace.
const PID = 0x7fff_fffe, OTHER = 0x7fff_fffd, START = 'Fri Nov 20 12:00:00 2026'
const COMMAND = '/fixture/long-name/engine', CUT = COMMAND.slice(0, 16)
const row = (pid: number, start = START, executable = CUT, args = 'engine --fixture') =>
  `${pid} 1 ${executable} ${start} ${args}`
const identity = { pid: PID, executable: CUT, startMarker: START }
const expected = (pid = PID): ProcessRow => ({ ...identity, pid, parentPid: 1, args: 'engine --fixture',
  ...(process.platform === 'darwin' ? { commandPath: COMMAND } : {}) })
const table = (pids = [PID, OTHER, process.pid]) => pids.map(pid => row(pid)).join('\n') + '\n'
const paths = (pids = [PID, OTHER, process.pid]) => pids.map(pid => `${pid} ${START} ${COMMAND}`).join('\n') + '\n'
async function finish(rows = table(), commands = paths(), error: Error | null = null, from = 0) {
  await Promise.resolve()
  for (const request of requests.slice(from)) {
    if (request.settled) continue
    request.settled = true
    request.done(error as Parameters<ExecDone>[0], request.args.at(-1) === 'pid=,lstart=,comm=' ? commands : rows, '')
  }
}
beforeEach(() => {
  requests.length = 0; ticks.mockReset().mockReturnValue(null); setProcessTableSource(null)
  // The synthetic table owns these identities; do not ask the host kernel about fixture PIDs.
  vi.spyOn(process, 'kill').mockReturnValue(true)
})
afterEach(async () => { await finish(); await Promise.resolve(); setProcessTableSource(null); vi.restoreAllMocks() })

describe('a known process read', () => {
  it('keeps the full native read and returns only the requested PID with command recovery', async () => {
    const pending = readProcessRows('darwin', PID)
    await finish(table([PID, process.pid]), paths([PID, process.pid]))
    expect(await pending).toEqual([{ ...expected(), commandPath: COMMAND }])
    expect(requests.map(request => request.args)).toEqual([
      ['-axo', 'pid=,ppid=,comm=,lstart=,args='],
      ['-axo', 'pid=,lstart=,comm='],
    ])
  })

  it.each(['darwin', 'linux'] as const)('an absent target needs the live reader witness on %s', async os => {
    const pending = readProcessRows(os, PID)
    await finish(table([process.pid]), paths([process.pid]))
    expect(await pending).toEqual([])
  })

  it.each(['empty', 'only target', 'malformed reader', 'error'] as const)('refuses %s as proof of a completed read', async kind => {
    const pending = readProcessRows('darwin', PID)
    const text = kind === 'empty' ? '' : kind === 'malformed reader' ? row(PID) + `\n${process.pid} unreadable\n` : table([PID])
    await finish(text, paths(), kind === 'error' ? new Error('fixture read failed') : null)
    expect(await pending).toBeNull()
  })

  it('a malformed target row alongside the reader is unknown, not an exited process', async () => {
    const pending = checkPidRuntime({ engine: 'hermes', processIdentity: identity })
    await finish(`${PID} incomplete row\n` + row(process.pid) + '\n')
    expect(await pending).toMatchObject({ state: 'unknown' })
  })

  it('keeps the original identity when the supplementary command-path read fails', async () => {
    const pending = readProcessRows('darwin', PID)
    for (const request of requests) {
      request.settled = true
      const supplementary = request.args.at(-1) === 'pid=,lstart=,comm='
      request.done(supplementary ? new Error('fixture supplementary failure') : null, supplementary ? '' : table([PID, process.pid]), '')
    }
    expect(await pending).toEqual([{ ...identity, parentPid: 1, args: 'engine --fixture' }])
  })

  it.each([0, -1, 1.5, NaN, Infinity])('refuses invalid PID %s without starting a read', async pid => {
    const pending = processRows(pid)
    await finish()
    expect(await pending).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it.each([0x8000_0000, 0xffff_ffff, Number.MAX_SAFE_INTEGER])('resolves an absent persisted PID %s without narrowing Registry identity', async pid => {
    const pending = checkPidRuntime({ engine: 'hermes', processIdentity: { ...identity, pid } })
    await finish(table([process.pid]), paths([process.pid]))
    expect(await pending).toMatchObject({ state: 'gone' })
    const direct = readProcessRows('darwin', pid)
    await finish(table([process.pid]), paths([process.pid]))
    expect(await direct).toEqual([])
    expect(requests.every(request => request.args[0] === '-axo')).toBe(true)
  })

  it('does not duplicate the reader PID when it is the requested process', async () => {
    const pending = readProcessRows('darwin', process.pid)
    await finish(table([process.pid]), paths([process.pid]))
    expect(await pending).toEqual([{ ...expected(process.pid), commandPath: COMMAND }])
    expect(requests.every(request => request.args[0] === '-axo')).toBe(true)
  })

  it('the actual lifetime check uses the selected read and keeps PID reuse protection', async () => {
    for (const [start, executable, state] of [[START, CUT, 'alive'], ['Fri Nov 20 12:01:00 2026', CUT, 'gone'], [START, 'another-engine', 'gone']] as const) {
      const offset = requests.length
      const pending = checkPidRuntime({ engine: 'hermes', processIdentity: identity })
      await finish(row(PID, start, executable) + '\n' + row(process.pid) + '\n', paths(), null, offset)
      expect(await pending).toMatchObject({ state })
      expect(requests.slice(offset).every(request => request.args[0] === '-axo')).toBe(true)
    }
  })

  it('does not accept a changed start or executable from the command-path read', async () => {
    for (const command of [`${PID} Fri Nov 20 12:01:00 2026 ${COMMAND}`, `${PID} ${START} /different/engine/path`]) {
      const offset = requests.length, pending = readProcessRows('darwin', PID)
      await finish(table([PID, process.pid]), command + '\n', null, offset)
      expect(await pending).toEqual([{ ...identity, parentPid: 1, args: 'engine --fixture' }])
    }
  })

  it('drops a zombie target but not its reader witness', async () => {
    // Above Linux's pid_max; a real live /proc/321/stat must not change this fixture's answer.
    const zombiePid = 0x7fff_ffff
    const pending = readProcessRows('darwin', zombiePid)
    await finish(row(zombiePid, START, CUT, '<defunct>') + '\n' + row(process.pid) + '\n')
    expect(await pending).toEqual([])
  })

  it('uses fresh Linux start ticks for the selected lifetime check', async () => {
    setProcessTableSource(() => readProcessRows('linux', PID))
    for (const [currentTicks, state] of [[7, 'alive'], [8, 'gone']] as const) {
      ticks.mockReturnValue(currentTicks)
      const pending = checkPidRuntime({ engine: 'hermes', processIdentity: { ...identity, startTicks: 7 } })
      await finish(table([PID, process.pid]))
      expect(await pending).toMatchObject({ state })
    }
    expect(ticks.mock.calls).toEqual([[PID], [PID]])
  })

  it('a timed-out selected read stays unknown and does not poison the next check', async () => {
    const failed = checkPidRuntime({ engine: 'hermes', processIdentity: identity })
    await finish('', '', Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM' }))
    expect(await failed).toMatchObject({ state: 'unknown' })
    const fresh = checkPidRuntime({ engine: 'hermes', processIdentity: identity })
    await finish(table([PID, process.pid]), paths([PID, process.pid]))
    expect(await fresh).toMatchObject({ state: 'alive' })
  })

  it('an invalid native PID cannot establish a process exit', async () => {
    const pending = checkPidRuntime({ engine: 'hermes', processIdentity: { ...identity, pid: 0 } })
    await finish()
    expect(await pending).toMatchObject({ state: 'unknown' })
    expect(requests).toHaveLength(0)
  })
})

function decodedCopies(onCopy?: (value: string) => void) {
  const original = Buffer.prototype.toString, values: string[] = []
  const spy = vi.spyOn(Buffer.prototype, 'toString').mockImplementation(function (this: Buffer, ...args) {
    const value = Reflect.apply(original, this, args) as string
    if (args[0] === 'utf16le') { values.push(value); onCopy?.(value) }
    return value
  })
  return { values, mockRestore: () => spy.mockRestore() }
}

describe('selected and complete reads in flight', () => {
  it('does not copy the args or full command path of an unrequested process', async () => {
    const copies = decodedCopies()
    try {
      const pending = processRows(PID)
      await finish(row(PID) + '\n' + row(OTHER, START, CUT, 'unrequested-process-args') + '\n' + row(process.pid),
        paths([PID, process.pid]) + `${OTHER} ${START} /unrequested/process/path\n`)
      expect(await pending).toEqual([expected()])
      expect(copies.values).not.toContain('unrequested-process-args')
      expect(copies.values).not.toContain('/unrequested/process/path')
    } finally { copies.mockRestore() }
  })

  it.each([128, 129])('materializes unrelated rows only after %s distinct selections require a full census', async count => {
    const copies = decodedCopies()
    try {
      const pids = Array.from({ length: count }, (_, i) => PID - i), pending = pids.map(pid => processRows(pid))
      const extra = row(PID - 1000, START, CUT, 'outside-requested-scope')
      await finish(table([...pids, process.pid]) + extra + '\n', paths([...pids, process.pid]))
      expect(await Promise.all(pending)).toEqual(pids.map(pid => [expected(pid)]))
      expect(copies.values.filter(value => value === 'outside-requested-scope')).toHaveLength(count === 128 ? 0 : 1)
    } finally { copies.mockRestore() }
  })

  it('can promote after the row output settles while the command-path output is still pending', async () => {
    // macOS still has its second output pending; on Linux promotion precedes the parse microtask.
    const selected = processRows(PID)
    await Promise.resolve()
    for (const request of requests.filter(request => request.args.at(-1) === 'pid=,ppid=,comm=,lstart=,args=')) {
      request.settled = true; request.done(null, table(), '')
    }
    const full = processRows()
    await finish()
    expect(await selected).toEqual([expected()])
    expect((await full)?.map(row => row.pid)).toEqual([PID, OTHER, process.pid])
    expect(requests).toHaveLength(process.platform === 'darwin' ? 2 : 1)
  })

  it('a full request during sealed selected parsing starts a fresh census instead of consuming partial rows', async () => {
    let full: Promise<ProcessRow[] | null> | undefined
    const copies = decodedCopies(value => {
      if (!full && value === CUT) full = processRows()
    })
    try {
      const selected = processRows(PID)
      await finish()
      expect(await selected).toEqual([expected()])
      expect(full).toBeDefined()
      await finish()
      expect((await full)?.map(row => row.pid)).toEqual([PID, OTHER, process.pid])
      expect(requests).toHaveLength(process.platform === 'darwin' ? 4 : 2)
    } finally { copies.mockRestore() }
  })

  it('ignores an unrelated malformed row while refusing malformed selected rows for every selected caller', async () => {
    const allowed = processRows(PID)
    await finish(table([PID, process.pid]) + `${OTHER} malformed\n`)
    expect(await allowed).toEqual([expected()])
    const first = processRows(PID), second = processRows(OTHER)
    await finish(table([PID, process.pid]) + `${OTHER} malformed\n`)
    expect(await first).toBeNull()
    expect(await second).toBeNull()
  })

  it('a failed promoted read fails every caller and permits a fresh complete read', async () => {
    const selected = processRows(PID), full = processRows()
    await finish('', '', new Error('fixture census failed'))
    expect(await selected).toBeNull()
    expect(await full).toBeNull()
    const fresh = processRows()
    await finish()
    expect((await fresh)?.length).toBe(3)
  })

  it('batches different PIDs in the same turn into one selected read', async () => {
    const first = processRows(PID), second = processRows(OTHER), again = processRows(PID)
    await Promise.resolve()
    const asked = requests.map(request => request.args)
    await finish()
    expect(await first).toEqual([expected()])
    expect(await second).toEqual([expected(OTHER)])
    expect(await again).toEqual(await first)
    expect(asked).toHaveLength(process.platform === 'darwin' ? 2 : 1)
    expect(asked.every(args => args[0] === '-axo')).toBe(true)
  })

  it('a full request promotes a queued selection instead of starting a second read', async () => {
    const selected = processRows(PID), full = processRows(), other = processRows(OTHER)
    await Promise.resolve()
    const asked = requests.map(request => request.args)
    await finish()
    expect(await selected).toEqual([expected()])
    expect(await other).toEqual([expected(OTHER)])
    expect((await full)?.map(row => row.pid)).toEqual([PID, OTHER, process.pid])
    expect(asked).toHaveLength(process.platform === 'darwin' ? 2 : 1)
    expect(asked.every(args => args[0] === '-axo')).toBe(true)
  })

  it.each([128, 129])('bounds a batch of %s distinct PIDs before dispatch', async count => {
    const pids = Array.from({ length: count }, (_, i) => PID - i), pending = pids.map(pid => processRows(pid))
    await Promise.resolve()
    const asked = requests.map(request => request.args)
    await finish(table([...pids, process.pid]), paths([...pids, process.pid]))
    expect(await Promise.all(pending)).toEqual(pids.map(pid => [expected(pid)]))
    expect(asked).toHaveLength(process.platform === 'darwin' ? 2 : 1)
    expect(asked.every(args => args[0] === '-axo')).toBe(true)
  })

  it('shares one selected read for overlapping callers and reads afresh afterwards', async () => {
    const first = processRows(PID), second = processRows(PID)
    await Promise.resolve()
    const count = requests.length
    await finish(table([PID, process.pid]), paths([PID, process.pid]))
    expect(await first).toEqual([expected()])
    expect(await second).toEqual(await first)
    const later = processRows(PID)
    await Promise.resolve()
    expect(requests).toHaveLength(count * 2)
    await finish(table([process.pid]), paths([process.pid]))
    expect(await later).toEqual([])
  })

  it('uses one existing complete read for selected callers without narrowing discovery', async () => {
    const full = processRows(), count = requests.length, selected = processRows(PID)
    await finish()
    expect((await full)?.map(row => row.pid)).toEqual([PID, OTHER, process.pid])
    expect(await selected).toEqual([expected()])
    expect(requests).toHaveLength(count)
  })

  it('keeps one census when a different PID and full demand arrive during native I/O', async () => {
    const selected = processRows(PID)
    await Promise.resolve()
    const count = requests.length
    const other = processRows(OTHER), full = processRows(), fullAgain = processRows()
    await finish()
    expect(await selected).toEqual([expected()])
    expect(await other).toEqual([expected(OTHER)])
    expect((await full)?.map(row => row.pid)).toEqual([PID, OTHER, process.pid])
    expect(await fullAgain).toBe(await full)
    expect(requests).toHaveLength(count)
  })

  it('uses the installed Windows/test source, including failed reads, without spawning ps', async () => {
    const source = vi.fn<() => Promise<ProcessRow[] | null>>().mockResolvedValue([expected(), expected(OTHER)])
    setProcessTableSource(source)
    expect(await processRows(PID)).toEqual([expected()])
    source.mockResolvedValueOnce(null)
    expect(await processRows(PID)).toBeNull()
    expect(requests).toHaveLength(0)
  })

  it.each([0x8000_0000, 0xffff_ffff])('preserves Windows unsigned PID %s through the installed source', async pid => {
    setProcessTableSource(async () => [expected(pid)])
    expect(await checkPidRuntime({ engine: 'hermes', processIdentity: { ...identity, pid } })).toMatchObject({ state: 'alive' })
    expect(requests).toHaveLength(0)
  })

  it('a late old complete read cannot clear a replacement source read', async () => {
    let oldDone!: (rows: ProcessRow[]) => void
    const nextDone: ((rows: ProcessRow[]) => void)[] = []
    setProcessTableSource(() => new Promise(resolve => { oldDone = resolve }))
    const old = processRows()
    const nextSource = vi.fn(() => new Promise<ProcessRow[]>(resolve => { nextDone.push(resolve) }))
    setProcessTableSource(nextSource)
    const next = processRows()
    oldDone([]); await old
    const joined = processRows()
    for (const done of nextDone) done([expected()])
    expect(await next).toEqual([expected()])
    expect(await joined).toBe(await next)
    expect(nextSource).toHaveBeenCalledOnce()
  })

  it('a late selected read cannot clear a newer selected read after a source reset', async () => {
    const old = processRows(PID)
    await Promise.resolve()
    const count = requests.length
    setProcessTableSource(null)
    const next = processRows(PID)
    await Promise.resolve()
    for (const request of requests.slice(0, count)) {
      request.settled = true
      request.done(null, request.args.at(-1) === 'pid=,lstart=,comm=' ? paths([PID, process.pid]) : table([PID, process.pid]), '')
    }
    await old
    const joined = processRows(PID)
    expect(requests).toHaveLength(count * 2)
    await finish()
    expect(await joined).toEqual(await next)
  })
})

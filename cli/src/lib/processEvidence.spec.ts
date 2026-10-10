import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readlink } from 'node:fs/promises'
import { NativeEvidenceBudget, nativeBytes, nativeProbe, nativeUnavailable } from '../engines/kit/nativeEvidence.js'
import { parseProcessGraph, readProcessEvidence } from './processEvidence.js'
import { engineProcessMatchScore, resumeSessionId } from './tmux.js'
import { nativeProcessControl } from './nativeProcessControl.js'

vi.mock('node:fs/promises', async original => ({ ...await original<object>(), readlink: vi.fn() }))
vi.mock('../engines/kit/nativeEvidence.js', async original => ({ ...await original<object>(), nativeBytes: vi.fn(), nativeProbe: vi.fn() }))
vi.mock('./nativeProcessControl.js', async original => ({ ...await original<object>(), nativeProcessControl: vi.fn() }))
type Process = { pid: number; parentPid: number; command: string; argv: string[]; ticks: number; state: string; marker: string; image: string }
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const marker = 'Fri Oct  9 11:59:00 2026'
let rows: Process[]
const make = (pid = 42, parentPid = 1, command = 'codex'): Process => ({ pid, parentPid, command, argv: [command], ticks: pid * 100, state: 'S', marker, image: `/fixture/${command}` })
const graph = () => rows.map(row => `${row.pid} ${row.parentPid} ${row.state} ${row.marker}\n`).join('')
const budget = () => new NativeEvidenceBudget()
const lookup = (path: string) => {
  const row = rows.find(row => row.pid === Number(path.split('/')[2]))
  if (!row) throw new Error('fixture process disappeared')
  return row
}
beforeEach(() => {
  vi.resetAllMocks(); rows = [make()]
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.mocked(readlink).mockImplementation(async path => lookup(String(path)).image as never)
  vi.mocked(nativeBytes).mockImplementation(async path => {
    const row = lookup(path)
    return Buffer.from(path.endsWith('/cmdline') ? row.argv.join('\0') + '\0'
      : `${row.pid} (${row.command}) ${[row.state, row.parentPid, ...Array(17).fill(0), row.ticks].join(' ')}\n`)
  })
  vi.mocked(nativeProbe).mockImplementation(async (command, args) => {
    expect(command).toBe('ps')
    if (args.includes('-axo')) return graph()
    const row = rows.find(row => row.pid === Number(args[args.indexOf('-p') + 1]))!
    return `${row.parentPid} ${row.state} ${row.command} ${row.marker} ${row.argv.join(' ')}\n`
  })
  vi.mocked(nativeProcessControl).mockImplementation(async (pids, parent) => ({ parent,
    children: parent ? rows.filter(row => row.parentPid === parent && row.state[0] !== 'Z').map(row => row.pid) : [],
    rows: new Map(pids.map(pid => {
      const row = rows.find(row => row.pid === pid)!
      return [pid, { pid, parentPid: row.parentPid, command: row.command, imagePath: row.image,
        argv: [...row.argv], birth: process.platform === 'darwin' ? `${Date.parse(row.marker) / 1000}:123456` : String(row.ticks), fds: [] }]
    })),
  }))
})
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks() })

describe('complete process graph', () => {
  it.each(['', '42 1 S ' + marker, '42 1 S invalid\n', '42 1 S ' + marker + '\nnoise\n',
    '0 1 S ' + marker + '\n', '99999999999999 1 S ' + marker + '\n',
    `42 1 S ${marker}\n42 2 S ${marker}\n`])('holds incomplete or ambiguous graph %j', text => {
    expect(() => parseProcessGraph(text, budget())).toThrow('identity is held')
  })
  it('bounds even a syntactically valid graph', () => {
    const text = Array.from({ length: 4097 }, (_, index) => `${index + 1} 0 S ${marker}\n`).join('')
    expect(() => parseProcessGraph(text, budget())).toThrow('exceeds its limit')
  })
  it('proves absence and death separately from a failed probe, and rechecks absence', async () => {
    rows = [make(50)]
    const proof = await readProcessEvidence(42, budget())
    expect(proof.parent).toBeNull(); await proof.verify()
    rows.push(make())
    await expect(proof.verify()).rejects.toThrow('appeared')
    rows[1].state = 'Z'
    const dead = await readProcessEvidence(42, budget())
    expect(dead.parent).toBeNull(); await dead.verify()
    vi.mocked(nativeProbe).mockRejectedValueOnce(new Error('probe failed'))
    await expect(readProcessEvidence(42, budget())).rejects.toThrow('probe failed')
  })
})

describe('native process incarnation and executable', () => {
  it('preserves argv boundaries, including code, quotes and prompt newlines', async () => {
    rows[0] = { ...make(), command: 'node', image: '/fixture/node', argv: ['node', '-e', '"codex"\n\'resume\' aaaaaaaa-1111-4222-8333-000000000001'] }
    const proof = await readProcessEvidence(42, budget())
    expect(proof.parent?.nativeArgv).toEqual(rows[0].argv)
    expect(engineProcessMatchScore(proof.parent!, 'codex')).toBe(0)
    expect(resumeSessionId('codex', proof.parent!.args, proof.parent!.nativeArgv)).toBeNull()
    const id = 'aaaaaaaa-1111-4222-8333-000000000001'
    expect(resumeSessionId('codex', '', ['codex', 'resume', id])).toBe(id)
    expect(resumeSessionId('codex', '', ['codex', 'resume=' + id])).toBe(id)
    expect(resumeSessionId('codex', '', ['codex', 'fork', id])).toBeNull()
  })
  it('does not mistake clock drift for a different Linux process generation', async () => {
    const proof = await readProcessEvidence(42, budget())
    rows[0].marker = 'Fri Oct  9 11:58:00 2026'
    await expect(proof.verify()).resolves.toBeUndefined()
  })
  it.each(['ticks', 'image', 'args', 'parent', 'dead'] as const)('rejects a changed %s after inspection', async mode => {
    const proof = await readProcessEvidence(42, budget())
    if (mode === 'ticks') rows[0].ticks++
    if (mode === 'image') rows[0].image += '-new'
    if (mode === 'args') rows[0].argv.push('different')
    if (mode === 'parent') rows[0].parentPid++
    if (mode === 'dead') rows[0].state = 'Z'
    await expect(proof.verify()).rejects.toThrow('identity is held')
  })
  it('checks the process observed by core, not merely the current occupant of its pid', async () => {
    await expect(readProcessEvidence(42, budget(), undefined, { pid: 42, executable: 'codex', startMarker: marker, startTicks: 1 }))
      .rejects.toThrow('observed owner')
  })
  it('brackets argv and executable reads with kernel generation and image evidence', async () => {
    vi.mocked(readlink).mockResolvedValueOnce('/fixture/codex' as never).mockResolvedValueOnce('/fixture/other' as never)
    await expect(readProcessEvidence(42, budget())).rejects.toThrow('changed while')
  })
  it.each(['stat', 'cmdline'] as const)('holds a truncated %s record', async kind => {
    const normal = vi.mocked(nativeBytes).getMockImplementation()!
    vi.mocked(nativeBytes).mockImplementation((path, ...args) => path.endsWith('/' + kind)
      ? Promise.resolve(Buffer.from(kind === 'stat' ? '42 (codex) S 1' : 'codex')) : normal(path, ...args))
    await expect(readProcessEvidence(42, budget())).rejects.toThrow('identity is held')
  })
  it('parses comm parentheses and newlines without shifting the generation fields', async () => {
    rows[0].command = 'a (b)\nc'
    expect((await readProcessEvidence(42, budget())).parent?.startTicks).toBe(4200)
  })
  it('reads every direct child before classification and never follows grandchildren', async () => {
    rows = [make(42, 1, 'node'), make(43, 42), make(44, 42, 'other'), make(45, 43)]
    const proof = await readProcessEvidence(42, budget(), () => true)
    expect(proof.children.map(row => row.pid)).toEqual([43, 44])
    expect(vi.mocked(nativeBytes).mock.calls.every(([path]) => !path.includes('/45/'))).toBe(true)
    rows[2].ticks++
    await expect(proof.verify()).rejects.toThrow('child changed')
  })
  it('holds a new, removed or reparented child', async () => {
    rows = [make(42, 1, 'node'), make(43, 42)]
    const proof = await readProcessEvidence(42, budget(), () => true)
    rows[1].parentPid = 50
    await expect(proof.verify()).rejects.toThrow('child set changed')
    rows[1].parentPid = 42; rows.push(make(44, 42))
    await expect(proof.verify()).rejects.toThrow('child set changed')
  })
  it('caps a launcher child pool before opening every child record', async () => {
    rows = [make(), ...Array.from({ length: 33 }, (_, index) => make(index + 50, 42))]
    await expect(readProcessEvidence(42, budget(), () => true)).rejects.toThrow('direct-child limit')
  })
  it('fences the macOS command and coarse native start marker without Linux records', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    const proof = await readProcessEvidence(42, budget())
    expect(nativeBytes).not.toHaveBeenCalled()
    rows[0].command = 'other'
    await expect(proof.verify()).rejects.toThrow('owner changed')
  })
  it('holds ambiguous macOS command output rather than inventing argv boundaries', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    rows[0].argv.push('line\nbreak')
    await expect(readProcessEvidence(42, budget())).rejects.toThrow('command has changed ownership')
  })
  it.each(['RX', 'SX', 'R>'])('keeps the live Darwin process state %s', async state => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    rows[0].state = state
    expect((await readProcessEvidence(42, budget())).parent?.pid).toBe(42)
  })
  it('reads Darwin comm with the same fixed-width column position as discovery', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    rows[0].argv.push('--no-daemon', '--prompt', 'fixture')
    await expect(readProcessEvidence(42, budget(), undefined, { pid: 42, executable: 'codex', startMarker: marker })).resolves.toMatchObject({ parent: { executable: 'codex' } })
    expect(vi.mocked(nativeProbe).mock.calls.filter(([, args]) => args.includes('-p')).every(([, args]) => args.at(-1) === 'ppid=,state=,comm=,lstart=,args=')).toBe(true)
  })
  it('rejects changed descriptors in the same final native observation as process authority', async () => {
    const proof = await readProcessEvidence(42, budget())
    await expect(proof.verifyDescriptors(new Map([[42, [{ fd: '3', path: '/rollout', kind: 'REG', device: 1n, inode: 2n }]]])))
      .rejects.toThrow('descriptor pool changed')
    rows[0].argv.push('new command')
    await expect(proof.verifyDescriptors(new Map([[42, []]]))).rejects.toThrow('owner changed')
  })
  it('rejects a changed child after a stable parent in the joined final observation', async () => {
    rows = [make(42, 1, 'node'), make(43, 42)]
    const proof = await readProcessEvidence(42, budget(), () => true)
    rows[1].ticks++
    await expect(proof.verifyDescriptors(new Map([[42, []], [43, []]]), 43)).rejects.toThrow('owner changed')
  })
})


it('retains an unrelated Darwin ?E+ row without holding a healthy owner', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  rows.push({ ...make(43, 99, 'other'), state: '?E+' })
  const proof = await readProcessEvidence(42, budget(), () => true)
  expect(proof.parent?.pid).toBe(42)
  expect(proof.children).toEqual([])
  await proof.verify()
  expect(vi.mocked(nativeProcessControl).mock.calls.every(([pids]) => !pids.includes(43))).toBe(true)
})
it.each(['owner', 'child'])('cannot treat an inconclusive Darwin %s state as proof of absence', async kind => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  const unknown = kind === 'owner' ? 42 : 43
  if (kind === 'owner') rows[0].state = '?E+'
  else rows.push({ ...make(43, 42), state: '?E+' })
  const read = vi.mocked(nativeProcessControl).getMockImplementation()!
  vi.mocked(nativeProcessControl).mockImplementation(async (...args) => {
    if (args[0].includes(unknown)) return nativeUnavailable('the fixture kernel owner is unavailable')
    return read(...args)
  })
  await expect(readProcessEvidence(42, budget(), () => true)).rejects.toMatchObject({
    code: 'IDENTITY_UNAVAILABLE', message: expect.stringContaining('kernel owner is unavailable'),
  })
})

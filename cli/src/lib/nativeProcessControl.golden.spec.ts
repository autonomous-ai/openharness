/** Former native probe and pinned-helper behavior before sharing it with hook clients. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { NativeEvidenceBudget } from '../engines/kit/nativeEvidence.js'
import { controlIdentity, nativeProcessControl } from './nativeProcessControl.js'
import { prepareProcessImageHelper } from './nativeProcessImages.js'

const host = vi.hoisted(() => ({ root: '', runtime: '', exec: vi.fn() }))
vi.mock('../config/env.js', () => ({ env: { get ADAPTER_RUNTIME_DIR() { return host.runtime } } }))
vi.mock('node:os', async original => ({ ...await original<object>(), platform: () => process.platform }))
vi.mock('node:perf_hooks', () => ({ performance: { now: () => 0 } }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in the native-control golden') }
  return { execFile: host.exec, exec: forbidden, execSync: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>(), result = { ...fs }
  for (const method of ['openSync', 'opendirSync', 'readlinkSync', 'statSync'] as const) {
    result[method] = ((path: unknown, ...args: unknown[]) => Reflect.apply(fs[method], fs,
      [String(path).startsWith('/proc/') ? join(host.root, String(path).slice(1)) : path, ...args])) as never
  }
  return result
})
const GOLDEN = new URL('../__fixtures__/native-process-control.golden.json', import.meta.url)
const RECORD = process.env.RECORD_NATIVE_PROCESS_CONTROL_GOLDEN === '1'
const expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
const captured: Record<string, unknown> = {}
const hex = (text: string) => Buffer.from(text).toString('hex')
// Pinned inert bytes: the mocked transport supplies every probe reply.
const bytes = Buffer.alloc(64, 7), sha256 = createHash('sha256').update(bytes).digest('hex')
const artifact = { schema: 1 as const, sha256, size: bytes.length, base64: bytes.toString('base64') }

it.each(['linux', 'darwin'])('preserves precise native control and immutable helper preparation on %s', async platform => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  host.root = realpathSync(mkdtempSync(join(tmpdir(), 'native-control-golden-')))
  host.runtime = join(host.root, 'runtime')
  const file = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  const check = (name: string, value: unknown) => {
    const key = `${platform}:${name}`
    captured[key] = JSON.parse(JSON.stringify(value ?? null, (_key, item) => typeof item === 'bigint' ? String(item) : item)
      .split(host.root).join('<root>'))
    if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
  }
  try {
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-11T00:00:00Z') })
    vi.stubEnv('TZ', 'UTC'); vi.stubEnv('TMPDIR', '/tmp')
    vi.stubGlobal('__DARWIN_PROCESS_IMAGES__', JSON.stringify(artifact))
    const helper = await prepareProcessImageHelper(artifact, host.runtime)
    expect(helper).toEqual(expect.any(String))
    check('helper', { path: helper, hash: createHash('sha256').update(readFileSync(helper!)).digest('hex'),
      mode: lstatSync(helper!).mode & 0o777, files: readdirSync(dirname(helper!)),
      repeated: await prepareProcessImageHelper(artifact, host.runtime) })
    host.exec.mockReset().mockImplementation((path, args, options, callback) => {
      if (path !== helper || !['--control', '--identity'].includes(args[0])) throw Error('Unexpected native probe')
      const descriptors = args[0] === '--control'
      const rows = [42, 43].map(pid => ({ pid, parentPid: pid === 42 ? 1 : 42,
        startSeconds: 1_790_000_000, startMicros: pid, commandHex: hex('codex'), imageHex: hex('/fixture/codex'),
        commandDigest: 'a'.repeat(64), fds: descriptors ? [{ fd: 3, type: 1, mode: 0o100000, device: '17', inode: '9007199254740993' }] : [] }))
      const header = { schema: 2, mode: descriptors ? 'control' : 'identity', parent: 42, children: [43] }
      callback(null, Buffer.from([header, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n'), Buffer.alloc(0))
    })
    for (const pid of [42, 43]) {
      const directory = join(host.root, 'proc', String(pid))
      file(join(directory, 'stat'), `${pid} (codex) S ${pid === 42 ? 1 : 42} ${Array(17).fill(0).join(' ')} ${pid * 10}\n`)
      file(join(directory, 'cmdline'), 'codex\0--prompt\0quote\ntext\0')
      file(join(directory, 'task', String(pid), 'children'), pid === 42 ? '43 ' : '')
      mkdirSync(join(directory, 'fd')); symlinkSync('pipe:[17]', join(directory, 'fd', '3'))
      symlinkSync('/fixture/codex', join(directory, 'exe'))
    }
    for (const descriptors of [false, true]) {
      const reading = nativeProcessControl([42, 43], 42, new NativeEvidenceBudget(), descriptors)
      await expect(reading).resolves.toHaveProperty('rows')
      const snapshot = await reading
      check(descriptors ? 'control' : 'identity', { parent: snapshot.parent, children: snapshot.children,
        rows: [...snapshot.rows.values()].map(row => ({ ...row, identity: controlIdentity(row) })) })
    }
    check('requests', host.exec.mock.calls.map(([path, args, options]) => ({ path, args,
      timeout: options.timeout, maxBuffer: options.maxBuffer, killSignal: options.killSignal, locale: options.env.LC_TIME })))
    // A plausible output prefix never turns unavailable control into an empty pool.
    if (platform === 'linux') rmSync(join(host.root, 'proc', '43', 'cmdline'))
    else host.exec.mockImplementationOnce((_path, _args, _options, callback) => callback(Error('fixture failure'), Buffer.from('{}\n'), Buffer.alloc(0)))
    let refusal: unknown
    try { await nativeProcessControl([42, 43], 42, new NativeEvidenceBudget(), false) }
    catch (error) { const held = error as Error & { code: string }; refusal = { code: held.code, message: held.message } }
    check('unavailable', refusal)
    const corrupt = join(host.root, 'corrupt', 'process-images', sha256)
    mkdirSync(dirname(corrupt), { recursive: true, mode: 0o700 }); writeFileSync(corrupt, 'foreign fixture bytes', { mode: 0o500 })
    check('corrupt-helper', { prepared: await prepareProcessImageHelper(artifact, join(host.root, 'corrupt')),
      content: readFileSync(corrupt, 'utf8') })
  } finally {
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals()
    Object.defineProperty(process, 'platform', original)
    rmSync(host.root, { recursive: true, force: true })
  }
}, 15_000)

afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  else expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort())
})

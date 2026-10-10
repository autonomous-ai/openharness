/** Healthy native descriptor answers from former main. Pinned Linux/macOS, UTC, fixed time and private files;
 * every host binary is forbidden. Record before changing process or descriptor authority. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { ProcessRow } from '../lib/tmux.js'
import type { RegisteredSession } from '../lib/registry.js'

const fixture = vi.hoisted(() => ({ root: '', rows: [] as ProcessRow[], lsof: new Map<number, string[]>() }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  const mapped = (path: unknown) => String(path).startsWith('/proc/')
    ? join(fixture.root, 'proc', String(path).slice('/proc/'.length)) : path
  return { ...fs,
    openSync: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.openSync, fs, [mapped(path), ...args]),
    readlinkSync: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.readlinkSync, fs, [mapped(path), ...args]),
    statSync: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.statSync, fs, [mapped(path), ...args]),
    opendirSync: (path: unknown, ...args: unknown[]) => {
      const task = /^\/proc\/(\d+)\/task$/.exec(String(path))
      if (task) {
        const folder = join(String(mapped(path)), task[1]); fs.mkdirSync(folder, { recursive: true })
        const children = fixture.rows.filter(row => row.parentPid === Number(task[1])).map(row => row.pid)
        fs.writeFileSync(join(folder, 'children'), children.length ? children.join(' ') + ' ' : '')
      }
      return Reflect.apply(fs.opendirSync, fs, [mapped(path), ...args])
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  const mapped = (path: unknown) => String(path).startsWith('/proc/')
    ? join(fixture.root, 'proc', String(path).slice('/proc/'.length)) : path
  return { ...fs,
    open: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.open, fs, [mapped(path), ...args]),
    readdir: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.readdir, fs, [mapped(path), ...args]),
    opendir: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.opendir, fs, [mapped(path), ...args]),
    readlink: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.readlink, fs, [mapped(path), ...args]),
    stat: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.stat, fs, [mapped(path), ...args]),
  }
})
vi.mock('node:child_process', async original => {
  const forbidden = () => { throw new Error('This golden must never run a host binary') }
  return { ...await original<object>(), execFile: (command: string, args: string[], _options: unknown, done: (error: Error | null, out: Buffer, err: Buffer) => void) => {
    const pid = Number(args[args.indexOf('-p') + 1])
    let output: string
    if (command === 'ps' && args.join(' ') === '-axo pid=,ppid=,state=,lstart=') {
      output = fixture.rows.map(row => `${row.pid} ${row.parentPid} S ${row.startMarker}\n`).join('')
    } else if (command === 'ps' && args[0] === '-ww') {
      const row = fixture.rows.find(row => row.pid === pid)
      if (!row) return forbidden()
      output = `${row.parentPid} S ${row.executable} ${row.startMarker} ${row.args}\n`
    } else if (command === 'lsof' && args.includes('-F0pftDin')) {
      const paths = fixture.lsof.get(pid)
      if (!paths) return forbidden()
      output = `p${pid}\0\n` + paths.map((path, index) => {
        const info = statSync(path, { bigint: true })
        return `f${index + 3}\0tREG\0D0x${info.dev.toString(16)}\0i${info.ino}\0n${path}\0\n`
      }).join('')
    } else if (command === '/fixture-tools/native-control' && args[0] === '--control') {
      const parent = Number(args[2]), ids = args.slice(3).map(Number)
      output = JSON.stringify({ schema: 2, mode: 'control', parent,
        children: parent ? fixture.rows.filter(row => row.parentPid === parent).map(row => row.pid) : [] }) + '\n'
      for (const id of ids) {
        const row = fixture.rows.find(row => row.pid === id)!
        output += JSON.stringify({ pid: id, parentPid: row.parentPid, startSeconds: Date.parse(row.startMarker) / 1000,
          startMicros: 123456, commandHex: Buffer.from(row.executable.split('/').at(-1)!).toString('hex'),
          imageHex: Buffer.from(row.executable).toString('hex'), commandDigest: 'a'.repeat(64),
          fds: (fixture.lsof.get(id) ?? []).map((path, index) => {
            const info = statSync(path, { bigint: true })
            return { fd: index + 3, type: 1, mode: 0o100000, device: String(info.dev), inode: String(info.ino) }
          }),
        }) + '\n'
      }
    } else return forbidden()
    done(null, Buffer.from(output), Buffer.alloc(0))
  }, execFileSync: forbidden, spawn: forbidden, spawnSync: forbidden }
})
vi.mock('../lib/tmux.js', async original => ({ ...await original<object>(), processRows: async () => fixture.rows }))
vi.mock('../lib/loginShellEnv.js', () => ({ loginShellEnvironment: () => ({}) }))
vi.mock('../lib/nativeProcessImages.js', async original => ({ ...await original<object>(),
  bundledProcessImageHelper: async () => ({ path: '/fixture-tools/native-control', key: 'fixture' }),
}))

const GOLDEN = fileURLToPath(new URL('./__fixtures__/native-descriptors.golden.json', import.meta.url))
const RECORD = process.env.RECORD_NATIVE_DESCRIPTORS_GOLDEN === '1'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const now = Date.parse('2026-10-09T12:00:00Z')
const startMarker = 'Fri Oct  9 11:59:00 2026'
const id = (n: number) => `aaaaaaaa-1111-4222-8333-${String(n).padStart(12, '0')}`
const path = (...parts: string[]) => join(fixture.root, ...parts)
const captured: Record<string, unknown> = {}
let expected: Record<string, unknown>
let repair: typeof import('../lib/sessionRepair.js')
let capture: typeof import('../lib/captureResumeIdentity.js')['captureResumeIdentity']

function file(name: string, text = ''): string {
  mkdirSync(dirname(name), { recursive: true }); writeFileSync(name, text)
  return name
}
function rollout(n: number, options: { home?: string; cwd?: string; child?: boolean } = {}): string {
  return file(join(options.home ?? path('codex'), 'sessions', 'day', `rollout-${id(n)}.jsonl`), JSON.stringify({
    type: 'session_meta', payload: { id: id(n), cwd: options.cwd ?? path('work'),
      source: options.child ? { subagent: { thread_spawn: { parent_thread_id: id(99) } } } : 'cli' },
  }) + '\n')
}
function descriptors(pid: number, targets: string[]): void {
  const folder = path('proc', String(pid), 'fd')
  rmSync(folder, { recursive: true, force: true }); mkdirSync(folder, { recursive: true })
  targets.forEach((target, index) => symlinkSync(target, join(folder, String(index + 3))))
}
function processRow(pid: number, parentPid: number, executable = '/fixture-tools/codex', args = executable): ProcessRow {
  mkdirSync(path('proc', String(pid), 'fd'), { recursive: true })
  const fields = ['S', String(parentPid), ...Array(17).fill('0'), String(pid * 100)]
  file(path('proc', String(pid), 'stat'), `${pid} (${executable}) ${fields.join(' ')}\n`)
  file(path('proc', String(pid), 'cmdline'), args.split(' ').join('\0') + '\0')
  const exe = path('proc', String(pid), 'exe'); rmSync(exe, { force: true }); symlinkSync(executable, exe)
  return { pid, parentPid, executable, args, startMarker, startTicks: pid * 100 }
}
function row(pid = 42): RegisteredSession {
  const live = fixture.rows.find(item => item.pid === pid)!
  return { agentId: 'fixture-agent', engine: 'codex', sessionId: '', transcriptPath: null, cwd: path('work'),
    codexHome: path('codex'), processIdentity: { pid, executable: live.executable, startMarker, startTicks: live.startTicks },
    source: 'discovery', boundAt: 0 } as RegisteredSession
}
async function check(key: string, work: Promise<unknown> | unknown): Promise<void> {
  captured[key] = JSON.parse(JSON.stringify(await work ?? null).split(fixture.root).join('<root>'))
  if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
}

beforeAll(async () => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'native-descriptors-golden-')))
  for (const [name, value] of Object.entries({ HOME: path('home'), TZ: 'UTC',
    ADAPTER_DATA_DIR: path('data'), ADAPTER_RUNTIME_DIR: path('runtime'), CODEX_HOME: path('codex'),
    CLAUDE_CONFIG_DIR: path('claude'), CLAUDE_PROJECTS_DIR: path('claude', 'projects'),
  })) vi.stubEnv(name, value)
  for (const folder of ['home', 'data', 'runtime', 'work', 'elsewhere']) mkdirSync(path(folder), { recursive: true })
  Object.defineProperty(globalThis.process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now }); vi.resetModules()
  repair = await import('../lib/sessionRepair.js')
  capture = (await import('../lib/captureResumeIdentity.js')).captureResumeIdentity
  expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
})
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  Object.defineProperty(globalThis.process, 'platform', platform); vi.useRealTimers(); vi.unstubAllEnvs()
  rmSync(fixture.root, { recursive: true, force: true })
})

it('records complete private descriptor listings and one launcher child', async () => {
  const own = rollout(1), other = rollout(2), noise = file(path('notes'))
  fixture.rows = [processRow(42, 1), processRow(50, 1), processRow(51, 42)]
  descriptors(42, [noise, own, 'socket:[123]']); descriptors(50, []); descriptors(51, [other])
  await check('descriptors:native', repair.openFiles(42).then(paths => paths.sort()))
  await check('descriptors:empty', repair.openFiles(50))
  await check('descriptors:invalid', repair.openFiles(0))
  await check('process:native-ignores-nested-tool', repair.processFilesOf('codex', 42).then(paths => paths.sort()))
  await check('process:other-engine', repair.processFilesOf('claude', 42))
  fixture.rows = [processRow(42, 1, '/fixture-tools/node', 'node /fixture-tools/codex.js'), processRow(43, 42), processRow(50, 1), processRow(51, 43)]
  descriptors(42, [noise]); descriptors(43, [own]); descriptors(50, [other]); descriptors(51, [other])
  await check('process:launcher-child', repair.processFilesOf('codex', 42).then(paths => paths.sort()))
  await check('process:direct-native-child', repair.processFilesOf('codex', 43))
})

it('records healthy exact native headers, roots and exclusions', async () => {
  const own = rollout(11), child = rollout(12, { child: true }), other = rollout(13, { cwd: path('elsewhere') })
  const outside = rollout(14, { home: path('other-home') }), root = path('codex', 'sessions')
  const alias = path('rollout-alias.jsonl'); symlinkSync(own, alias)
  fixture.rows = [processRow(42, 1)]
  for (const [name, held, cwd, roots] of [
    ['one', [own], path('work'), root],
    ['repeated-descriptors', [own, own], path('work'), root],
    ['alias', [own, alias], path('work'), root],
    ['child-excluded', [own, child], path('work'), root],
    ['other-cwd-excluded', [own, other], path('work'), root],
    ['outside-profile-excluded', [own, outside], path('work'), root],
    ['only-child', [child], path('work'), root],
    ['only-other-cwd', [other], path('work'), root],
    ['empty', [], path('work'), root],
    ['moved-home', [outside], path('work'), [root, path('other-home', 'sessions')]],
  ] as const) {
    descriptors(42, [...held])
    await check(`identity:${name}`, repair.openFileSessionOf('codex', 42, typeof roots === 'string' ? roots : [...roots], cwd))
  }
  await check('identity:other-engine', repair.openFileSessionOf('claude', 42, root, path('work')))
})

it('records native and launcher capture before Stop without native writes', async () => {
  const own = rollout(21)
  fixture.rows = [processRow(42, 1)]; descriptors(42, [own])
  await check('capture:native', capture(row()))
  await check('capture:complete-binding', capture({ ...row(), sessionId: id(21), transcriptPath: own }))
  await check('capture:terminal', capture({ ...row(), engine: 'terminal' }))
  fixture.rows = [processRow(42, 1, '/fixture-tools/node', 'node /fixture-tools/codex.js'), processRow(43, 42)]
  descriptors(42, []); descriptors(43, [own])
  await check('capture:launcher', capture(row()))
  descriptors(43, [])
  await check('capture:complete-empty', capture(row()))
})
it('records healthy macOS descriptor and capture answers through a placeholder lsof', async () => {
  Object.defineProperty(globalThis.process, 'platform', { ...platform, value: 'darwin' })
  const own = rollout(31), unicode = rollout(32, { home: path('café-home') }), noise = file(path('notes-mac'))
  fixture.rows = [processRow(42, 1), processRow(50, 1)]
  fixture.lsof.set(42, [noise, own]); fixture.lsof.set(50, [])
  await check('darwin:descriptors', repair.openFiles(42).then(paths => paths.sort()))
  await check('darwin:empty', repair.openFiles(50))
  await check('darwin:identity', repair.openFileSessionOf('codex', 42, path('codex', 'sessions'), path('work')))
  await check('darwin:capture', capture(row()))
  fixture.lsof.set(42, [unicode])
  await check('darwin:unicode', repair.openFileSessionOf('codex', 42, path('café-home', 'sessions'), path('work')))
  fixture.rows = [processRow(42, 1, '/fixture-tools/node', 'node /fixture-tools/codex.js'), processRow(43, 42)]
  fixture.lsof.set(42, [noise]); fixture.lsof.set(43, [own])
  await check('darwin:launcher', repair.processFilesOf('codex', 42).then(paths => paths.sort()))
  Object.defineProperty(globalThis.process, 'platform', { ...platform, value: 'linux' })
})
it('has exactly the recorded observations', () => { if (!RECORD) expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort()) })

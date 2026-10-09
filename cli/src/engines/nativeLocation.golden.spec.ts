/** Native location answers before bounded discovery. Linux, UTC, a fixed clock and private files;
 * no host binary, process descriptor or engine home is consulted. Record before changing the wiring. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  const mapped = (path: unknown) => String(path).startsWith('/proc/')
    ? join(fixture.root, 'proc', String(path).slice('/proc/'.length)) : path
  return { ...fs,
    readdir: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.readdir, fs, [mapped(path), ...args]),
    opendir: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.opendir, fs, [mapped(path), ...args]),
    readlink: (path: unknown, ...args: unknown[]) => Reflect.apply(fs.readlink, fs, [mapped(path), ...args]),
  }
})
vi.mock('node:child_process', async original => ({ ...await original<object>(),
  execFile: () => { throw new Error('This golden must never run a host binary') },
}))
const GOLDEN = fileURLToPath(new URL('./__fixtures__/native-location.golden.json', import.meta.url))
const RECORD = process.env.RECORD_NATIVE_LOCATION_GOLDEN === '1'
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const at = Date.parse('2026-10-09T12:00:00Z')
const id = (n: number) => `aaaaaaaa-1111-4222-8333-${String(n).padStart(12, '0')}`
const captured: Record<string, unknown> = {}
let expected: Record<string, unknown>
let locate: typeof import('./kit/sessionLocation.js')
let contracts: {
  cursor: typeof import('./cursor/contract.js')['CURSOR_TRANSCRIPT']
  grok: typeof import('./grok/contract.js')['GROK_TRANSCRIPT']
  copilot: typeof import('./copilot/contract.js')['COPILOT_TRANSCRIPT']
  copilotProcess: typeof import('./copilot/contract.js')['COPILOT_PROCESS_SESSION']
  agy: typeof import('./agy/contract.js')['AGY_TRANSCRIPT']
  agyProcess: typeof import('./agy/contract.js')['AGY_PROCESS_SESSION']
}
const home = (engine: string) => join(fixture.root, engine)
function file(path: string, body = '', time = at): string {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body)
  utimesSync(path, time / 1000, time / 1000)
  return path
}
async function check(key: string, work: Promise<unknown> | unknown): Promise<void> {
  captured[key] = JSON.parse(JSON.stringify(await work ?? null).split(fixture.root).join('<root>'))
  if (!RECORD) expect({ key, value: captured[key] }).toEqual({ key, value: expected[key] })
}
beforeAll(async () => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'native-location-golden-')))
  for (const [name, value] of Object.entries({ HOME: join(fixture.root, 'home'), TZ: 'UTC',
    ADAPTER_DATA_DIR: join(fixture.root, 'data'), ADAPTER_RUNTIME_DIR: join(fixture.root, 'runtime'),
    CURSOR_HOME: home('cursor'), CURSOR_CONFIG_DIR: home('cursor'), CURSOR_DATA_DIR: home('cursor'),
    COPILOT_HOME: home('copilot'), GROK_HOME: home('grok'), AGY_HOME: home('agy'), AGY_CONFIG_DIR: home('agy'),
  })) vi.stubEnv(name, value)
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  vi.useFakeTimers({ toFake: ['Date'], now: at })
  vi.resetModules()
  locate = await import('./kit/sessionLocation.js')
  contracts = {
    cursor: (await import('./cursor/contract.js')).CURSOR_TRANSCRIPT,
    grok: (await import('./grok/contract.js')).GROK_TRANSCRIPT,
    copilot: (await import('./copilot/contract.js')).COPILOT_TRANSCRIPT,
    copilotProcess: (await import('./copilot/contract.js')).COPILOT_PROCESS_SESSION,
    agy: (await import('./agy/contract.js')).AGY_TRANSCRIPT,
    agyProcess: (await import('./agy/contract.js')).AGY_PROCESS_SESSION,
  }
  expected = RECORD ? {} : JSON.parse(readFileSync(GOLDEN, 'utf8'))
})
afterAll(() => {
  if (RECORD) writeFileSync(GOLDEN, JSON.stringify(captured, null, 2) + '\n')
  Object.defineProperty(process, 'platform', platform); vi.useRealTimers(); vi.unstubAllEnvs()
  rmSync(fixture.root, { recursive: true, force: true })
})

it('records exact transcript locations through each native declaration', async () => {
  const cursor = file(join(home('cursor'), 'projects', 'project', 'agent-transcripts', id(1), `${id(1)}.jsonl`), '{}\n')
  for (const [name, session] of [['existing', id(1)], ['missing', id(2)], ['invalid', '../escape']]) {
    await check(`cursor:${name}`, locate.locateTranscript(contracts.cursor, home('cursor'), session))
  }
  await check('cursor:validation-rejected', locate.locateTranscript(contracts.cursor, home('cursor'), id(1), { valid: () => false }))
  await check('cursor:groups', locate.locateTranscript(contracts.cursor, home('cursor'), id(1), { groups: ['project'], valid: path => path === cursor }))
  for (const [engine, rule, path] of [
    ['copilot', contracts.copilot, join(home('copilot'), 'session-state', id(3), 'events.jsonl')],
    ['agy', contracts.agy, join(home('agy'), 'brain', id(3), '.system_generated', 'logs', 'transcript_full.jsonl')],
  ] as const) {
    file(path, '{}\n')
    await check(`${engine}:existing`, locate.locateTranscript(rule, home(engine), id(3)))
    await check(`${engine}:missing`, locate.locateTranscript(rule, home(engine), id(4)))
    await check(`${engine}:invalid`, locate.locateTranscript(rule, home(engine), '../escape'))
  }
  file(join(home('grok'), 'sessions', encodeURIComponent('/work/encoded'), id(5), 'updates.jsonl'), '{}\n')
  file(join(home('grok'), 'sessions', 'hashed-workspace', '.cwd'), '/work/hashed\n')
  file(join(home('grok'), 'sessions', 'hashed-workspace', id(6), 'updates.jsonl'), '{}\n')
  for (const [name, session, cwd] of [['encoded', id(5), '/work/encoded'], ['hashed', id(6), '/work/hashed'],
    ['other-workspace', id(6), '/work/elsewhere'], ['missing', id(7), '/work/encoded'], ['no-workspace', id(5), undefined]] as const) {
    await check(`grok:${name}`, locate.locateTranscript(contracts.grok, home('grok'), session, { cwd }))
  }
})

it('records complete native process evidence without consulting host processes', async () => {
  const pid = 4242
  file(join(home('copilot'), 'session-state', id(11), `inuse.${pid}.lock`), '', at - 1000)
  file(join(home('copilot'), 'session-state', id(12), `inuse.${pid}.lock`))
  await check('copilot:newest-lock', locate.locateProcessSession(contracts.copilotProcess, home('copilot'), pid))
  await check('copilot:no-lock', locate.locateProcessSession(contracts.copilotProcess, home('copilot'), 5000))
  await check('copilot:invalid-pid', locate.locateProcessSession(contracts.copilotProcess, home('copilot'), 0))
  const lock = file(join(home('agy'), 'presence', `${id(13)}.lock`))
  const fd = join(fixture.root, 'proc', String(pid), 'fd'); mkdirSync(fd, { recursive: true })
  symlinkSync(lock, join(fd, '3'))
  symlinkSync(join(fixture.root, 'unrelated.lock'), join(fd, '4'))
  mkdirSync(join(fixture.root, 'proc', '5000', 'fd'), { recursive: true })
  await check('agy:held-lock', locate.locateProcessSession(contracts.agyProcess, home('agy'), pid))
  await check('agy:no-lock', locate.locateProcessSession(contracts.agyProcess, home('agy'), 5000))
  await check('agy:invalid-pid', locate.locateProcessSession(contracts.agyProcess, home('agy'), 0))
})

it('records pending transcript completion and cancellation through the eager discovery class', async () => {
  const { TranscriptDiscovery } = await import('./kit/transcriptDiscovery.js')
  const found: unknown[] = []
  const discovery = new TranscriptDiscovery(home('pending'), contracts.cursor, (session, path) => { found.push([session, path]) }, () => true, 10)
  const path = (n: number) => join(home('pending'), 'projects', 'project', 'agent-transcripts', id(n), `${id(n)}.jsonl`)
  try {
    file(path(21), '{}\n')
    await discovery.start(); await discovery.add(id(21)); await discovery.add(id(22)); await discovery.add(id(23))
    discovery.remove(id(23)); file(path(22), '{}\n'); file(path(23), '{}\n')
    await vi.waitFor(() => expect(found).toHaveLength(2), { timeout: 3000 })
    await discovery.stop()
    await check('discovery:found', found)
    await check('discovery:stopped', discovery.isPolling)
  } finally { await discovery.stop() }
})
it('has exactly the recorded observations', () => { if (!RECORD) expect(Object.keys(captured).sort()).toEqual(Object.keys(expected).sort()) })

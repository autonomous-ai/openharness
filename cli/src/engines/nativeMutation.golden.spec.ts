/** Healthy native model protocol, recorded from main before changing mutation recovery. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async original => ({
  ...await original<object>(),
  execFile: () => { throw Error('Host executables are forbidden in this golden') },
  execFileSync: () => { throw Error('Host executables are forbidden in this golden') },
  spawn: () => { throw Error('Host executables are forbidden in this golden') },
}))

const artifact = fileURLToPath(new URL('./__fixtures__/native-mutation.golden.json', import.meta.url))
const record = process.env.RECORD_NATIVE_MUTATION_GOLDEN === '1'
const observations: Record<string, unknown> = {}
const expected = record ? {} : JSON.parse(readFileSync(artifact, 'utf8'))

it.each(['linux', 'darwin'])('preserves the confirmed native model protocol on %s', async platform => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const root = mkdtempSync(join(tmpdir(), 'native-mutation-golden-'))
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-10T16:15:00Z') })
    for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DATA_DIR']) {
      const path = join(root, name); mkdirSync(path); vi.stubEnv(name, path)
    }
    vi.stubEnv('OPENCODE_PATH', '/fixture/bin/opencode'); vi.stubEnv('TZ', 'UTC'); vi.resetModules()
    const { applyOpencodeSessionModel } = await import('./launchControl.js')
    for (const checkCatalog of [false, true]) for (const variant of [false, true]) {
      const calls: unknown[] = []
      let model: unknown
      const result = await applyOpencodeSessionModel({ opencodeMajor: 2, dbPath: '/fixture/unused.db',
        sessionId: 'ses_fixture', model: { providerID: 'fixture', modelID: variant ? 'model#high' : 'model' },
        cwd: '/fixture/work', checkCatalog }, { run: async (args, options) => {
        calls.push({ args, options })
        if (args[1] === 'model.list') return { stdout: JSON.stringify({ data: [{ providerID: 'fixture', id: 'model' }] }) }
        if (args[1] === 'session.switchModel') { model = JSON.parse(args[args.indexOf('-d') + 1]!).model; return { stdout: '' } }
        if (args[1] === 'session.get') return { stdout: JSON.stringify({ data: { id: 'ses_fixture', model } }) }
        throw Error('Unexpected native command')
      } })
      const key = `${platform}:catalog=${checkCatalog}:variant=${variant}`
      observations[key] = { result, calls }
      if (!record) expect({ key, value: observations[key] }).toEqual({ key, value: expected[key] })
    }
  } finally {
    log.mockRestore(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules()
    Object.defineProperty(process, 'platform', descriptor)
    rmSync(root, { recursive: true, force: true })
  }
})

afterAll(() => {
  if (record) writeFileSync(artifact, JSON.stringify(observations, null, 2) + '\n')
  else expect(Object.keys(observations).sort()).toEqual(Object.keys(expected).sort())
})

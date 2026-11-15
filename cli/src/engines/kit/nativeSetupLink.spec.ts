import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServiceLinks, type ServiceFrame } from '../../core/serviceLinks.js'
import { createNativeSetupLink } from './nativeSetupLink.js'
import { executableIdentity, retainedExecutable } from './nativeExecutable.js'
import * as hookScript from './hookScript.js'

let root: string, file: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'setup-link-')); file = join(root, 'engine'); writeFileSync(file, 'fixture') })
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
const environment = { HOME: '/fixture', PATH: '/fixture/bin' }
const recipe = { command: 'fixture', source: 'fixture', executable: { names: ['fixture'] } }

it('accepts bounded probe data only while its exact executable remains current', async () => {
  const call = vi.fn(), link = createNativeSetupLink(call)
  const executable = retainedExecutable(file, executableIdentity(file)!)
  const output = { code: 0, stdout: '--help', stderr: '' }
  call.mockResolvedValue({ output })
  expect(await link.probe(executable, 'help', environment)).toEqual(output)
  for (const bad of [null, { ...output, code: 0.5 }, { ...output, stdout: 1 }, { ...output, stdout: 'x'.repeat(65_537) }, { ...output, stderr: 'x\0' }]) {
    call.mockResolvedValue({ output: bad }); expect(await link.probe(executable, 'help', environment)).toBeNull()
  }
  call.mockImplementationOnce(async () => { writeFileSync(file, 'replaced'); return { output } })
  expect(await link.probe(executable, 'help', environment)).toBeNull()
  call.mockClear(); expect(await link.probe(executable, 'help', environment)).toBeNull(); expect(call).not.toHaveBeenCalled()
  for (const answer of [{ major: 2, keepsRecord: false, downloading: true }, { major: -1, keepsRecord: 1, downloading: 'yes' }, {}]) {
    call.mockResolvedValue(answer)
    expect(await link.opencodeMajor()).toBe(answer.major === 2 ? 2 : null)
    expect(await link.hermesKeepsRecord(executable, environment)).toBe(answer.keepsRecord === false ? false : null)
    expect(await link.hermesKeepsRecord()).toBe(answer.keepsRecord === false ? false : null)
    expect(await link.downloading('codex')).toBe(answer.downloading === true)
  }
})

it('holds malformed or late installation replies and never authorizes a cancelled launch', async () => {
  const call = vi.fn(), link = createNativeSetupLink(call)
  const ensure = (current = () => true) => link.installations.ensure('codex', recipe, environment, 'r', current)
  const status = (current = () => true) => link.installations.status('codex', 'r', current)
  expect(await ensure(() => false)).toMatchObject({ complete: false }); expect(await status(() => false)).toMatchObject({ complete: false })
  expect(call).not.toHaveBeenCalled()
  for (const installation of [undefined, { complete: false, detail: 3 }, { complete: false, detail: '', running: false },
    { complete: false, detail: '', failed: false }, { complete: false, detail: '', running: true, failed: true }]) {
    call.mockResolvedValue({ installation }); expect(await ensure()).toEqual({ complete: false, detail: 'Waiting for engine setup.' })
  }
  for (const installation of [{ complete: true }, { complete: false, detail: 'Installing.', running: true }, { complete: false, detail: 'Failed.', failed: true }]) {
    call.mockResolvedValue({ installation }); expect(await ensure()).toEqual(installation); expect(await status()).toEqual(installation)
  }
  call.mockResolvedValue({ installation: null }); expect(await status()).toBeNull()
  let current = true
  call.mockImplementation(async () => { current = false; return { installation: { complete: true } } })
  expect(await status(() => current)).toMatchObject({ complete: false })
  current = true; expect(await ensure(() => current)).toMatchObject({ complete: false })
  current = true
  call.mockImplementationOnce(async () => { current = false; return { preparation: 'p' } }).mockResolvedValue({ installation: { complete: true } })
  expect(await ensure(() => current)).toMatchObject({ complete: false })
  expect(call).toHaveBeenLastCalledWith('setup_commit', { preparation: 'p', engine: 'codex', request: 'r', allowed: false })
  current = true
  call.mockResolvedValueOnce({ preparation: 'p' }).mockResolvedValue({ installation: { complete: true } })
  expect(await ensure(() => current)).toEqual({ complete: true })
})

it('uses generic service deadlines and generation fencing for off, frozen, killed and replaced setup', async () => {
  vi.useFakeTimers()
  const lines: string[] = [], token = 't'.repeat(48), frames: ServiceFrame[] = []
  const links = createServiceLinks({ token, owned: { engineSetup: [] }, answer: () => ({}), timeoutMs: 100,
    startWaitMs: 100, onDemand: new Set(['engineSetup']), waitsThroughRestart: new Set(['engineSetup']), want: vi.fn(), log: line => lines.push(line) })
  const setup = createNativeSetupLink((type, payload) => links.call('engineSetup', type, payload))
  expect(links.route('setup_capture', {}, { local: true, owner: true }, vi.fn())).toBe(false)
  const off = setup.opencodeMajor(); await vi.advanceTimersByTimeAsync(100)
  expect(await off).toBeNull()
  const old = links.accept('engineSetup', token, { sendFrame: frame => { frames.push(frame); return true } }, vi.fn())!
  const frozen = setup.opencodeMajor(); await vi.advanceTimersByTimeAsync(100)
  expect(await frozen).toBeNull()
  const killed = setup.opencodeMajor(); old.closed(); expect(await killed).toBeNull()
  const waiting = setup.opencodeMajor()
  const next = links.accept('engineSetup', token, { sendFrame: frame => { frames.push(frame); return true } }, vi.fn())!
  const requestId = frames.at(-1)!.payload!.requestId
  old.receive({ type: 'setup_version_result', payload: { requestId, major: 99 } })
  next.receive({ type: 'setup_version_result', payload: { requestId, major: 2 } })
  expect(await waiting).toBe(2)
  expect(lines.length).toBeGreaterThan(0); next.closed()
})

it('keeps file candidates behind the original owner and bounded indexed destinations', async () => {
  const input = { engine: 'claude' as const, environment, port: 1234,
    files: [{ file: '/fixture/settings.json', directory: '/fixture', content: '{}' }] }
  const candidate = { version: 1, files: [{ index: 0, content: '{"hooks":{}}' }] }
  const call = vi.fn().mockResolvedValueOnce({ preparation: 'files-token' }).mockResolvedValue({ files: candidate })
  const link = createNativeSetupLink(call)
  expect(await link.prepareFiles!(input, 'r-files', () => true)).toEqual(candidate)
  expect(call).toHaveBeenNthCalledWith(1, 'setup_files_prepare', { request: 'r-files', ...input })
  expect(call).toHaveBeenLastCalledWith('setup_files_commit', { preparation: 'files-token',
    engine: 'claude', request: 'r-files', allowed: true })

  for (const files of [null, { ...candidate, version: 2 }, { ...candidate, files: [] },
    { ...candidate, files: [{ index: 1, content: '{}' }] },
    { ...candidate, files: [{ index: 0, content: '{}', file: '/another-profile/settings.json' }] },
    { ...candidate, files: [{ index: 0, content: 'x'.repeat(1024 * 1024 + 1) }] }]) {
    call.mockResolvedValueOnce({ preparation: 'files-token' }).mockResolvedValueOnce({ files })
    expect(await link.prepareFiles!(input, 'r-files', () => true)).toBeNull()
  }
  call.mockClear()
  expect(await link.prepareFiles!(input, 'r-files', () => false)).toBeNull()
  expect(call).not.toHaveBeenCalled()
  let current = true
  call.mockImplementationOnce(async () => { current = false; return { preparation: 'files-token' } })
    .mockResolvedValueOnce({ files: candidate })
  expect(await link.prepareFiles!(input, 'r-files', () => current)).toBeNull()
  expect(call).toHaveBeenLastCalledWith('setup_files_commit', { preparation: 'files-token',
    engine: 'claude', request: 'r-files', allowed: false })
  current = true
  call.mockResolvedValueOnce({ preparation: 'files-token' }).mockImplementationOnce(async () => {
    current = false; return { files: candidate }
  })
  expect(await link.prepareFiles!(input, 'r-files', () => current)).toBeNull()
})

it('holds file preparation with an old worker without calling its executable installer', async () => {
  const call = vi.fn(async (_type: string, _payload: Record<string, unknown>) => ({ error: 'SERVICE_REQUEST_UNAVAILABLE' }))
  const link = createNativeSetupLink(call)
  expect(await link.prepareFiles!({ engine: 'codex', environment, port: 1234,
    files: [{ file: '/fixture/hooks.json', directory: '/fixture', content: '{}' }] }, 'old-worker', () => true)).toBeNull()
  expect(call).toHaveBeenCalledOnce()
  expect(call.mock.calls[0]![0]).toBe('setup_files_prepare')
})

it('retains a missing-script refusal only for the current caller’s engine', async () => {
  const refused = vi.spyOn(hookScript, 'noteMissingHookScript').mockImplementation(() => {})
  const input = { engine: 'codex' as const, environment, port: 1234,
    files: [{ file: '/fixture/hooks.json', directory: '/fixture', content: '{}' }] }
  try {
    const link = createNativeSetupLink(async () => ({ files: null, error: 'HOOK_SCRIPT_MISSING' }))
    expect(await link.prepareFiles!(input, 'missing', () => true)).toBeNull()
    expect(refused).toHaveBeenCalledExactlyOnceWith('codex')
    let current = true
    const stale = createNativeSetupLink(async () => { current = false; return { files: null, error: 'HOOK_SCRIPT_MISSING' } })
    expect(await stale.prepareFiles!(input, 'stale', () => current)).toBeNull()
    expect(refused).toHaveBeenCalledOnce()
  } finally { refused.mockRestore() }
})

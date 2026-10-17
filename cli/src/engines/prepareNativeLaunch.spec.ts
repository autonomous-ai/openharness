import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { engineDownloading } from './kit/downloadMarker.js'
import { createNativeLaunchPreparer } from './prepareNativeLaunch.js'
import type { NativeLaunch, NativeLaunchResult } from './nativeLaunch.js'

const absent: NativeLaunchResult = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Not installed',
  install: { command: 'fixture-installer', source: 'fixture', executable: { names: ['fixture'] } }, environment: { HOME: '/fixture/home', PATH: '/fixture/bin' } }
const ready: NativeLaunchResult = { ok: true, launch: { current: () => true } as NativeLaunch }
/** No Desktop download running. */
const none = async () => false
it('installs under the saved request and requires a fresh post-install snapshot', async () => {
  const ensure = vi.fn().mockResolvedValueOnce({ complete: false, detail: 'Installation in progress' }).mockResolvedValue({ complete: true })
  const inspect = vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(absent).mockResolvedValue(ready)
  const prepare = createNativeLaunchPreparer({ downloading: none, installations: { ensure, status: vi.fn(async () => null) }, inspect })
  const authority = { id: 'fixture-request', current: () => true }
  expect(await prepare('opencode', {}, authority)).toMatchObject({ ok: false, detail: 'Installation in progress' })
  expect(await prepare('opencode', {}, authority)).toBe(ready)
  expect(ensure.mock.calls.map(args => args[3])).toEqual(['fixture-request', 'fixture-request'])
  expect(inspect).toHaveBeenCalledTimes(3)
})
it('does not install on uncertain executable evidence and revokes every asynchronous continuation', async () => {
  const ensure = vi.fn().mockResolvedValue({ complete: true })
  const inspect = vi.fn().mockResolvedValue({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Unreadable executable' })
  const prepare = createNativeLaunchPreparer({ downloading: none, installations: { ensure, status: vi.fn(async () => null) }, inspect })
  let current = true
  const authority = { id: 'fixture-request', current: () => current }
  expect(await prepare('codex', {}, authority)).toMatchObject({ detail: 'Unreadable executable' })
  expect(ensure).not.toHaveBeenCalled()
  current = false
  expect(await prepare('codex', {}, authority)).toMatchObject({ ok: false })
  expect(inspect).toHaveBeenCalledOnce()
  current = true
  inspect.mockImplementationOnce(async () => { current = false; return absent })
  expect(await prepare('codex', {}, authority)).toMatchObject({ ok: false })
  expect(ensure).not.toHaveBeenCalled()
  current = true
  inspect.mockResolvedValue(absent)
  ensure.mockImplementationOnce(async () => { current = false; return { complete: true } })
  expect(await prepare('codex', {}, authority)).toMatchObject({ ok: false })
  expect(inspect).toHaveBeenCalledTimes(3)
  current = true
  inspect.mockResolvedValueOnce(absent).mockImplementationOnce(async () => { current = false; return ready })
  expect(await prepare('codex', {}, authority)).toMatchObject({ ok: false })
})

it('does not mistake a newly visible executable for its still-running installer’s completion', async () => {
  const ensure = vi.fn(async () => ({ complete: false as const, detail: 'Installing' }))
  const status = vi.fn().mockResolvedValueOnce({ complete: false, detail: 'Installer still unconfirmed' }).mockResolvedValue({ complete: true })
  const inspect = vi.fn().mockResolvedValueOnce(absent).mockResolvedValue(ready)
  const prepare = createNativeLaunchPreparer({ downloading: none, installations: { ensure, status }, inspect })
  const authority = { id: 'fixture-original-request', current: () => true }
  expect(await prepare('codex', {}, authority)).toMatchObject({ ok: false, detail: 'Installing' })
  expect(await prepare('codex', {}, authority)).toMatchObject({ ok: false, detail: 'Installer still unconfirmed' })
  expect(await prepare('codex', {}, authority)).toBe(ready)
  expect(ensure).toHaveBeenCalledOnce()
  expect(status).toHaveBeenCalledWith('codex', authority.id, authority.current)
})

it('holds an executable that cannot run while its installer is unsettled, and refuses it only after', async () => {
  const broken: NativeLaunchResult = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Codex is installed but cannot run: fixture', refusal: 'ENGINE_CANNOT_RUN' }
  const status = vi.fn().mockResolvedValueOnce({ complete: false, detail: 'Waiting for the saved installer to settle.' }).mockResolvedValue(null)
  const prepare = createNativeLaunchPreparer({ downloading: none, installations: { ensure: vi.fn(), status }, inspect: vi.fn(async () => broken) })
  const authority = { id: 'fixture-request', current: () => true }
  expect(await prepare('codex', {}, authority)).toEqual({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting for the saved installer to settle.' })
  expect(await prepare('codex', {}, authority)).toBe(broken)
})

it('names the engine it is installing, and refuses a launch whose own installer failed', async () => {
  const ensure = vi.fn().mockResolvedValueOnce({ complete: false, running: true, detail: 'Installing the required engine.' })
    .mockResolvedValueOnce({ complete: false, failed: true, detail: 'npm error network request failed' })
  const status = vi.fn().mockResolvedValueOnce({ complete: false, running: true, detail: 'Waiting for the saved installer to settle.' })
    .mockResolvedValueOnce({ complete: false, failed: true, detail: 'its installer exited with status 1' })
  const inspect = vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(absent).mockResolvedValue(ready)
  const prepare = createNativeLaunchPreparer({ downloading: none, installations: { ensure, status }, inspect })
  const authority = { id: 'fixture-request', current: () => true }
  const installing = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', installing: true,
    detail: 'Installing Claude Code. The harness starts once it is installed.' }
  expect(await prepare('claude', {}, authority)).toEqual(installing)
  expect(await prepare('codex', {}, authority)).toEqual({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native',
    refusal: 'ENGINE_INSTALL_FAILED', detail: 'Codex could not be installed: npm error network request failed' })
  // The executable is there, its installer not yet settled or settled with a failure.
  expect(await prepare('claude', {}, authority)).toEqual(installing)
  expect(await prepare('codex', {}, authority)).toMatchObject({ refusal: 'ENGINE_INSTALL_FAILED', detail: 'Codex could not be installed: its installer exited with status 1' })
})

/**
 * Desktop Harness downloading the engine as a fresh computer sets up (desktop/lib/bootstrap/agent_prefetch.dart),
 * with real markers in a private home and real processes: the Desktop's npm named on its command line, one that
 * took over a stale marker's pid, one that is gone. Never the person's own `~/.harness`.
 */
describe('while Desktop Harness downloads the engine', () => {
  let home: string
  const children: ChildProcess[] = []
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'prepare-download-')); mkdirSync(join(home, '.harness', 'run'), { recursive: true }) })
  afterEach(() => { for (const child of children.splice(0)) child.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }) })
  /** A process that runs until the test ends, named as the Desktop names its download, or not. */
  const running = async (...argv: string[]): Promise<number> => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...argv], { stdio: 'ignore' })
    children.push(child)
    await new Promise(done => child.once('spawn', done))
    return child.pid!
  }
  const mark = (engine: string, pid: number) => writeFileSync(join(home, '.harness', 'run', `downloading-${engine}`), String(pid))
  const gone = async (): Promise<number> => {
    const child = spawn(process.execPath, ['-e', '', 'harness-download'], { stdio: 'ignore' })
    await new Promise(done => child.once('exit', done))
    return child.pid!
  }
  const prepare = (inspect: () => Promise<NativeLaunchResult>, ensure = vi.fn(async () => ({ complete: true as const }))) => ({
    ensure,
    prepare: createNativeLaunchPreparer({ installations: { ensure, status: vi.fn(async () => null) }, inspect: vi.fn(inspect),
      downloading: engine => engineDownloading(engine, home) }),
  })
  const authority = { id: 'fixture-request', current: () => true }
  const downloading = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', installing: true,
    detail: 'Downloading Codex. The harness starts once it is downloaded.' }

  it('holds a missing engine as an install while the download runs, and installs nothing beside it', async () => {
    mark('codex', await running('harness-download'))
    const { prepare: launch, ensure } = prepare(async () => absent)
    expect(await launch('codex', {}, authority)).toEqual(downloading)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('holds an engine that fails its check while the download runs, rather than refusing what npm has written so far', async () => {
    mark('claude', await running('harness-download'))
    const broken: NativeLaunchResult = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native',
      detail: 'Claude Code is installed but cannot run: Error: Cannot find module', refusal: 'ENGINE_CANNOT_RUN' }
    const { prepare: launch } = prepare(async () => broken)
    expect(await launch('claude', {}, authority)).toEqual({ ...downloading, detail: 'Downloading Claude Code. The harness starts once it is downloaded.' })
    // The download is another engine's: this one is refused as before.
    expect(await launch('codex', {}, authority)).toBe(broken)
  })

  it('holds what a probe that began during the download says against it, even when the download has ended since', async () => {
    // The probe started while npm was writing; npm finished and the Desktop removed its marker before it answered.
    const broken: NativeLaunchResult = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native',
      detail: 'Codex is installed but cannot run: Error: Cannot find module', refusal: 'ENGINE_CANNOT_RUN' }
    const marker = join(home, '.harness', 'run', 'downloading-codex')
    mark('codex', await running('harness-download'))
    const ensure = vi.fn(async () => ({ complete: true as const }))
    for (const answer of [broken, absent]) {
      const launch = createNativeLaunchPreparer({ installations: { ensure, status: vi.fn(async () => null) },
        inspect: async () => { rmSync(marker); return answer }, downloading: engine => engineDownloading(engine, home) })
      expect(await launch('codex', {}, authority)).toEqual(downloading)
      mark('codex', await running('harness-download'))
    }
    expect(ensure).not.toHaveBeenCalled()
    // A check that cannot answer is no download: as before.
    const unanswered = createNativeLaunchPreparer({ installations: { ensure, status: vi.fn(async () => null) }, inspect: async () => broken,
      downloading: async () => { throw Error('fixture') } })
    expect(await unanswered('codex', {}, authority)).toBe(broken)
  })

  it('goes on as before for a marker whose process is gone or is not the download', async () => {
    const { prepare: launch, ensure } = prepare(async () => absent)
    mark('codex', await gone())
    await launch('codex', {}, authority)
    expect(ensure).toHaveBeenCalledOnce()
    // A stale marker's pid taken over by another process.
    mark('codex', await running('something-else'))
    await launch('codex', {}, authority)
    expect(ensure).toHaveBeenCalledTimes(2)
  })

  it.each([true, false])('neither holds nor installs for a request whose authority went while it looked (downloading: %s)', async (live) => {
    mark('codex', live ? await running('harness-download') : await gone())
    let current = true
    const ensure = vi.fn()
    const launch = createNativeLaunchPreparer({ installations: { ensure, status: vi.fn(async () => null) }, inspect: async () => absent,
      downloading: async engine => { const answer = await engineDownloading(engine, home); current = false; return answer } })
    expect(await launch('codex', {}, { id: 'fixture-request', current: () => current }))
      .toEqual({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Waiting for the original launch request’s authority.' })
    expect(ensure).not.toHaveBeenCalled()
  })
})

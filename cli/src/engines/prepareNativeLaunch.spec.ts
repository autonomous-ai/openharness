import { expect, it, vi } from 'vitest'
import { createNativeLaunchPreparer } from './prepareNativeLaunch.js'
import type { NativeLaunch, NativeLaunchResult } from './nativeLaunch.js'

const absent: NativeLaunchResult = { ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Not installed',
  install: { command: 'fixture-installer', source: 'fixture', executable: { names: ['fixture'] } }, environment: { HOME: '/fixture/home', PATH: '/fixture/bin' } }
const ready: NativeLaunchResult = { ok: true, launch: { current: () => true } as NativeLaunch }
it('retains the original rearm token across installation and repeated executable inspection', async () => {
  const authority = { id: 'fixture-request', current: () => true, launchToken: 'fixture-original-rearm-token' }
  const inspect = vi.fn().mockResolvedValueOnce(absent).mockResolvedValue(ready)
  const ensure = vi.fn(async () => { authority.launchToken = 'fixture-unrelated-rearm-token'; return { complete: true as const } })
  const prepare = createNativeLaunchPreparer({ installations: { ensure, status: vi.fn(async () => null) }, inspect })
  expect(await prepare('cursor', {}, authority)).toBe(ready)
  expect(inspect.mock.calls.map(args => args[2])).toEqual([
    { launchToken: 'fixture-original-rearm-token' }, { launchToken: 'fixture-original-rearm-token' },
  ])
})
it('installs under the saved request and requires a fresh post-install snapshot', async () => {
  const ensure = vi.fn().mockResolvedValueOnce({ complete: false, detail: 'Installation in progress' }).mockResolvedValue({ complete: true })
  const inspect = vi.fn().mockResolvedValueOnce(absent).mockResolvedValueOnce(absent).mockResolvedValue(ready)
  const prepare = createNativeLaunchPreparer({ installations: { ensure, status: vi.fn(async () => null) }, inspect })
  const authority = { id: 'fixture-request', current: () => true }
  expect(await prepare('opencode', {}, authority)).toMatchObject({ ok: false, detail: 'Installation in progress' })
  expect(await prepare('opencode', {}, authority)).toBe(ready)
  expect(ensure.mock.calls.map(args => args[3])).toEqual(['fixture-request', 'fixture-request'])
  expect(inspect).toHaveBeenCalledTimes(3)
})
it('does not install on uncertain executable evidence and revokes every asynchronous continuation', async () => {
  const ensure = vi.fn().mockResolvedValue({ complete: true })
  const inspect = vi.fn().mockResolvedValue({ ok: false, error: 'NATIVE_LAUNCH_HELD', unavailable: 'native', detail: 'Unreadable executable' })
  const prepare = createNativeLaunchPreparer({ installations: { ensure, status: vi.fn(async () => null) }, inspect })
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
  const prepare = createNativeLaunchPreparer({ installations: { ensure, status }, inspect })
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
  const prepare = createNativeLaunchPreparer({ installations: { ensure: vi.fn(), status }, inspect: vi.fn(async () => broken) })
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
  const prepare = createNativeLaunchPreparer({ installations: { ensure, status }, inspect })
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

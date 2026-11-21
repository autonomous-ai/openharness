import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveBinaryOnPath } from '../lib/binaryOnPath.js'
import { isWsl, macClipboardScript, startClipboardOwner } from './pasteClipboardNative.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('../lib/binaryOnPath.js', () => ({ resolveBinaryOnPath: vi.fn(() => '/private-fixture/clipboard') }))

function fixture() {
  const child = new EventEmitter() as ChildProcess
  const stdout = new EventEmitter(), stderr = new EventEmitter(), tie = new PassThrough()
  const released: Buffer[] = []
  tie.on('data', (bytes: Buffer) => released.push(bytes))
  Object.assign(child, { pid: 27182, stdout, stderr, stdio: [null, stdout, stderr, tie] })
  vi.mocked(spawn).mockReturnValue(child)
  const file = { path: '/private-fixture/image.png', descriptor: 42, current: vi.fn(() => true), close: vi.fn() }
  return { child, stdout, stderr, tie, released, file,
    end: (code = 0) => { child.emit('exit', code); stdout.emit('end'); stderr.emit('end'); child.emit('close', code) } }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.mocked(resolveBinaryOnPath).mockReturnValue('/private-fixture/clipboard')
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers() })

describe('native clipboard process ownership', () => {
  it('keeps Windows, WSL, headless Linux and missing native tools on the path fallback', async () => {
    for (const options of [{ platform: 'win32' as const }, { platform: 'linux' as const, env: {} },
      { platform: 'linux' as const, env: { WSL_DISTRO_NAME: 'fixture', DISPLAY: ':fixture' } },
      { platform: 'linux' as const, env: { DISPLAY: ':fixture' }, kernel: 'microsoft' }]) {
      const f = fixture(), owner = startClipboardOwner(f.file, options)
      expect(await owner.ready).toEqual({ state: 'unavailable', reason: 'PASTE_CLIPBOARD_UNAVAILABLE' })
      await owner.settled; owner.cancel(); expect(f.file.close).toHaveBeenCalledOnce()
    }
    vi.mocked(resolveBinaryOnPath).mockReturnValue(null)
    const f = fixture(), owner = startClipboardOwner(f.file, { platform: 'linux', env: { WAYLAND_DISPLAY: 'fixture' } })
    expect(await owner.ready).toMatchObject({ state: 'unavailable' }); await owner.settled
    expect(spawn).not.toHaveBeenCalled()
    expect(isWsl({}, '6.8.0-generic')).toBe(false)
    expect(isWsl({}, 'microsoft-standard-WSL2')).toBe(true)
  })

  it.each(['DISPLAY', 'WAYLAND_DISPLAY'] as const)('keeps the %s fork owned after launcher readiness until inherited pipes end', async (display) => {
    const f = fixture(), owner = startClipboardOwner(f.file, { platform: 'linux', env: { [display]: 'fixture' } })
    expect(f.file.current).toHaveBeenCalledOnce(); expect(f.file.close).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith('/bin/sh', expect.arrayContaining(['/private-fixture/clipboard']),
      expect.objectContaining({ detached: true, stdio: [42, 'pipe', 'pipe', 'pipe'] }))
    let settled = false
    void owner.settled.then(() => { settled = true })
    f.child.emit('exit', 0)
    expect(await owner.ready).toEqual({ state: 'written' })
    expect(settled).toBe(false); expect(f.released).toEqual([])
    f.stdout.emit('end')
    expect(f.released).toEqual([])
    f.stderr.emit('end')
    expect(Buffer.concat(f.released).toString()).toBe('\n')
    f.child.emit('close', 0); await owner.settled
    expect(settled).toBe(true); owner.cancel()
    expect(process.kill).not.toHaveBeenCalled()
  })

  it('uses only descriptor bytes and a private named pasteboard in the native fixture variant', async () => {
    const f = fixture(), owner = startClipboardOwner(f.file, { platform: 'darwin', privateBoard: 'fixture-board' })
    const args = vi.mocked(spawn).mock.calls[0][1] as string[]
    expect(args).toContain('/usr/bin/osascript')
    expect(args.at(-1)).toContain('initWithFileDescriptorCloseOnDealloc(0, true)')
    expect(args.at(-1)).toContain('pasteboardWithName')
    expect(args.at(-1)).not.toContain('generalPasteboard')
    expect(args.at(-1)).not.toContain(f.file.path)
    expect(macClipboardScript()).toContain('generalPasteboard')
    f.end(); expect(await owner.ready).toEqual({ state: 'written' }); await owner.settled
  })

  it('kills its still-owned group on cancellation and waits for its actual close', async () => {
    const f = fixture(), owner = startClipboardOwner(f.file, { platform: 'linux', env: { DISPLAY: ':fixture' } })
    f.child.emit('exit', 0); await owner.ready
    owner.cancel()
    expect(process.kill).toHaveBeenCalledWith(-27182, 'SIGKILL')
    let settled = false; void owner.settled.then(() => { settled = true })
    expect(settled).toBe(false)
    f.stdout.emit('end'); f.stderr.emit('end'); f.child.emit('close', 0)
    await owner.settled; expect(settled).toBe(true)
  })

  it('times out preparation without claiming its child has settled', async () => {
    const f = fixture(), owner = startClipboardOwner(f.file, { platform: 'darwin' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await owner.ready).toEqual({ state: 'failed', reason: 'PASTE_CLIPBOARD_TIMEOUT' })
    expect(process.kill).toHaveBeenCalledWith(-27182, 'SIGKILL')
    f.end(1); await owner.settled
  })

  it('bounds combined stdout/stderr and never returns native diagnostics', async () => {
    const f = fixture(), owner = startClipboardOwner(f.file, { platform: 'darwin' })
    f.stdout.emit('data', Buffer.alloc(32 * 1024)); f.stderr.emit('data', Buffer.alloc(32 * 1024 + 1, 115))
    expect(await owner.ready).toEqual({ state: 'failed', reason: 'PASTE_CLIPBOARD_OUTPUT_LIMIT' })
    f.end(1); await owner.settled
  })

  it.each(['changed', 'spawn', 'error', 'exit', 'close'] as const)('reports a static failure for %s and closes the parent descriptor once', async (cause) => {
    const f = fixture()
    if (cause === 'changed') f.file.current.mockReturnValue(false)
    if (cause === 'spawn') vi.mocked(spawn).mockImplementation(() => { throw new Error('private path') })
    const owner = startClipboardOwner(f.file, { platform: 'darwin' })
    if (cause === 'error') f.child.emit('error', new Error('private path'))
    if (cause === 'exit') f.child.emit('exit', 1)
    if (cause === 'close' || cause === 'error' || cause === 'exit') f.end(1)
    expect(await owner.ready).toEqual({ state: 'failed', reason: 'PASTE_CLIPBOARD_FAILED' })
    await owner.settled; owner.cancel()
    expect(f.file.close).toHaveBeenCalledOnce()
  })
  it.each(['fallback', 'spawned', 'spawn-failed'] as const)('keeps an unconfirmed descriptor charged for %s', async (phase) => {
    const f = fixture()
    f.file.close.mockImplementation(() => { throw new Error('close failed') })
    if (phase === 'spawn-failed') vi.mocked(spawn).mockImplementation(() => { throw new Error('spawn failed') })
    const owner = startClipboardOwner(f.file, { platform: phase === 'fallback' ? 'win32' : 'darwin' })
    expect(await owner.ready).toEqual({ state: 'failed', reason: 'PASTE_CLIPBOARD_FD_CLOSE_FAILED' })
    let settled = false; void owner.settled.then(() => { settled = true })
    owner.cancel(); f.end(1); await Promise.resolve()
    expect(settled).toBe(false); expect(f.file.close).toHaveBeenCalledOnce()
  })

  it.each(['ESRCH', 'EPERM'] as const)('retains actual settlement and reports a non-absence group failure (%s)', async (code) => {
    const f = fixture(), log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('private'), { code }) })
    const owner = startClipboardOwner(f.file, { platform: 'darwin' })
    owner.cancel(); owner.cancel()
    expect(process.kill).toHaveBeenCalledOnce()
    expect(log.mock.calls).toEqual(code === 'ESRCH' ? [] : [['[paste] PASTE_CLIPBOARD_STOP_FAILED · EPERM']])
    f.end(1); await owner.settled
  })

  it('settles a child without pipes and ignores a closed tie error', async () => {
    const f = fixture()
    Object.assign(f.child, { stdout: null, stderr: null })
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    // Exercise the default host selection without depending on the runner's display server.
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    try {
      const owner = startClipboardOwner(f.file)
      expect(spawn).toHaveBeenCalledWith('/bin/sh', expect.arrayContaining(['/usr/bin/osascript']), expect.any(Object))
      f.tie.emit('error', new Error('closed'))
      f.child.emit('error', new Error('spawn failed'))
      f.end(1); await owner.settled
      expect(await owner.ready).toEqual({ state: 'failed', reason: 'PASTE_CLIPBOARD_FAILED' })
    } finally { Object.defineProperty(process, 'platform', platform) }
  })

  it('never kills after its watcher was released but before child close is observed', async () => {
    const f = fixture(), owner = startClipboardOwner(f.file, { platform: 'darwin' })
    f.child.emit('exit', 0); f.stdout.emit('end'); f.stderr.emit('end')
    owner.cancel(); expect(process.kill).not.toHaveBeenCalled()
    f.child.emit('close'); await owner.settled
  })

})

import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TmuxControlStream } from './tmuxStream.js'

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}))

afterEach(() => vi.resetAllMocks())

function controlClient(holdAttach = false) {
  const metadata = '$1|@1|1|80|24|80|24|0|0|0|1|0|0|0|0|0\n'
  const child = new EventEmitter() as {
    -readonly [K in keyof ChildProcessWithoutNullStreams]: ChildProcessWithoutNullStreams[K]
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  let failed = false
  let command = 1
  let attached = false
  let detachedAnotherClient = false
  const exit = () => {
    if (child.exitCode != null) return
    child.exitCode = 0
    child.emit('close', 0)
  }
  child.kill = () => { exit(); return true }
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const number = command++
      setImmediate(() => {
        if (failed) {
          // A dead control client's pipe reports this asynchronously, outside
          // any try/catch around stdin.write().
          callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
          setImmediate(exit)
          return
        }
        callback()
        if (chunk.toString().startsWith('detach-client')) {
          // tmux's cmd_find_current_client falls back to another attached client before this one
          // has a session. The unattached client remains ours to close.
          if (!attached) detachedAnotherClient = true
          else exit()
          return
        }
        child.stdout.emit('data', Buffer.from(`%begin 1 ${number} 0\n${metadata}%end 1 ${number} 0\n`))
      })
    },
    final(callback) {
      callback(failed ? Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) : undefined)
      setImmediate(exit)
    },
  })
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, stdout: Buffer) => void
    callback(null, Buffer.from(metadata))
    return child
  }) as typeof execFile)
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => {
      child.emit('spawn')
      if (!holdAttach) setImmediate(() => {
        attached = true
        child.stdout.emit('data', Buffer.from('%begin 1 0 0\n%end 1 0 0\n'))
      })
    })
    return child
  })
  return { breakPipe: () => { failed = true }, detachedAnotherClient: () => detachedAnotherClient }
}

describe('tmux control pipe failure', () => {
  it('closing a watcher before its attach completes never detaches the window already driving the pane', async () => {
    // Found by QA on a quiet machine: windows.e2e lost its persistent controller as a new watcher
    // disconnected. Hold the attach reply so cleanup runs in that exact interval.
    const client = controlClient(true)
    const onClose = vi.fn()
    const opened = await TmuxControlStream.open('%1', { cols: 80, rows: 24 }, { onData: () => {}, onClose }, true)
    expect(opened.state).toBe('succeeded')
    if (opened.state !== 'succeeded') return
    await opened.value.close()
    expect(client.detachedAnotherClient()).toBe(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  for (const action of ['input', 'close'] as const) {
    it(`contains an asynchronous broken pipe during ${action}`, async () => {
      const client = controlClient()
      const onClose = vi.fn()
      const opened = await TmuxControlStream.open('%1', { cols: 80, rows: 24 }, {
        onData: () => {}, onClose,
      })
      expect(opened.state).toBe('succeeded')
      if (opened.state !== 'succeeded') return
      client.breakPipe()
      if (action === 'input') {
        expect((await opened.value.writeRaw(Buffer.from('hello'))).state).not.toBe('succeeded')
      }
      await opened.value.close()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  }
})

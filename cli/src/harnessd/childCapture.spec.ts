import { EventEmitter, once } from 'node:events'
import { Writable } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { captureChild } from './childCapture.js'

const childWith = (stdin: unknown) => Object.assign(new EventEmitter(), {
  pid: 4242, stdin, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
})

describe('bounded trusted stdin delivery', () => {
  it('executes its fixed code with JSON-encoded data through a real stdin pipe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'captured-stdin-'))
    try {
      const data = { path: '"; process.exit(7); //\n$outside' }
      const input = `const data = ${JSON.stringify(data)}; process.stdout.write(JSON.stringify(data))`
      const env = { HOME: home, USERPROFILE: home, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }
      const result = await captureChild(process.execPath, ['--input-type=module'], env, 5_000, undefined, input).result
      expect(result).toMatchObject({ started: true, code: 0, failure: null, err: '' })
      expect(JSON.parse(result.out)).toEqual(data)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('queues EOF after backpressure and retains ownership until the actual close', async () => {
    let drain!: () => void
    const chunks: string[] = []
    const stdin = new Writable({ highWaterMark: 1, write(chunk, _encoding, done) { chunks.push(String(chunk)); drain = done } })
    const child = childWith(stdin)
    const running = captureChild('node', [], {}, 1_000, () => child as unknown as ChildProcess, 'trusted-source')
    const settled = vi.fn(); void running.result.then(settled)
    expect(chunks).toEqual(['trusted-source'])
    expect(stdin.writableFinished).toBe(false)
    running.cancel()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(settled).not.toHaveBeenCalled()
    const finished = once(stdin, 'finish'); drain(); await finished
    expect(settled).not.toHaveBeenCalled()
    child.emit('close', null, 'SIGKILL')
    expect(await running.result).toMatchObject({ started: true, signal: 'SIGKILL' })
  })

  it.each(['throw', 'event', 'missing'])('retains a child through stdin failure: %s', async kind => {
    const stdin = kind === 'missing' ? null : Object.assign(new EventEmitter(), {
      end: () => { if (kind === 'throw') throw new Error('private input detail') },
    })
    const child = childWith(stdin)
    const running = captureChild('node', [], {}, 1_000, () => child as unknown as ChildProcess, 'trusted-source')
    if (kind === 'event') stdin!.emit('error', new Error('private input detail'))
    const settled = vi.fn(); void running.result.then(settled)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(settled).not.toHaveBeenCalled()
    child.emit('close', null, 'SIGKILL')
    expect(await running.result).toMatchObject({ failure: 'child stdin delivery failed' })
  })
})

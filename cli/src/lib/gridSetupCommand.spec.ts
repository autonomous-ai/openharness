import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { gridSetupCommand, type GridSetupDeps } from './gridSetupCommand.js'
import type { NewSocket } from './newCommand.js'

/** The daemon's loopback socket: `connected` on select, then one answer per request. */
class FakeSocket extends EventEmitter implements NewSocket {
  sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  closed = false
  constructor(private answer: (frame: { type: string; payload: Record<string, unknown> }) => Record<string, unknown>) {
    super()
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, listener: (...args: any[]) => void): this {
    super.on(event, listener)
    if (event === 'open') queueMicrotask(() => this.emit('open'))
    return this
  }
  send(data: string): void {
    const frame = JSON.parse(data) as { type: string; payload: Record<string, unknown> }
    this.sent.push(frame)
    queueMicrotask(() => {
      if (frame.type === 'machine_select') { this.emit('message', JSON.stringify({ type: 'connected', payload: {} })); return }
      this.emit('message', JSON.stringify({ type: `${frame.type}_result`, payload: { ...this.answer(frame), requestId: frame.payload.requestId } }))
    })
  }
  close(): void { this.closed = true }
}

function deps(socket: FakeSocket, over: Partial<GridSetupDeps> = {}): GridSetupDeps & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    port: 1, localMachineId: 'this-mac', daemonRunning: () => true, connect: () => socket,
    output: (line) => out.push(line), error: (line) => err.push(line), timeoutMs: 200, out, err, ...over,
  }
}

describe('harness grid setup', () => {
  it('asks the daemon for the Set up the models picker asks for, on this computer', async () => {
    const socket = new FakeSocket(() => ({ models: [] }))
    const run = deps(socket)
    expect(await gridSetupCommand(run)).toBe(0)
    expect(socket.sent.map((frame) => frame.type)).toEqual(['machine_select', 'grid_fleet_models_list'])
    expect(socket.sent[0]!.payload.machineId).toBe('this-mac')
    expect(socket.sent[1]!.payload.setup).toBe(true)
    expect(run.out.join('\n')).toContain('Grid is set up on this computer')
    expect(socket.closed).toBe(true)
  })

  it("says why in the daemon's words when the set-up did not finish", async () => {
    const socket = new FakeSocket(() => ({ models: [], gridSetupNeeded: true, gridSetupError: 'Grid could not be installed. Check the internet connection.' }))
    const run = deps(socket)
    expect(await gridSetupCommand(run)).toBe(1)
    expect(run.err).toEqual(['Grid could not be installed. Check the internet connection.'])
    expect(run.out).toEqual([])
  })

  it('does not call a list that still needs a set-up a success', async () => {
    const run = deps(new FakeSocket(() => ({ models: [], gridSetupNeeded: true })))
    expect(await gridSetupCommand(run)).toBe(1)
    expect(run.err.join('\n')).toContain('could not be set up')
  })

  it('names the one step that is the person’s: a computer not signed in to Harness', async () => {
    const socket = new FakeSocket(() => ({}))
    const run = deps(socket, { localMachineId: null })
    expect(await gridSetupCommand(run)).toBe(1)
    expect(run.err.join('\n')).toContain('harness login')
    expect(socket.sent).toEqual([])
  })

  it('asks nothing of a daemon that is not running', async () => {
    const socket = new FakeSocket(() => ({}))
    const run = deps(socket, { daemonRunning: () => false })
    expect(await gridSetupCommand(run)).toBe(1)
    expect(run.err.join('\n')).toContain('harness start')
    expect(socket.sent).toEqual([])
  })
})

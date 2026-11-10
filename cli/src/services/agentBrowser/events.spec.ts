import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchEvents } from './events.js'
import type { Podman } from './podman.js'

type FakeChild = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }

/** podman.spawn hands back these instead of a process, so the spec drives the stream line by line and drops it at will. */
function stream() {
  const children: FakeChild[] = []
  const spawned: string[][] = []
  const podman = {
    spawn: vi.fn((args: string[]) => {
      spawned.push(args)
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }) as FakeChild
      children.push(child)
      return child as unknown as ChildProcess
    }),
  } as unknown as Podman
  return { podman, children, spawned }
}

// The spike's own lines (Podman 5.8.1), trimmed: exec and exec_died come hundreds a minute while a viewer is open.
const event = (status: string, agent: string, daemon = 'd1', exitCode = 137) => JSON.stringify({
  ContainerExitCode: exitCode, ID: '5cce206ab3bd', Image: 'localhost/harness-browser:1', Name: `harness-browser-${agent}`,
  Status: status, time: 1794294142, Type: 'container', Attributes: { 'harness.agent': agent, 'harness.daemon': daemon },
})

const lines = async (child: FakeChild, ...text: string[]) => {
  child.stdout.write(text.map(line => `${line}\n`).join(''))
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('watchEvents', () => {
  it('streams container exits of this daemon only', async () => {
    const { podman, children, spawned } = stream()
    const exited = vi.fn()
    const watch = watchEvents(podman, 'd1', { exited, reconnected: vi.fn() })
    expect(spawned).toEqual([['events', '--format', 'json', '--filter', 'event=died', '--filter', 'label=harness.daemon=d1']])
    await lines(children[0]!,
      event('exec', 'a1'), event('exec_died', 'a1'), event('died', 'a1'), event('died', 'a5', 'd2'),
      'not json', JSON.stringify({ Status: 'died', Type: 'container' }),
      JSON.stringify({ Status: 'died', Type: 'container', Attributes: { 'harness.daemon': 'd1' } }), event('died', 'a2'))
    expect(exited.mock.calls).toEqual([['a1'], ['a2']])
    watch.close()
  })

  it('a dropped stream restarts with backoff (1 s, doubling, capped at 30 s) and calls reconnected', async () => {
    const { podman, children } = stream()
    const reconnected = vi.fn()
    const watch = watchEvents(podman, 'd1', { exited: vi.fn(), reconnected })
    const waits: number[] = []
    for (let drop = 0; drop < 7; drop++) {
      children.at(-1)!.emit('close', 1)
      const count = children.length
      let waited = 0
      while (children.length === count) {
        await vi.advanceTimersByTimeAsync(1_000)
        waited += 1_000
      }
      waits.push(waited)
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
    expect(reconnected).toHaveBeenCalledTimes(7)
    // A stream that stayed up a while starts the backoff over.
    await vi.advanceTimersByTimeAsync(60_000)
    children.at(-1)!.emit('error', new Error('spawn podman ENOENT'))
    children.at(-1)!.emit('close', 1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children).toHaveLength(9)
    watch.close()
  })

  it('a spawn that throws is retried the same way', async () => {
    const { podman, children } = stream()
    vi.mocked(podman.spawn).mockImplementationOnce(() => { throw new Error('Podman is not installed') })
    const reconnected = vi.fn()
    const watch = watchEvents(podman, 'd1', { exited: vi.fn(), reconnected })
    expect(children).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children).toHaveLength(1)
    expect(reconnected).toHaveBeenCalledTimes(1)
    watch.close()
  })

  it('close() kills the child and nothing restarts', async () => {
    const { podman, children } = stream()
    const watch = watchEvents(podman, 'd1', { exited: vi.fn(), reconnected: vi.fn() })
    watch.close()
    expect(children[0]!.kill).toHaveBeenCalledOnce()
    children[0]!.emit('close', null)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(children).toHaveLength(1)
    // Closed while waiting to restart: the restart never comes.
    const again = stream()
    const second = watchEvents(again.podman, 'd1', { exited: vi.fn(), reconnected: vi.fn() })
    again.children[0]!.emit('close', 1)
    second.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(again.children).toHaveLength(1)
  })
})

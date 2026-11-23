// The extension wired to a fake VS Code API and inputs of this file's own: never the developer's own VS Code or harness.
import { describe, expect, it } from 'vitest'
import { MISSING, type LoopInputs } from './inputs'
import { fakeVscode } from './testing/fakeVscode'
import { wire } from './wire'

// Every input here answers in a promise, so once the queue of them is drained the loop has done all it can.
const flush = () => new Promise<void>((done) => setImmediate(done))

/** Inputs with no launcher, or, `held`, a launcher whose run lasts until the loop aborts it. A clock that never moves. */
function inputs(platform: string, launcher: 'missing' | 'held' = 'missing') {
  const runs: AbortSignal[] = []
  const timers = new Set<() => void>()
  const given: LoopInputs = {
    platform,
    home: '/h',
    path: '/usr/bin:/bin',
    windowId: 'a1b2c3d4-0000-4000-8000-123456789abc',
    run(_file, _args, { signal }) {
      runs.push(signal)
      if (launcher === 'missing') return Promise.resolve(MISSING)
      return new Promise((settle) => signal.addEventListener('abort', () => settle(null)))
    },
    connect: () => Promise.resolve(null),
    post: () => Promise.resolve(null),
    watch: () => () => {},
    now: () => 0,
    after(_ms, run) {
      timers.add(run)
      return () => {
        timers.delete(run)
      }
    },
  }
  return { given, runs, timers }
}

describe('wire', () => {
  it('in a remote window nothing is made, on any platform: no channel, no listener', async () => {
    for (const platform of ['darwin', 'win32']) {
      const vscode = fakeVscode({ remoteName: 'ssh-remote' })
      vscode.open()
      const world = inputs(platform)
      const stop = wire(vscode.api, world.given)
      await flush()

      expect(vscode.channels).toEqual([])
      expect(vscode.listeners()).toBe(0)
      expect(world.runs).toEqual([])
      await stop()
    }
  })

  it("the channel is named Harness Device and gets the loop's lines, nothing else", async () => {
    const vscode = fakeVscode()
    const stop = wire(vscode.api, inputs('darwin').given)
    await flush()

    expect(vscode.channels.map(({ name, lines }) => ({ name, lines }))).toEqual([{ name: 'Harness Device', lines: ['state: noHarness'] }])
    await stop()
  })

  it('on Windows the loop starts: it looks for harness and says what it found in the channel', async () => {
    const vscode = fakeVscode()
    const world = inputs('win32')
    const stop = wire(vscode.api, world.given)
    await flush()

    expect([world.runs.length, vscode.channels.map(({ name, lines }) => ({ name, lines }))]).toEqual([
      2,
      [{ name: 'Harness Device', lines: ['state: noHarness'] }],
    ])
    await stop()
  })

  it("stop disposes the channel and the window's listeners, and stops the loop", async () => {
    const vscode = fakeVscode()
    const world = inputs('darwin', 'held')
    const stop = wire(vscode.api, world.given)
    await flush()
    expect(world.runs.length).toBe(1)
    expect(vscode.listeners()).toBeGreaterThan(0)

    await stop()

    expect(world.runs[0].aborted).toBe(true)
    expect(world.timers.size).toBe(0)
    expect(vscode.listeners()).toBe(0)
    expect(vscode.channels.map(({ lines, disposed }) => ({ lines, disposed }))).toEqual([{ lines: [], disposed: true }])
  })
})

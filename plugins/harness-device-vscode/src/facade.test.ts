// The window read from VS Code's API, against a fake of it: never the developer's own VS Code.
import { describe, expect, it } from 'vitest'
import { windowFacade } from './facade'
import { fakeVscode } from './testing/fakeVscode'
import type { ApiTerminal } from './vscodeApi'

// A processId resolves in a promise, so once the queue is drained the facade has heard every answer.
const flush = () => new Promise<void>((done) => setImmediate(done))

function watched(options: { remoteName?: string } = {}) {
  const vscode = fakeVscode(options)
  const facade = windowFacade(vscode.api)
  let changes = 0
  facade.onChange(() => changes++)
  return { vscode, facade, changes: () => changes }
}

describe('windowFacade', () => {
  it("a terminal is listed once its shell's pid resolves, and the change is told", async () => {
    const vscode = fakeVscode()
    const before = vscode.open()
    const facade = windowFacade(vscode.api)
    let changes = 0
    facade.onChange(() => changes++)
    const after = vscode.open()
    expect(facade.state().terminals).toEqual([])

    after.resolve(202)
    await flush()
    expect(facade.state().terminals).toEqual([202])
    expect(changes).toBe(1)

    before.resolve(101)
    await flush()
    expect(facade.state().terminals).toEqual([101, 202])
    expect(changes).toBe(2)
  })

  it('a terminal whose pid resolves undefined is never listed', async () => {
    const w = watched()
    w.vscode.open().resolve(undefined)
    await flush()
    expect(w.facade.state().terminals).toEqual([])
  })

  it('a terminal that closed leaves, and the change is told', async () => {
    const w = watched()
    const shell = w.vscode.open()
    shell.resolve(101)
    await flush()
    w.vscode.close(shell.terminal)
    expect(w.facade.state().terminals).toEqual([])
    expect(w.changes()).toBe(2)
  })

  // VS Code keeps the Terminal when it relaunches its shell (an environment change, Relaunch Active Terminal, a task's
  // terminal used again), and its processId answers the new shell's pid.
  it.each([
    ['its state changes', (vscode: ReturnType<typeof fakeVscode>, relaunched: ApiTerminal) => vscode.changeState(relaunched)],
    ['it becomes active', (vscode: ReturnType<typeof fakeVscode>, relaunched: ApiTerminal) => vscode.activate(relaunched)],
    ['another terminal opens', (vscode: ReturnType<typeof fakeVscode>) => void vscode.open()],
    ['another terminal closes', (vscode: ReturnType<typeof fakeVscode>) => vscode.close(vscode.open().terminal)],
    // VS Code 1.75 flips a terminal's state only once, so a relaunch there can come with no terminal event at all.
    ["the window's focus changes", (vscode: ReturnType<typeof fakeVscode>) => vscode.focus(true)],
  ])("a terminal whose shell was relaunched is listed and shown by the new shell's pid once %s, and the change is told", async (_case, event) => {
    const w = watched()
    const shell = w.vscode.open()
    shell.resolve(101)
    await flush()
    const heard: number[][] = []
    w.facade.onChange(() => heard.push(w.facade.state().terminals))
    shell.relaunch(202)
    event(w.vscode, shell.terminal)
    await flush()
    expect([w.facade.state().terminals, heard.at(-1)]).toEqual([[202], [202]])
    expect([w.facade.show(101), w.facade.show(202), shell.shown]).toEqual([false, true, [false]])
  })

  it('a terminal event that finds every pid as it was tells nothing more', async () => {
    const w = watched()
    const shell = w.vscode.open()
    shell.resolve(101)
    await flush()
    w.vscode.changeState(shell.terminal)
    await flush()
    expect([w.facade.state().terminals, w.changes()]).toEqual([[101], 1])
  })

  it("the active terminal is its shell's pid, null while that is not known", async () => {
    const w = watched()
    const shell = w.vscode.open()
    w.vscode.activate(shell.terminal)
    expect(w.facade.state().active).toBeNull()
    expect(w.changes()).toBe(1)

    shell.resolve(101)
    await flush()
    expect(w.facade.state().active).toBe(101)
    w.vscode.activate(undefined)
    expect(w.facade.state().active).toBeNull()
    expect(w.changes()).toBe(3)
  })

  it('gaining and losing focus is told', () => {
    const w = watched()
    w.vscode.focus(true)
    expect(w.facade.state().focused).toBe(true)
    w.vscode.focus(false)
    expect(w.facade.state().focused).toBe(false)
    expect(w.changes()).toBe(2)
  })

  it('show calls Terminal.show(false) on the terminal with that shell; false for a pid no terminal has', async () => {
    const w = watched()
    const first = w.vscode.open()
    const second = w.vscode.open()
    first.resolve(101)
    second.resolve(202)
    await flush()
    expect(w.facade.show(202)).toBe(true)
    expect(second.shown).toEqual([false])
    expect(first.shown).toEqual([])
    expect(w.facade.show(303)).toBe(false)
    expect(first.shown.length + second.shown.length).toBe(1)
  })

  it("scrollLine runs the terminal's scrollUp or scrollDown, once", async () => {
    const w = watched()
    await w.facade.scrollLine(true)
    expect(w.vscode.commands).toEqual(['workbench.action.terminal.scrollUp'])
    await w.facade.scrollLine(false)
    expect(w.vscode.commands).toEqual(['workbench.action.terminal.scrollUp', 'workbench.action.terminal.scrollDown'])
  })

  it('raise runs workbench.action.focusWindow, once', () => {
    const w = watched()
    w.facade.raise()
    expect(w.vscode.commands).toEqual(['workbench.action.focusWindow'])
  })

  it('on a VS Code without workbench.action.focusWindow, raise throws nothing and rejects nothing', async () => {
    const vscode = fakeVscode({ missing: ['workbench.action.focusWindow'] })
    const facade = windowFacade(vscode.api)
    facade.raise()
    // A rejection left unhandled would fail the run.
    await flush()
    expect(vscode.commands).toEqual(['workbench.action.focusWindow'])
  })

  it('a processId that rejects lists nothing and throws nothing', async () => {
    const w = watched()
    w.vscode.open().reject()
    await flush()
    expect(w.facade.state().terminals).toEqual([])
    expect(w.changes()).toBe(0)
  })

  it('remote is true with a remoteName', () => {
    expect(windowFacade(fakeVscode({ remoteName: 'ssh-remote' }).api).remote).toBe(true)
    expect(windowFacade(fakeVscode().api).remote).toBe(false)
  })

  it('dispose takes every listener back', async () => {
    const w = watched()
    expect(w.vscode.listeners()).toBe(5)
    const shell = w.vscode.open()
    w.facade.dispose()
    expect(w.vscode.listeners()).toBe(0)
    // A pid that resolves after the dispose tells no one.
    shell.resolve(101)
    await flush()
    expect(w.changes()).toBe(0)
  })
})

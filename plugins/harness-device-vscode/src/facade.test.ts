// The window read from VS Code's API, against a fake of it: never the developer's own VS Code.
import { describe, expect, it } from 'vitest'
import { windowFacade } from './facade'
import { fakeVscode } from './testing/fakeVscode'

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
    expect(w.vscode.listeners()).toBe(4)
    const shell = w.vscode.open()
    w.facade.dispose()
    expect(w.vscode.listeners()).toBe(0)
    // A pid that resolves after the dispose tells no one.
    shell.resolve(101)
    await flush()
    expect(w.changes()).toBe(0)
  })
})

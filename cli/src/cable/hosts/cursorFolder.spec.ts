import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Place } from './adapter.js'
import { createCursorFolderAdapter, isFolder, type CursorFolderDeps } from './cursorFolder.js'

const CURSOR = 'com.todesktop.230313mzl4w4u92'
const MARKER = '/work/SECRET-FOLDER-MARKER'
/** Cursor's CLI as its Linux package installs it (testing/recordedLinuxApps.ts). */
const CLI = '/usr/share/cursor/bin/cursor'

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording runner that runs nothing, so no spec opens the developer's own Cursor: each call answers the next of
 *  [codes] (null: it was killed or never started), then exit 0. A folder is there only once added to [folders]. Cursor's
 *  CLI is [CLI], each look at it counted in [clis]. */
function rig(over: Partial<CursorFolderDeps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const folders = new Set<string>()
  const clis = vi.fn((): string | null => CLI)
  const deps: CursorFolderDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0, stdout: '' }
    },
    platform: 'darwin',
    isFolder: (path) => folders.has(path),
    cli: clis,
    ...over,
  }
  return { calls, folders, clis, adapter: createCursorFolderAdapter(deps) }
}

const place = (over: Partial<Place> = {}): Place => ({ host: 'cursor', app: 'cursor', hints: {}, engine: 'cursor', cwd: '/work/api', ...over })
const pane = (id: string) => ({ adapter: 'cursor-folder', id })
const opened = (folder: string, file = '/usr/bin/open'): Call => ({ file, args: ['-b', CURSOR, folder], timeoutMs: 10_000 })
/** Paths a hook may send that are no folder Cursor should open: each is out of form whether or not it is there. */
const OUT_OF_FORM: Array<[string, string]> = [
  ['an empty one', ''],
  ['a relative one', 'work/api'],
  ['one from here', './api'],
  ['a word', 'work'],
  ['a flag', '--args'],
  ['one with a newline', '/work/a\nb'],
  ['one with a tab', '/work/a\tb'],
  ['one with a NUL', '/work/a\u0000b'],
  ['one with the last C0 control', '/work/a\u001fb'],
  ['one with a DEL', '/work/a\u007fb'],
  // The C1 controls are control characters too (Unicode's Cc), as the spec's "no control character" says.
  ['one with the first C1 control', '/work/a\u0080b'],
  ['one with a NEL', '/work/a\u0085b'],
  ['one with the last C1 control', '/work/a\u009fb'],
  ['one of 4097 characters', `/${'a'.repeat(4096)}`],
]

describe('the Cursor folder adapter', () => {
  it('its id is cursor-folder, a tap is its own open, its bundle is Cursor\'s, and it shows, scrolls and types nothing', () => {
    const { adapter } = rig()
    expect([adapter.id, adapter.tap, adapter.bundle]).toEqual(['cursor-folder', 'instead', CURSOR])
    for (const verb of ['canShow', 'show', 'canScroll', 'onScreen', 'scroll', 'pageKeys', 'canType', 'type', 'paneKey'] as const) {
      expect(adapter[verb], verb).toBeUndefined()
    }
  })

  it('the pane of an agent in Cursor is its folder, whatever its engine; in another app there is none', () => {
    const { adapter } = rig()
    for (const engine of ['cursor', 'claude', 'codex', 'opencode', undefined]) {
      expect(adapter.paneOf(place({ engine })), engine).toEqual(pane('/work/api'))
    }
    expect(adapter.paneOf(place({ app: 'vscode', host: 'vscode' }))).toBeUndefined()
    // The app decides, never a hint: a hook that names Cursor's bundle from another app gets no folder window.
    expect(adapter.paneOf(place({ app: 'terminal-app', hints: { __CFBundleIdentifier: CURSOR } }))).toBeUndefined()
  })

  it('a place with no folder gives no pane', () => {
    expect(rig().adapter.paneOf(place({ cwd: undefined }))).toBeUndefined()
  })

  it.each(OUT_OF_FORM)('a folder that is %s gives no pane, even one that is there', (_, cwd) => {
    const { adapter, folders } = rig()
    folders.add(cwd)
    expect(adapter.paneOf(place({ cwd }))).toBeUndefined()
  })

  it('a folder of exactly 4096 characters gives its pane, and a tap opens it', async () => {
    const longest = `/${'a'.repeat(4095)}`
    const { adapter, calls, folders } = rig()
    folders.add(longest)
    expect(adapter.paneOf(place({ cwd: longest }))).toEqual(pane(longest))
    expect(await adapter.focus(pane(longest))).toBe(true)
    expect(calls).toEqual([opened(longest)])
  })

  it('a tap opens Cursor on the folder: one open, the path one argument, in 10 s', async () => {
    // A no-break space, just past the C1 controls, is a letter of a name and no control.
    for (const folder of ['/work/my proj/ü', '/work/-rf', '/work/a;b $(x) `y`', '/work/a b']) {
      const { adapter, calls, folders } = rig()
      folders.add(folder)
      // The path reaches open as the hook named it: no part of it is cut, quoted or read as a flag.
      expect(adapter.paneOf(place({ cwd: folder })), folder).toEqual(pane(folder))
      expect(adapter.canFocus(pane(folder)), folder).toBe(true)
      expect(await adapter.focus(pane(folder)), folder).toBe(true)
      expect(calls, folder).toEqual([opened(folder)])
    }
  })

  it('HARNESS_OPEN_BIN, absolute, is the open it runs; a relative one is never looked up', async () => {
    for (const [bin, file] of [['/tmp/e2e/fake-open', '/tmp/e2e/fake-open'], ['fake-open', '/usr/bin/open']]) {
      const { adapter, calls, folders } = rig({ bin })
      folders.add('/work/api')
      expect(await adapter.focus(pane('/work/api')), bin).toBe(true)
      expect(calls, bin).toEqual([opened('/work/api', file)])
    }
  })

  it('a folder that is not there cannot be tapped, and a tap that finds it gone runs nothing', async () => {
    const { adapter, calls, folders } = rig()
    expect(adapter.canFocus(pane('/work/api'))).toBe(false)
    expect(await adapter.focus(pane('/work/api'))).toBe(false)
    folders.add('/work/api')
    expect(adapter.canFocus(pane('/work/api'))).toBe(true)
    // Gone, or become a file, between the look and the tap.
    folders.delete('/work/api')
    expect(await adapter.focus(pane('/work/api'))).toBe(false)
    expect(calls).toEqual([])
  })

  it('an open that exits non-zero, was killed, or rejects answers false', async () => {
    for (const codes of [[1], [null]]) {
      const { adapter, calls, folders } = rig({}, codes)
      folders.add('/work/api')
      expect(await adapter.focus(pane('/work/api')), String(codes)).toBe(false)
      expect(calls, String(codes)).toEqual([opened('/work/api')])
    }
    const { adapter, folders } = rig({ run: () => Promise.reject(new Error('spawn failed')) })
    folders.add('/work/api')
    expect(await adapter.focus(pane('/work/api'))).toBe(false)
  })

  it('an error that names the folder is caught: the tap answers false, nothing is thrown and nothing is said', async () => {
    const said = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    onTestFinished(() => { for (const spy of said) spy.mockRestore() })
    const failing = rig({ run: () => Promise.reject(new Error(`open ${MARKER} failed`)) })
    failing.folders.add(MARKER)
    await expect(failing.adapter.focus(pane(MARKER))).resolves.toBe(false)
    const unreadable = rig({ isFolder: () => { throw new Error(`stat ${MARKER} failed`) } })
    expect(unreadable.adapter.canFocus(pane(MARKER))).toBe(false)
    await expect(unreadable.adapter.focus(pane(MARKER))).resolves.toBe(false)
    expect(unreadable.calls).toEqual([])
    for (const spy of said) expect(spy).not.toHaveBeenCalled()
  })

  it('on a Mac Cursor\'s CLI is never looked for', async () => {
    const { adapter, clis, folders } = rig()
    folders.add('/work/api')
    expect(adapter.canFocus(pane('/work/api'))).toBe(true)
    expect(await adapter.focus(pane('/work/api'))).toBe(true)
    expect(clis).not.toHaveBeenCalled()
  })

  it('on Windows nothing can be tapped and nothing runs', async () => {
    const { adapter, calls, folders } = rig({ platform: 'win32' })
    folders.add('/work/api')
    expect(adapter.canFocus(pane('/work/api'))).toBe(false)
    expect(await adapter.focus(pane('/work/api'))).toBe(false)
    expect(calls).toEqual([])
  })

  it('a pane id not in its form runs nothing, even one that is there', async () => {
    for (const [what, id] of OUT_OF_FORM) {
      const { adapter, calls, folders } = rig()
      folders.add(id)
      expect(adapter.canFocus(pane(id)), what).toBe(false)
      expect(await adapter.focus(pane(id)), what).toBe(false)
      expect(calls, what).toEqual([])
    }
  })
})

describe('the Cursor folder adapter on Linux', () => {
  const ran = (folder: string): Call => ({ file: CLI, args: [folder], timeoutMs: 10_000 })

  it('a tap runs Cursor\'s CLI on the folder: one run, the path one argument, in 10 s; HARNESS_OPEN_BIN is not it', async () => {
    for (const folder of ['/work/api', '/work/my proj/ü', '/work/-rf', '/work/a;b $(x) `y`']) {
      const { adapter, calls, folders } = rig({ platform: 'linux', bin: '/tmp/e2e/fake-open' })
      folders.add(folder)
      expect(adapter.paneOf(place({ cwd: folder })), folder).toEqual(pane(folder))
      expect(adapter.canFocus(pane(folder)), folder).toBe(true)
      expect(await adapter.focus(pane(folder)), folder).toBe(true)
      expect(calls, folder).toEqual([ran(folder)])
    }
  })

  it('with no Cursor CLI the folder cannot be tapped and nothing runs', async () => {
    const { adapter, calls, folders } = rig({ platform: 'linux', cli: () => null })
    folders.add('/work/api')
    expect(adapter.canFocus(pane('/work/api'))).toBe(false)
    expect(await adapter.focus(pane('/work/api'))).toBe(false)
    expect(calls).toEqual([])
  })

  it('a folder that is not there, or a pane id not in its form, runs nothing', async () => {
    for (const [what, id] of [['gone', '/work/api'], ...OUT_OF_FORM]) {
      const { adapter, calls, folders } = rig({ platform: 'linux' })
      if (what !== 'gone') folders.add(id)
      expect(adapter.canFocus(pane(id)), what).toBe(false)
      expect(await adapter.focus(pane(id)), what).toBe(false)
      expect(calls, what).toEqual([])
    }
  })

  it('a run that exits non-zero, was killed, or rejects answers false', async () => {
    for (const codes of [[1], [null]]) {
      const { adapter, calls, folders } = rig({ platform: 'linux' }, codes)
      folders.add('/work/api')
      expect(await adapter.focus(pane('/work/api')), String(codes)).toBe(false)
      expect(calls, String(codes)).toEqual([ran('/work/api')])
    }
    const { adapter, folders } = rig({ platform: 'linux', run: () => Promise.reject(new Error(`spawn ${MARKER} failed`)) })
    folders.add('/work/api')
    expect(await adapter.focus(pane('/work/api'))).toBe(false)
  })
})

describe('isFolder', () => {
  it('a folder is one; a file and a path that is not there are not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-folder-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'notes.txt')
    writeFileSync(file, '')
    expect(isFolder(dir)).toBe(true)
    expect(isFolder(file)).toBe(false)
    expect(isFolder(join(dir, 'gone'))).toBe(false)
    // Under a file: stat fails with ENOTDIR, which is an answer, not a throw.
    expect(isFolder(join(file, 'inside'))).toBe(false)
  })
})

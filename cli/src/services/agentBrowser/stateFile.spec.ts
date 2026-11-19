import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from './settings.js'
import { StateFile } from './stateFile.js'

// Pass-through, recording each call that opens a file for writing, writes, flushes or renames a file by its name.
const disk = vi.hoisted(() => ({ events: [] as string[][], opened: new Map<number, string>() }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  const { O_WRONLY, O_RDWR } = actual.constants
  return { ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const flags = args[1]
      if (typeof flags === 'number' ? flags & (O_WRONLY | O_RDWR) : flags !== undefined && flags !== 'r') disk.events.push(['open', String(args[0])])
      const fd = actual.openSync(...args)
      disk.opened.set(fd, String(args[0]))
      return fd
    },
    fsyncSync: (fd: number) => { disk.events.push(['fsync', disk.opened.get(fd) ?? String(fd)]); return actual.fsyncSync(fd) },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => { disk.events.push(['write', String(args[0])]); return actual.writeFileSync(...args) },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { disk.events.push(['rename', String(args[0]), String(args[1])]); return actual.renameSync(...args) },
  }
})
/** The calls that named [file] itself; a fresh temporary name beside it (`<file>.<pid>.<uuid>.tmp`) shown as `<tmp>`. */
const touching = (file: string) => disk.events.filter((event) => event.includes(file)).map((event) => event.map((name) =>
  name.startsWith(`${file}.${process.pid}.`) && /^[0-9a-f-]{36}\.tmp$/.test(name.slice(`${file}.${process.pid}.`.length)) ? '<tmp>' : name))

const settings = defaultSettings({ timeZone: 'UTC', languages: 'en-US' })

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-browser-state-'))
  path = join(dir, 'agent-browser.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('StateFile', () => {
  it('a missing file reads as empty', () => {
    expect(new StateFile(path).read()).toEqual({ browsers: {}, deleting: [], setup: null })
  })

  it('update is atomic and 0600', () => {
    const file = new StateFile(path)
    file.update(s => { s.browsers.a1 = settings })
    file.update(s => { s.deleting.push('a2'); s.setup = { step: 'starting_podman' } })
    expect(file.read()).toEqual({ browsers: { a1: settings }, deleting: ['a2'], setup: { step: 'starting_podman' } })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    // Written beside and renamed over: no half-written file, and nothing left behind.
    expect(readdirSync(dir)).toEqual(['agent-browser.json'])
    const before = readFileSync(path, 'utf8')
    expect(() => file.update(() => { throw new Error('changed my mind') })).toThrow('changed my mind')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('a file with no told reads as nobody told, and update keeps a told it does not know', () => {
    writeFileSync(path, JSON.stringify({ browsers: { a1: settings }, deleting: [], setup: null }), { mode: 0o600 })
    const file = new StateFile(path)
    expect(file.read().told?.a1).toBeUndefined()
    file.update(s => { s.told = { a1: true } })
    file.update(s => { s.deleting.push('a2') })
    expect(file.read()).toEqual({ browsers: { a1: settings }, deleting: ['a2'], setup: null, told: { a1: true } })
  })

  it("an entry's profile is read back as written, and an entry without one is read as before", () => {
    // a2 took a1's browser with its pane; a3's never moved, and its entry is what an older CLI writes and reads.
    writeFileSync(path, JSON.stringify({ browsers: { a3: settings }, deleting: [], setup: null }), { mode: 0o600 })
    const file = new StateFile(path)
    file.update(s => { s.browsers.a2 = { ...settings, profile: 'a1' } })
    expect(file.read().browsers).toEqual({ a2: { ...settings, profile: 'a1' }, a3: settings })
    expect(file.read().browsers.a2!.profile).toBe('a1')
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).browsers.a3)).toEqual(Object.keys(settings))
  })

  it('a file that cannot be parsed throws state_unreadable and is not rewritten', () => {
    for (const broken of ['{"browsers": {', '[]', '{"browsers": {}, "deleting": "a1", "setup": null}']) {
      writeFileSync(path, broken)
      const file = new StateFile(path)
      expect(() => file.read()).toThrow(expect.objectContaining({ state: 'state_unreadable' }))
      expect(() => file.update(s => { s.deleting.push('a1') })).toThrow(expect.objectContaining({ state: 'state_unreadable' }))
      expect(readFileSync(path, 'utf8')).toBe(broken)
    }
  })

  // The file holds proxy passwords and is never rebuilt: a power cut must not leave it empty.
  it('a save flushes the new file before it is renamed onto agent-browser.json', () => {
    const file = new StateFile(path)
    disk.events = []
    file.update(s => { s.browsers.a1 = settings })
    const flushed = disk.events.findIndex(([op, name]) => op === 'fsync' && name.startsWith(`${path}.${process.pid}.`))
    const renamed = disk.events.findIndex(([op, , to]) => op === 'rename' && to === path)
    expect(flushed).toBeGreaterThan(-1)
    expect(flushed).toBeLessThan(renamed)
  })

  it.skipIf(process.platform === 'win32')('a file another account could have rewritten is not written over', () => {
    writeFileSync(path, JSON.stringify({ browsers: {}, deleting: [], setup: null }))
    chmodSync(path, 0o666)
    const before = readFileSync(path, 'utf8')
    expect(() => new StateFile(path).update(s => { s.browsers.a1 = settings })).toThrow('group/world writable')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  // browsers.ts logs this message: the path names the person, and JSON.parse quotes the file, a proxy password with it.
  it('a file that cannot be read is named by its base name and a fixed word, never its path or text', () => {
    writeFileSync(path, 'hunter2-proxy-password')
    expect(() => new StateFile(path).read()).toThrow(expect.objectContaining({ message: 'agent-browser.json cannot be read (not valid JSON)' }))
    writeFileSync(path, '[]')
    expect(() => new StateFile(path).read()).toThrow(expect.objectContaining({ message: 'agent-browser.json is not a browser state file' }))
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a file this account cannot read says why, by its base name', () => {
    writeFileSync(path, JSON.stringify({ browsers: {}, deleting: [], setup: null }))
    chmodSync(path, 0o000)
    expect(() => new StateFile(path).read()).toThrow(expect.objectContaining({ message: 'agent-browser.json cannot be read (EACCES)' }))
  })

  it('the save goes through a temporary file renamed onto the target', () => {
    const file = new StateFile(path)
    disk.events = []
    file.update(s => { s.browsers.a1 = settings })
    expect(touching(path)).toEqual([['rename', '<tmp>', path]])
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify({ browsers: { a1: settings }, deleting: [], setup: null }, null, 2)}\n`)
  })

  it('a file at the old temporary name is left alone', () => {
    const old = `${path}.${process.pid}.tmp`
    writeFileSync(old, 'not ours')
    new StateFile(path).update(s => { s.browsers.a1 = settings })
    expect(readFileSync(old, 'utf8')).toBe('not ours')
  })
})

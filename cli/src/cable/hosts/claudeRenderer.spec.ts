import { execFileSync } from 'node:child_process'
import { constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open as openFile, stat as statFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFullscreen, readSettings, settingsFiles, SETTINGS_MAX_BYTES, type SettingsFs } from './claudeRenderer.js'

// No test here reads a real settings file: readFullscreen's read is a fake keyed by path, or its files are under dir.
const opts = { defaultHome: '/h/.claude', platform: 'darwin' as const }
/** A session of an Orca account, whose Claude Code home is its own. */
const ORCA_TRANSCRIPT = '/o/claude-profiles/acct/home/projects/-work-api/s1.jsonl'
const MANAGED = '/Library/Application Support/ClaudeCode/managed-settings.json'
const LOCAL = '/work/api/.claude/settings.local.json'
const PROJECT = '/work/api/.claude/settings.json'
const USER = '/h/.claude/settings.json'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'renderer-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A read of these files alone, by path, that records what it was asked. */
const reading = (files: Record<string, string>) => vi.fn(async (path: string) => files[path])

describe('settingsFiles', () => {
  it('the four files, highest first', () => {
    expect(settingsFiles('/work/api', undefined, opts)).toEqual([MANAGED, LOCAL, PROJECT, USER])
    expect(settingsFiles('/work/api', undefined, { ...opts, platform: 'linux' })[0]).toBe('/etc/claude-code/managed-settings.json')
    expect(settingsFiles('/work/api', undefined, { ...opts, platform: 'win32' })).toEqual([LOCAL, PROJECT, USER])
  })

  it.each<[string, string | undefined, string]>([
    ['a transcript in an Orca account home: that home', ORCA_TRANSCRIPT, '/o/claude-profiles/acct/home/settings.json'],
    ['no transcript path: the default home', undefined, USER],
    ['an empty transcript path: the default home', '', USER],
    ['a transcript outside projects/<slug>/: the default home', '/o/home/sessions/-work-api/s1.jsonl', USER],
    ['a transcript one folder deeper: the default home', '/o/home/projects/-work-api/sub/s1.jsonl', USER],
    ['a relative transcript path: the default home', 'o/home/projects/-work-api/s1.jsonl', USER],
    ['a transcript that is no .jsonl: the default home', '/o/home/projects/-work-api/s1.json', USER],
    ['a transcript path with ..: the default home', '/o/home/projects/../projects/-work-api/s1.jsonl', USER],
    ['a transcript path with a doubled /: the default home', '/o//home/projects/-work-api/s1.jsonl', USER],
  ])('the user file, %s', (_, transcript, user) => {
    expect(settingsFiles('/work/api', transcript, opts).at(-1)).toBe(user)
  })
})

describe('readFullscreen', () => {
  it("a session in its own home is judged by that home's settings.json, never the default home's", async () => {
    const read = reading({ '/o/claude-profiles/acct/home/settings.json': '{"tui":"fullscreen"}', [USER]: '{"tui":"default"}' })
    expect(await readFullscreen('/work/api', ORCA_TRANSCRIPT, opts, read)).toBe(true)
    expect(read.mock.calls.map(([path]) => path)).not.toContain(USER)
  })

  it.each<[string, Record<string, string>, boolean]>([
    ['the user file alone says fullscreen', { [USER]: '{"tui":"fullscreen"}' }, true],
    ['the project file says default over the user fullscreen', { [PROJECT]: '{"tui":"default"}', [USER]: '{"tui":"fullscreen"}' }, false],
    ['the local file says fullscreen over the project default', { [LOCAL]: '{"tui":"fullscreen"}', [PROJECT]: '{"tui":"default"}' }, true],
    ['managed says default over all', { [MANAGED]: '{"tui":"default"}', [LOCAL]: '{"tui":"fullscreen"}' }, false],
    ['managed says fullscreen over all', { [MANAGED]: '{"tui":"fullscreen"}', [LOCAL]: '{"tui":"default"}' }, true],
    ['a file with no tui gives way', { [PROJECT]: '{"model":"x"}', [USER]: '{"tui":"fullscreen"}' }, true],
    ['bad JSON gives way', { [PROJECT]: '{"tui":', [USER]: '{"tui":"fullscreen"}' }, true],
    ['an array or a string is no object', { [PROJECT]: '["tui"]', [USER]: '"fullscreen"' }, false],
    ['null is no object', { [PROJECT]: 'null', [USER]: '{"tui":"fullscreen"}' }, true],
    ['a tui that is not the string decides, and refuses', { [PROJECT]: '{"tui":true}', [USER]: '{"tui":"fullscreen"}' }, false],
    ['a tui of another case decides, and refuses', { [PROJECT]: '{"tui":"Fullscreen"}', [USER]: '{"tui":"fullscreen"}' }, false],
    ['an inherited tui is none', { [USER]: '{"__proto__":{"tui":"fullscreen"}}' }, false],
    ['no file', {}, false],
  ])('%s', async (_, files, fullscreen) => {
    expect(await readFullscreen('/work/api', undefined, opts, reading(files))).toBe(fullscreen)
  })

  it('stops at the file that decides', async () => {
    const read = reading({ [LOCAL]: '{"tui":"fullscreen"}', [PROJECT]: '{"tui":"default"}', [USER]: '{"tui":"default"}' })
    expect(await readFullscreen('/work/api', undefined, opts, read)).toBe(true)
    expect(read.mock.calls.map(([path]) => path)).toEqual([MANAGED, LOCAL])
  })

  it('a read that rejects counts as no file, and nothing rejects', async () => {
    const files: Record<string, string> = { [USER]: '{"tui":"fullscreen"}' }
    const some = vi.fn(async (path: string) => {
      if (path === PROJECT) throw new Error('EACCES')
      return files[path]
    })
    expect(await readFullscreen('/work/api', undefined, opts, some)).toBe(true)
    const every = vi.fn(async (): Promise<string | undefined> => { throw new Error('EIO') })
    expect(await readFullscreen('/work/api', undefined, opts, every)).toBe(false)
    expect(every).toHaveBeenCalledTimes(4)
  })

  it("reads the session's real files by default", async () => {
    // win32 has no managed file, so nothing outside dir is opened.
    const project = join(dir, 'api')
    mkdirSync(join(project, '.claude'), { recursive: true })
    writeFileSync(join(project, '.claude', 'settings.json'), '{"tui":"fullscreen"}')
    const local = { defaultHome: join(dir, 'home'), platform: 'win32' as const }
    expect(await readFullscreen(project, undefined, local)).toBe(true)
    writeFileSync(join(project, '.claude', 'settings.local.json'), '{"tui":"default"}')
    expect(await readFullscreen(project, undefined, local)).toBe(false)
  })
})

describe('readSettings', () => {
  it('reads a file as it is', async () => {
    writeFileSync(join(dir, 'settings.json'), '{"tui":"fullscreen"}')
    expect(await readSettings(join(dir, 'settings.json'))).toBe('{"tui":"fullscreen"}')
  })

  it('reads a file of exactly 256 KiB', async () => {
    writeFileSync(join(dir, 'settings.json'), 'x'.repeat(SETTINGS_MAX_BYTES))
    expect((await readSettings(join(dir, 'settings.json')))?.length).toBe(SETTINGS_MAX_BYTES)
  })

  it('one byte past 256 KiB is none', async () => {
    writeFileSync(join(dir, 'settings.json'), 'x'.repeat(SETTINGS_MAX_BYTES + 1))
    expect(await readSettings(join(dir, 'settings.json'))).toBeUndefined()
  })

  it('a missing file and a folder are none', async () => {
    expect(await readSettings(join(dir, 'missing.json'))).toBeUndefined()
    mkdirSync(join(dir, 'settings.json'))
    expect(await readSettings(join(dir, 'settings.json'))).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('a FIFO is none, at once, with no writer', async () => {
    const fifo = join(dir, 'settings.json')
    execFileSync('mkfifo', [fifo])
    // Resolves: no writer is ever opened, and a blocking open would wait for one until the test's timeout.
    expect(await readSettings(fifo)).toBeUndefined()
  })

  it.skipIf(process.platform === 'win32')('a link to /dev/zero is none', async () => {
    symlinkSync('/dev/zero', join(dir, 'settings.json'))
    expect(await readSettings(join(dir, 'settings.json'))).toBeUndefined()
  })

  it.each<[string, () => Promise<{ isFile(): boolean }>]>([
    // A link to /dev/cu.* in a cloned project: opening a serial port toggles its DTR, which resets a board on it.
    ['a device', async () => ({ isFile: () => false })],
    ['a path that is not there', async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }],
  ])('%s is none, and never opened', async (_, stat) => {
    // A regular file is there: only the stat says otherwise, so a read that opened it anyway would give its text.
    writeFileSync(join(dir, 'settings.json'), '{"tui":"fullscreen"}')
    const open = vi.fn<SettingsFs['open']>((path, flags) => openFile(path, flags))
    expect(await readSettings(join(dir, 'settings.json'), { stat, open })).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  })

  it('a regular file is opened read-only, without waiting for a writer, and never as a controlling terminal', async () => {
    writeFileSync(join(dir, 'settings.json'), '{"tui":"fullscreen"}')
    const open = vi.fn<SettingsFs['open']>((path, flags) => openFile(path, flags))
    expect(await readSettings(join(dir, 'settings.json'), { stat: statFile, open })).toBe('{"tui":"fullscreen"}')
    expect(open.mock.calls).toEqual([[join(dir, 'settings.json'), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY]])
  })
})

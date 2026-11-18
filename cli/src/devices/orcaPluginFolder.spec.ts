/**
 * The folder Orca installs Harness Device's plugin from, in a throwaway data folder each. Orca reads it at an install
 * and copies it again at each update, so it is never half written: not by a crash, and not by two commands at once
 * (the app's status beside a person's connect).
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureOrcaPluginFolder } from './orcaPluginFolder.js'

// A copy of the module, so a test can watch, or break, the file calls a write makes.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

const FILES = {
  'orca-plugin.json': '{\n  "id": "harness-device"\n}\n',
  'src/plugin.ts': 'export const answer = 1\n',
  'src/panel/view.ts': 'export const view = "dial"\n',
}
/** What an earlier build wrote. */
const EARLIER = {
  'orca-plugin.json': '{\n  "id": "harness-device",\n  "version": "0.0.1"\n}\n',
  'src/old.ts': 'export const old = true\n',
}

const MODULE = pathToFileURL(fileURLToPath(new URL('./orcaPluginFolder.ts', import.meta.url))).href
const LOADER = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url))

const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const folder of folders.splice(0)) {
    // A test made it read-only: open it again so it can be removed.
    chmodSync(folder, 0o700)
    rmSync(folder, { recursive: true, force: true })
  }
})

function aDataDir(): string {
  const folder = mkdtempSync(join(tmpdir(), 'orca-plugin-folder-'))
  folders.push(folder)
  return folder
}

/** The plugin's folder in a data folder of its own. */
const aFolder = (): string => join(aDataDir(), 'orca-plugin')

/** What [folder] holds, by path: each file's text, and what else is there (a link, a folder with nothing in it). */
function contents(folder: string, prefix = ''): Record<string, string> {
  const found: Record<string, string> = {}
  for (const name of readdirSync(folder)) {
    const path = join(folder, name)
    const info = lstatSync(path)
    if (info.isDirectory()) {
      const inner = contents(path, `${prefix}${name}/`)
      if (Object.keys(inner).length === 0) found[`${prefix}${name}/`] = 'an empty folder'
      Object.assign(found, inner)
    } else {
      found[`${prefix}${name}`] = info.isFile() ? readFileSync(path, 'utf8') : `a link to ${readlinkSync(path)}`
    }
  }
  return found
}

/** [folder] is a real folder holding exactly [files], with nothing left beside it. */
function holdsOnly(folder: string, files: Record<string, string>): void {
  expect(lstatSync(folder).isDirectory()).toBe(true)
  expect(contents(folder)).toEqual(files)
  expect(readdirSync(dirname(folder))).toEqual(['orca-plugin'])
}

/** The ensure of another `harness device orca` command, in a process of its own: what it answered. */
function anotherCommand(folder: string, files: Record<string, string>): string {
  const script = `import { ensureOrcaPluginFolder } from ${JSON.stringify(MODULE)}
process.stdout.write(ensureOrcaPluginFolder(${JSON.stringify(folder)}, ${JSON.stringify(files)}))`
  const run = spawnSync(process.execPath, ['--import', LOADER, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 })
  return run.stdout
}

const watched = fs as unknown as Record<string, (...args: unknown[]) => unknown>

describe('the Orca plugin\'s folder', () => {
  it('a missing folder is written, 0700 and 0600, with nothing left beside it', () => {
    const folder = aFolder()

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('written')

    holdsOnly(folder, FILES)
    for (const path of [folder, join(folder, 'src'), join(folder, 'src/panel')]) expect(statSync(path).mode & 0o777, path).toBe(0o700)
    for (const key of Object.keys(FILES)) expect(statSync(join(folder, key)).mode & 0o777, key).toBe(0o600)
  })

  it('the same content writes nothing: the folder and each file keep their inodes', () => {
    const folder = aFolder()
    ensureOrcaPluginFolder(folder, FILES)
    const inodes = (): number[] => [folder, ...Object.keys(FILES).map((key) => join(folder, key))].map((path) => lstatSync(path).ino)
    const before = inodes()

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('same')

    expect(inodes()).toEqual(before)
  })

  it('a changed, extra, missing or unreadable file, a link, or a file where a folder belongs is written anew, and the extra is gone', () => {
    const changes: Record<string, (folder: string, elsewhere: string) => void> = {
      'a file changed at the same length': (folder) => writeFileSync(join(folder, 'src/plugin.ts'), 'export const answer = 2\n'),
      'an extra file': (folder) => writeFileSync(join(folder, 'src/extra.ts'), ''),
      'an extra folder': (folder) => mkdirSync(join(folder, 'src/extra')),
      'a missing file': (folder) => rmSync(join(folder, 'src/panel/view.ts')),
      'a file that cannot be read': (folder) => chmodSync(join(folder, 'src/plugin.ts'), 0o000),
      'a link to the same bytes': (folder, elsewhere) => {
        writeFileSync(join(elsewhere, 'plugin.ts'), FILES['src/plugin.ts'])
        rmSync(join(folder, 'src/plugin.ts'))
        symlinkSync(join(elsewhere, 'plugin.ts'), join(folder, 'src/plugin.ts'))
      },
      'a file where a folder belongs': (folder) => {
        rmSync(join(folder, 'src/panel'), { recursive: true })
        writeFileSync(join(folder, 'src/panel'), '')
      },
      'a folder where a file belongs': (folder) => {
        rmSync(join(folder, 'orca-plugin.json'))
        mkdirSync(join(folder, 'orca-plugin.json'))
      },
      'the folder a link to a whole copy': (folder, elsewhere) => {
        renameSync(folder, join(elsewhere, 'copy'))
        symlinkSync(join(elsewhere, 'copy'), folder)
      },
    }
    for (const [change, make] of Object.entries(changes)) {
      const folder = aFolder()
      const elsewhere = aDataDir()
      ensureOrcaPluginFolder(folder, FILES)
      make(folder, elsewhere)
      const outside = contents(elsewhere)

      expect(ensureOrcaPluginFolder(folder, FILES), change).toBe('written')

      holdsOnly(folder, FILES)
      // What a link pointed at is not the plugin's: it is left as it was.
      expect(contents(elsewhere), change).toEqual(outside)
    }
  })

  it('every file is on disk before the swap', () => {
    const folder = aFolder()
    ensureOrcaPluginFolder(folder, EARLIER)
    const calls: string[] = []
    for (const name of ['fsyncSync', 'renameSync']) {
      const real = watched[name]
      vi.spyOn(watched, name).mockImplementation((...args) => {
        calls.push(name)
        return real(...args)
      })
    }

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('written')

    expect(calls).toEqual([...Object.keys(FILES).map(() => 'fsyncSync'), 'renameSync', 'renameSync'])
  })

  it('an old folder with no folder is put back first', () => {
    const folder = aFolder()
    ensureOrcaPluginFolder(folder, FILES)
    const inode = lstatSync(folder).ino
    renameSync(folder, `${folder}.old`)

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('same')

    expect(lstatSync(folder).ino).toBe(inode)
    holdsOnly(folder, FILES)
  })

  it('an old folder beside a whole one is removed', () => {
    const folder = aFolder()
    ensureOrcaPluginFolder(folder, FILES)
    mkdirSync(`${folder}.old`)
    writeFileSync(join(`${folder}.old`, 'orca-plugin.json'), EARLIER['orca-plugin.json'])

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('same')

    holdsOnly(folder, FILES)
  })

  it('a new folder a crash left is removed; one a running command writes is left alone', () => {
    const folder = aFolder()
    const gone = spawnSync(process.execPath, ['-e', '']).pid
    const running = process.ppid
    for (const pid of [gone, running]) {
      mkdirSync(`${folder}.new.${pid}`)
      writeFileSync(join(`${folder}.new.${pid}`, 'orca-plugin.json'), '{')
    }

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('written')

    expect(contents(folder)).toEqual(FILES)
    expect(readdirSync(dirname(folder)).sort()).toEqual(['orca-plugin', `orca-plugin.new.${running}`])
  })

  it('a swap whose second rename fails answers failed and puts the earlier folder back whole', () => {
    const folder = aFolder()
    ensureOrcaPluginFolder(folder, EARLIER)
    const inode = lstatSync(folder).ino
    const real = watched.renameSync
    let failed = false
    vi.spyOn(watched, 'renameSync').mockImplementation((from, to) => {
      if (!failed && String(from).startsWith(`${folder}.new`)) {
        failed = true
        throw Object.assign(new Error('rename failed'), { code: 'EIO' })
      }
      return real(from, to)
    })

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('failed')

    expect(failed).toBe(true)
    expect(lstatSync(folder).ino).toBe(inode)
    holdsOnly(folder, EARLIER)
  })

  it('a parent that cannot be written answers failed and leaves the folder as it was', () => {
    const folder = aFolder()
    ensureOrcaPluginFolder(folder, EARLIER)
    const inode = lstatSync(folder).ino
    chmodSync(dirname(folder), 0o500)

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('failed')

    chmodSync(dirname(folder), 0o700)
    expect(lstatSync(folder).ino).toBe(inode)
    holdsOnly(folder, EARLIER)
  })

  it('a key that would leave the folder writes nothing', () => {
    const folder = aFolder()
    // What an earlier run left is not touched either.
    mkdirSync(`${folder}.old`)

    for (const key of ['../x', '/abs', 'a//b', 'src/../x', 'src/.', '', 'src/', 'a\\b']) {
      expect(ensureOrcaPluginFolder(folder, { ...FILES, [key]: 'x' }), key).toBe('failed')
    }

    expect(readdirSync(dirname(folder))).toEqual(['orca-plugin.old'])
  })

  it('a key that names a file and a folder at once writes nothing', () => {
    const folder = aFolder()

    expect(ensureOrcaPluginFolder(folder, { src: 'x', 'src/a.ts': 'y' })).toBe('failed')
    expect(ensureOrcaPluginFolder(folder, { 'src/a.ts': 'y', src: 'x' })).toBe('failed')

    expect(readdirSync(dirname(folder))).toEqual([])
  })

  it('a command that writes while another does: both finish, and the folder is whole', () => {
    const folder = aFolder()
    const real = watched.fsyncSync
    let other: string | undefined
    // The other command runs whole between this one's first file and its swap.
    vi.spyOn(watched, 'fsyncSync').mockImplementation((...args) => {
      real(...args)
      other ??= anotherCommand(folder, EARLIER)
    })

    expect(ensureOrcaPluginFolder(folder, FILES)).toBe('written')

    expect(other).toBe('written')
    holdsOnly(folder, FILES)
  })

  it('a command whose folder another command swapped meanwhile fails whole', () => {
    const folder = aFolder()
    ensureOrcaPluginFolder(folder, EARLIER)
    const real = watched.renameSync
    let other: string | undefined
    // The other command runs whole after this one moved the folder aside, before it renames its own into place.
    vi.spyOn(watched, 'renameSync').mockImplementation((from, to) => {
      if (other === undefined && String(from).startsWith(`${folder}.new`)) other = anotherCommand(folder, FILES)
      return real(from, to)
    })

    expect(ensureOrcaPluginFolder(folder, { ...FILES, 'src/plugin.ts': 'export const answer = 2\n' })).toBe('failed')

    expect(other).toBe('written')
    holdsOnly(folder, FILES)
  })
})

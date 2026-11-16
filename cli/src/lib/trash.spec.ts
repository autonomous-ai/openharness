import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { systemTrash, TrashError } from './trash.js'
import type { PowershellResult } from './windows/powershell.js'

// The real rename, but for a move across volumes, which a test folder cannot provoke.
const fsMock = vi.hoisted(() => ({ exdev: false }))
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    rename: vi.fn(async (from: string, to: string) => {
      if (fsMock.exdev) throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
      return real.rename(from, to)
    }),
  }
})

const refused = (code: TrashError['code']) => expect.objectContaining({ code })

describe('moving a folder to the Trash', () => {
  describe('on a Mac, through the Finder\'s own call', () => {
    it('hands the folder to NSFileManager by osascript, and says it failed when that fails', async () => {
      const osascript = vi.fn(async (_args: string[]) => {})
      await systemTrash({ platform: 'darwin', osascript })('/Users/me/harnesses/worktrees/repo/kept')
      const [args] = osascript.mock.calls[0]
      expect(args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e'])
      expect(args[3]).toContain('trashItemAtURLResultingItemURLError')
      // The path is an argument, never part of the script's text.
      expect(args[3]).not.toContain('kept')
      expect(args[4]).toBe('/Users/me/harnesses/worktrees/repo/kept')
      osascript.mockRejectedValueOnce(new Error('The file “kept” couldn’t be moved'))
      await expect(systemTrash({ platform: 'darwin', osascript })('/x')).rejects.toEqual(refused('TRASH_FAILED'))
    })
  })

  describe('on Windows, to the Recycle Bin', () => {
    it('recycles by SHFileOperation with no window, the path in the environment, and tells a no from a failure', async () => {
      const powershell = vi.fn(async (_script: string, _inputs: Record<string, string>): Promise<PowershellResult> => ({ status: 0, stdout: 'recycled', stderr: '' }))
      const trash = systemTrash({ platform: 'win32', powershell })
      await trash('C:\\Users\\me\\harnesses\\worktrees\\repo\\kept')
      const [script, inputs] = powershell.mock.calls[0]
      expect(inputs).toEqual({ HARNESS_TRASH_PATH: 'C:\\Users\\me\\harnesses\\worktrees\\repo\\kept' })
      expect(script).toContain('SHFileOperation')
      // FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FOF_NOERRORUI and FOF_WANTNUKEWARNING.
      expect(script).toContain('0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x4000')
      expect(script).not.toContain('kept')
      powershell.mockResolvedValueOnce({ status: 0, stdout: 'declined', stderr: '' })
      await expect(trash('C:\\a')).rejects.toEqual(refused('TRASH_DECLINED'))
      powershell.mockResolvedValueOnce({ status: 0, stdout: 'failed', stderr: '' })
      await expect(trash('C:\\a')).rejects.toEqual(refused('TRASH_FAILED'))
      powershell.mockResolvedValueOnce({ status: 1, stdout: '', stderr: 'Add-Type failed' })
      await expect(trash('C:\\a')).rejects.toEqual(refused('TRASH_FAILED'))
      powershell.mockResolvedValueOnce({ status: null, stdout: '', stderr: '' })
      await expect(trash('C:\\a')).rejects.toEqual(refused('TRASH_FAILED'))
    })
  })

  describe('on Linux, in the freedesktop.org home trash', () => {
    let root: string
    let data: string
    const at = new Date(2026, 10, 12, 9, 5, 7)
    const trash = () => systemTrash({ platform: 'linux', env: { XDG_DATA_HOME: data }, now: () => at })
    const folder = (name: string) => {
      const path = join(root, 'worktrees', name)
      mkdirSync(path, { recursive: true })
      writeFileSync(join(path, 'file'), name)
      return path
    }
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'trash-'))
      data = join(root, 'data')
      fsMock.exdev = false
    })
    afterEach(() => { rmSync(root, { recursive: true, force: true }) })

    it('moves the folder into files/ with its record in info/, which Restore reads', async () => {
      const path = folder('my tree')
      await trash()(path)
      expect(existsSync(path)).toBe(false)
      expect(readFileSync(join(data, 'Trash', 'files', 'my tree', 'file'), 'utf8')).toBe('my tree')
      expect(readFileSync(join(data, 'Trash', 'info', 'my tree.trashinfo'), 'utf8'))
        .toBe(`[Trash Info]\nPath=${path.split('/').map(encodeURIComponent).join('/')}\nDeletionDate=2026-11-12T09:05:07\n`)
    })

    it('takes the next free name beside one of the same name, or a folder left without its record', async () => {
      await trash()(folder('a/kept'))
      await trash()(folder('b/kept'))
      mkdirSync(join(data, 'Trash', 'files', 'kept.3'))
      await trash()(folder('c/kept'))
      expect(readdirSync(join(data, 'Trash', 'files')).sort()).toEqual(['kept', 'kept.2', 'kept.3', 'kept.4'])
      expect(readdirSync(join(data, 'Trash', 'info')).sort()).toEqual(['kept.2.trashinfo', 'kept.4.trashinfo', 'kept.trashinfo'])
    })

    it('uses ~/.local/share/Trash when XDG_DATA_HOME is not set', async () => {
      const home = join(root, 'home')
      await systemTrash({ platform: 'linux', env: { HOME: home } })(folder('kept'))
      expect(existsSync(join(home, '.local', 'share', 'Trash', 'files', 'kept', 'file'))).toBe(true)
    })

    it('leaves the folder where it is when it cannot go: across volumes, gone already, or no trash to write to', async () => {
      const path = folder('kept')
      fsMock.exdev = true
      await expect(trash()(path)).rejects.toEqual(refused('TRASH_UNAVAILABLE'))
      expect(existsSync(join(path, 'file'))).toBe(true)
      // Its reserved name is let go.
      expect(readdirSync(join(data, 'Trash', 'info'))).toEqual([])
      fsMock.exdev = false
      await expect(trash()(join(root, 'worktrees', 'gone'))).rejects.toEqual(refused('TRASH_FAILED'))
      expect(readdirSync(join(data, 'Trash', 'info'))).toEqual([])
      // The data folder is a file: no trash can be made there.
      writeFileSync(join(root, 'blocked'), '')
      await expect(systemTrash({ platform: 'linux', env: { XDG_DATA_HOME: join(root, 'blocked') } })(path)).rejects.toEqual(refused('TRASH_UNAVAILABLE'))
      expect(existsSync(join(path, 'file'))).toBe(true)
    })

    it('refuses rather than overwrite once its names run out, or when its records cannot be written', async () => {
      const path = folder('kept')
      mkdirSync(join(data, 'Trash', 'info'), { recursive: true })
      for (let n = 1; n <= 1000; n++) writeFileSync(join(data, 'Trash', 'info', `${n === 1 ? 'kept' : `kept.${n}`}.trashinfo`), '')
      await expect(trash()(path)).rejects.toEqual(refused('TRASH_UNAVAILABLE'))
      rmSync(join(data, 'Trash'), { recursive: true })
      mkdirSync(join(data, 'Trash', 'files'), { recursive: true })
      mkdirSync(join(data, 'Trash', 'info'))
      chmodSync(join(data, 'Trash', 'info'), 0o500)
      try {
        await expect(trash()(path)).rejects.toEqual(refused('TRASH_UNAVAILABLE'))
      } finally { chmodSync(join(data, 'Trash', 'info'), 0o700) }
      expect(existsSync(join(path, 'file'))).toBe(true)
    })
  })
})

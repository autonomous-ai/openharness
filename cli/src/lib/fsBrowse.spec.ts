import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as fsAsync from 'node:fs/promises'
import { mkdirSync, mkdtempSync, chmodSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { listDir } from './fsBrowse.js'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readdir: vi.fn(original.readdir) }
})

const root = mkdtempSync(join(homedir(), '.harness-fsbrowse-test-'))
mkdirSync(join(root, 'Projects'))
mkdirSync(join(root, 'workspace'))
mkdirSync(join(root, '.hidden'))
mkdirSync(join(root, 'restricted'))
try { chmodSync(join(root, 'restricted'), 0o000) } catch { /* best effort — see permission-denied test below */ }

afterAll(async () => {
  try { chmodSync(join(root, 'restricted'), 0o700) } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true })
})

describe('listDir', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  it('times out a stalled read without blocking another folder or resubmitting it', async () => {
    let release!: (value: never[]) => void
    const slow = join(root, 'workspace', 'slow-provider')
    mkdirSync(slow)
    // The isolated home can use macOS's /var alias. listDir reads the real folder,
    // while its result preserves the path the browser selected.
    const realSlow = await fsAsync.realpath(slow)
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readdir
    const reader = vi.mocked(fsAsync.readdir).mockImplementation(((path: unknown, options: unknown) =>
      path === realSlow ? new Promise<never[]>(resolve => { release = resolve }) : original(path as string, options as any)) as typeof original)
    vi.useFakeTimers()
    const first = listDir(slow)
    try {
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      const second = listDir(slow)
      const sibling = await listDir(join(root, 'Projects'))
      expect(sibling).toMatchObject({ path: join(root, 'Projects'), entries: [] })
      await vi.advanceTimersByTimeAsync(4000)
      expect(await first).toEqual({ error: 'UNAVAILABLE' })
      expect(await second).toEqual({ error: 'UNAVAILABLE' })
      expect(reader.mock.calls.filter(args => args[0] === realSlow)).toHaveLength(1)
    } finally { release?.([]) }
  })

  it('lists directories, sorted, excluding hidden entries', async () => {
    const result = await listDir(root)
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.entries).toEqual([
      { name: 'Projects', isDir: true },
      { name: 'restricted', isDir: true },
      { name: 'workspace', isDir: true },
    ])
    expect(result.truncated).toBe(false)
  })

  it('defaults to the home directory when path is empty', async () => {
    const result = await listDir('')
    expect('error' in result).toBe(false)
    if (!('error' in result)) expect(result.path).toBe(homedir())
  })

  it('rejects a relative path', async () => {
    expect(await listDir('relative/path')).toEqual({ error: 'INVALID_PATH' })
  })

  it('rejects a path outside $HOME by default', async () => {
    expect(await listDir(tmpdir())).toEqual({ error: 'FORBIDDEN' })
  })

  it('rejects a link that is named inside $HOME but points out of it', async () => {
    // The whole point of the fence: the name sits under home, the directory it opens does not.
    const escape = join(root, 'escape')
    symlinkSync(tmpdir(), escape)
    expect(await listDir(escape)).toEqual({ error: 'FORBIDDEN' })
    expect(await listDir(join(escape, '.'))).toEqual({ error: 'FORBIDDEN' })
  })

  it('reports NOT_FOUND for a missing directory', async () => {
    expect(await listDir(join(root, 'does-not-exist'))).toEqual({ error: 'NOT_FOUND' })
  })

  it('reports NOT_A_DIRECTORY for a file', async () => {
    const filePath = join(root, 'a-file.txt')
    writeFileSync(filePath, 'x')
    expect(await listDir(filePath)).toEqual({ error: 'NOT_A_DIRECTORY' })
  })

  // Skipped when running as root (e.g. some CI containers), where chmod 000 doesn't block reads.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'maps EACCES to PERMISSION_DENIED',
    async () => {
      expect(await listDir(join(root, 'restricted'))).toEqual({ error: 'PERMISSION_DENIED' })
    },
  )
})

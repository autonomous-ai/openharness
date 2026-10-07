import { linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { baseNode, namedNode, nodeFs, resetNamedNodeReports, type NamedNodeFs } from './processName.js'

const runtime = '/home/u/.harness/runtime'
const node = `${runtime}/node-v22/bin/node`
const libexec = `${runtime}/node-v22/libexec/harnessd`

/** An in-memory folder: path → identity. */
function memFs(files: Record<string, { dev: number; ino: number }>, fail: Partial<Record<keyof NamedNodeFs, Error>> = {}) {
  const calls: string[] = []
  const fs: NamedNodeFs = {
    realpath: (path) => { if (fail.realpath) throw fail.realpath; return path },
    identity: (path) => files[path] ?? null,
    mkdir: (path) => { calls.push(`mkdir ${path}`); if (fail.mkdir) throw fail.mkdir },
    link: (from, to) => { calls.push(`link ${to}`); if (fail.link) throw fail.link; files[to] = files[from] },
    rename: (from, to) => { calls.push(`rename ${to}`); if (fail.rename) throw fail.rename; files[to] = files[from]; delete files[from] },
    unlink: (path) => { if (!files[path]) throw new Error('ENOENT'); delete files[path] },
  }
  return { fs, calls, files }
}

afterEach(() => resetNamedNodeReports())

describe('namedNode', () => {
  it('links the managed node under the name, beside bin/ and never in it', () => {
    const { fs, calls } = memFs({ [node]: { dev: 1, ino: 7 } })
    expect(namedNode(node, 'harnessd-core', runtime, { fs, pid: 9, platform: 'darwin' })).toBe(`${libexec}/harnessd-core`)
    expect(calls).toEqual([`mkdir ${libexec}`, `link ${libexec}/harnessd-core.9.tmp`, `rename ${libexec}/harnessd-core`])
  })

  it('reuses a link that is still this node, and replaces one left to another binary', () => {
    const same = memFs({ [node]: { dev: 1, ino: 7 }, [`${libexec}/harnessd`]: { dev: 1, ino: 7 } })
    expect(namedNode(node, 'harnessd', runtime, { fs: same.fs, platform: 'linux' })).toBe(`${libexec}/harnessd`)
    expect(same.calls).toEqual([])
    const stale = memFs({ [node]: { dev: 1, ino: 7 }, [`${libexec}/harnessd`]: { dev: 1, ino: 3 }, [`${libexec}/harnessd.5.tmp`]: { dev: 1, ino: 3 } })
    expect(namedNode(node, 'harnessd', runtime, { fs: stale.fs, pid: 5, platform: 'linux' })).toBe(`${libexec}/harnessd`)
    expect(stale.files[`${libexec}/harnessd`]).toEqual({ dev: 1, ino: 7 })
  })

  it('leaves any node outside the managed runtime alone, and Windows too', () => {
    const { fs, calls } = memFs({})
    expect(namedNode('/opt/homebrew/bin/node', 'harnessd', runtime, { fs, platform: 'darwin' })).toBe('/opt/homebrew/bin/node')
    expect(namedNode(node, 'harnessd', undefined, { fs, platform: 'darwin' })).toBe(node)
    expect(namedNode(node, 'harnessd', `${runtime}/node-v22/bin/node`, { fs, platform: 'darwin' })).toBe(node)
    expect(namedNode(node, 'harnessd', runtime, { fs, platform: 'win32' })).toBe(node)
    expect(calls).toEqual([])
  })

  it('resolves runtime aliases too, and refuses a path resolving to the runtime root', () => {
    const { fs, calls } = memFs({ [node]: { dev: 1, ino: 7 } })
    fs.realpath = path => path.replace(runtime, '/resolved/runtime')
    expect(namedNode(node, 'harnessd', runtime, { fs, platform: 'darwin' })).toBe(`${libexec}/harnessd`)
    calls.length = 0
    fs.realpath = () => '/resolved/runtime'
    expect(namedNode(node, 'harnessd', runtime, { fs, platform: 'darwin' })).toBe(node)
    expect(calls).toEqual([])
  })

  it('leaves the executable alone when resolving its path fails', () => {
    const { fs, calls } = memFs({ [node]: { dev: 1, ino: 7 } }, { realpath: new Error('EACCES') })
    expect(namedNode(node, 'harnessd', runtime, { fs, platform: 'darwin' })).toBe(node)
    expect(calls).toEqual([])
  })

  it('runs as node when the link cannot be made, and says why once per name', () => {
    const log = vi.fn()
    const missing = memFs({})
    expect(namedNode(node, 'harnessd', runtime, { fs: missing.fs, platform: 'darwin', log })).toBe(node)
    const crossDevice = memFs({ [node]: { dev: 1, ino: 7 } }, { link: new Error('EXDEV') })
    expect(namedNode(node, 'harnessd-core', runtime, { fs: crossDevice.fs, platform: 'darwin', log })).toBe(node)
    expect(namedNode(node, 'harnessd-core', runtime, { fs: crossDevice.fs, platform: 'darwin', log })).toBe(node)
    const readOnly = memFs({ [node]: { dev: 1, ino: 7 } }, { mkdir: 'EROFS' as unknown as Error })
    expect(namedNode(node, 'harnessd-teams', runtime, { fs: readOnly.fs, platform: 'darwin' })).toBe(node)
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[harnessd] harnessd runs as node (no node binary)',
      '[harnessd] harnessd-core runs as node (EXDEV)',
    ])
  })

  it('cleans up a link it made but could not rename into place', () => {
    const { fs, files } = memFs({ [node]: { dev: 1, ino: 7 } }, { rename: new Error('EPERM') })
    expect(namedNode(node, 'harnessd-viewers', runtime, { fs, pid: 4, platform: 'darwin' })).toBe(node)
    expect(Object.keys(files)).toEqual([node])
  })

  it('keeps a managed symlink to an external Node at its original executable path', () => {
    // Found by QA on a quiet machine: naming this symlink hard-linked Homebrew Node itself on macOS,
    // and dyld aborted it because its relative libnode dependency was no longer beside the executable.
    const dir = mkdtempSync(join(tmpdir(), 'harnessd-node-symlink-'))
    try {
      const bin = join(dir, 'node-v1', 'bin')
      mkdirSync(bin, { recursive: true })
      const externalNode = join(bin, 'node')
      symlinkSync(process.execPath, externalNode)
      expect(namedNode(externalNode, 'harnessd', dir)).toBe(externalNode)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('makes a real hard link the kernel names the process by', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnessd-name-'))
    try {
      const bin = join(dir, 'node-v1', 'bin')
      mkdirSync(bin, { recursive: true })
      const fakeNode = join(bin, 'node')
      linkSync(process.execPath, fakeNode)
      const link = namedNode(fakeNode, 'harnessd-search', dir)
      expect(link).toBe(join(dir, 'node-v1', 'libexec', 'harnessd', 'harnessd-search'))
      expect(statSync(link).ino).toBe(statSync(process.execPath).ino)
      expect(namedNode(fakeNode, 'harnessd-search', dir, { fs: nodeFs })).toBe(link)
      expect(baseNode(link)).toBe(fakeNode)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('baseNode', () => {
  it('maps a name link back to the node beside its folder, and leaves anything else', () => {
    expect(baseNode(`${libexec}/harnessd-core`)).toBe(node)
    expect(baseNode(node)).toBe(node)
    expect(baseNode('/usr/bin/node')).toBe('/usr/bin/node')
  })
})

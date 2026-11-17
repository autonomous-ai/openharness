import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExecutionArtifacts } from './executionArtifacts.js'
import { LEAN_CORE_ENTRY, LEAN_ENTRY, LEAN_RECENT_MS, folderFingerprint } from './leanBundle.js'

const hooks = vi.hoisted(() => ({
  opened: new Set<number>(),
  beforeRead: null as null | (() => void),
  readLimit: Infinity,
  statSize: null as number | null,
  fail: '' as string,
  failWrite: null as null | ((path: string) => boolean),
  failRename: null as null | ((from: string, to: string) => boolean),
  failRemove: null as null | ((path: string) => boolean),
  failStat: null as null | ((path: string) => boolean),
}))
vi.mock('node:fs', async (load) => {
  const fs = await load<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: ((path: string, flags: string) => {
      if (hooks.fail === 'open') throw new Error('private source path')
      const fd = fs.openSync(path, flags)
      hooks.opened.add(fd)
      return fd
    }) as typeof fs.openSync,
    fstatSync: ((fd: number) => {
      if (hooks.fail === 'stat') throw new Error('private source path')
      const stat = fs.fstatSync(fd)
      if (hooks.statSize !== null) stat.size = hooks.statSize
      return stat
    }) as typeof fs.fstatSync,
    readSync: ((fd: number, buffer: Buffer, offset?: number, length?: number, position?: number | null) => {
      const step = hooks.beforeRead
      hooks.beforeRead = null
      step?.()
      if (hooks.fail === 'read') throw new Error('private source path')
      return fs.readSync(fd, buffer, offset ?? 0, Math.min(length ?? buffer.length, hooks.readLimit), position ?? null)
    }) as typeof fs.readSync,
    closeSync: (fd: number) => {
      fs.closeSync(fd)
      hooks.opened.delete(fd)
      if (hooks.fail === 'close') throw new Error('private source path')
    },
    writeFileSync: ((path: string, ...rest: unknown[]) => {
      if (hooks.failWrite?.(String(path))) throw new Error('private destination path')
      return (fs.writeFileSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.writeFileSync,
    renameSync: (from: string, to: string) => {
      if (hooks.failRename?.(from, to)) throw new Error('private destination path')
      fs.renameSync(from, to)
    },
    rmSync: ((path: string, ...rest: unknown[]) => {
      if (hooks.failRemove?.(String(path))) throw new Error('private destination path')
      return (fs.rmSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.rmSync,
    lstatSync: ((path: string, ...rest: unknown[]) => {
      if (hooks.failStat?.(String(path))) throw new Error('private destination path')
      return (fs.lstatSync as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof fs.lstatSync,
  }
})

// @ts-expect-error — the build's ESM writer has no declaration file.
const { leanBlock } = await import('../../scripts/lib/leanBlock.mjs') as {
  leanBlock: (files: Record<string, string>) => string
}
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const CLI = 'console.log("the chosen full CLI")\n'
const FILES = { [LEAN_ENTRY]: 'export const master = 1', [LEAN_CORE_ENTRY]: 'export const core = 1', 'chunk-a.mjs': 'export const shared = 1' }

describe('one owned execution artifact', () => {
  let root: string
  let directory: string
  let original: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'execution-artifact-'))
    directory = join(root, 'lean')
    original = join(root, 'cli.js')
  })
  afterEach(() => {
    hooks.beforeRead = null
    hooks.readLimit = Infinity
    hooks.statSize = null
    hooks.fail = ''
    hooks.failWrite = null
    hooks.failRename = null
    hooks.failRemove = null
    hooks.failStat = null
    expect(hooks.opened.size).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })
  const owner = (extra: Partial<Parameters<typeof createExecutionArtifacts>[0]> = {}) => createExecutionArtifacts({
    directory, pid: 100, alive: () => true, bootedAt: 0, ...extra,
  })
  const selected = (code = CLI): string => { writeFileSync(original, code); return digest(code) }
  const replace = (code: string): void => {
    const next = join(root, 'next.js')
    writeFileSync(next, code)
    renameSync(next, original)
  }
  const claim = (entry: string, pid = 100): string => join(dirname(entry), `.claim-${pid}`)

  it('freezes the exact full CLI through atomic B→C→B publication and preserves its canonical identity', () => {
    const expected = selected()
    const artifacts = owner()
    const image = artifacts.prepare(original, expected)
    replace('console.log("a legacy C")\n')
    expect(readFileSync(image.probeScript, 'utf8')).toBe(CLI)
    replace(CLI)
    expect(readFileSync(image.fullScript, 'utf8')).toBe(CLI)
    expect(image).toMatchObject({ selected: expected, originalScript: original, fullFingerprint: expected, probeScript: image.fullScript })
    expect(image.fullScript).not.toBe(original)
    expect(image.leanScript).toBeUndefined()
    expect(image.leanCoreScript).toBeUndefined()
    expect(image.leanFingerprint).toBeUndefined()
    expect(Object.values(image).some(Buffer.isBuffer)).toBe(false)
    expect(existsSync(claim(image.fullScript))).toBe(true)
    image.release()
    expect(existsSync(claim(image.fullScript))).toBe(false)
    image.release()
  })

  it('uses one open file even when the canonical pathname is replaced during its bounded read', () => {
    const expected = selected()
    hooks.beforeRead = () => replace('a different file of another length')
    hooks.readLimit = 2
    const image = owner().prepare(original, expected)
    expect(readFileSync(image.fullScript, 'utf8')).toBe(CLI)
    expect(readFileSync(original, 'utf8')).toBe('a different file of another length')
    image.release()
  })

  it('publishes full and lean entries from one verified source and fingerprints their exact bytes', () => {
    const code = CLI + leanBlock(FILES)
    const expected = selected(code)
    const image = owner().prepare(original, expected)
    expect(dirname(image.fullScript)).toBe(dirname(image.leanScript!))
    expect(dirname(image.fullScript)).toBe(dirname(image.leanCoreScript!))
    expect(readFileSync(image.probeScript, 'utf8')).toBe(code)
    expect(readFileSync(image.leanScript!, 'utf8')).toBe(FILES[LEAN_ENTRY])
    expect(readFileSync(image.leanCoreScript!, 'utf8')).toBe(FILES[LEAN_CORE_ENTRY])
    expect(image.leanEntryFingerprint).toBe(digest(FILES[LEAN_ENTRY]))
    expect(image.leanCoreFingerprint).toBe(digest(FILES[LEAN_CORE_ENTRY]))
    expect(image.leanFingerprint).toBe(folderFingerprint(dirname(image.fullScript)))
    image.release()
  })

  it('advertises no lean core when the verified block predates that entry', () => {
    const code = CLI + leanBlock({ [LEAN_ENTRY]: FILES[LEAN_ENTRY] })
    const image = owner().prepare(original, selected(code))
    expect(image.leanScript).toBeDefined()
    expect(image.leanCoreScript).toBeUndefined()
    expect(image.leanCoreFingerprint).toBeUndefined()
    image.release()
  })

  it('keeps corrupt embedded code out of the advertised lean paths', () => {
    const code = CLI + '\n/*@harness-lean:' + '0'.repeat(64) + ':bm90LWJyb3RsaQ==*/\n'
    const image = owner().prepare(original, selected(code))
    expect(readFileSync(image.fullScript, 'utf8')).toBe(code)
    expect(image.leanScript).toBeUndefined()
    image.release()
  })

  it.each(['cohort-cli.mjs', 'COHORT-CLI.mjs'])('rejects reserved snapshot name %s without publishing or claiming anything', (name) => {
    const code = CLI + leanBlock({ ...FILES, [name]: 'a conflicting module' })
    expect(() => owner().prepare(original, selected(code))).toThrow('worker_artifact_reserved_name')
    expect(existsSync(directory)).toBe(false)
  })

  it('rejects a stale selected hash before publication and can select again', () => {
    const expected = selected()
    const artifacts = owner()
    replace('newly published')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_source_changed')
    expect(existsSync(directory)).toBe(false)
    const image = artifacts.prepare(original, digest('newly published'))
    image.release()
  })

  it('holds at most one live candidate, and reuses the deterministic store after release', () => {
    const expected = selected()
    const artifacts = owner()
    const first = artifacts.prepare(original, expected)
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_in_use')
    expect(existsSync(claim(first.fullScript))).toBe(true)
    first.release()
    const next = artifacts.prepare(original, expected)
    expect(next.fullScript).toBe(first.fullScript)
    first.release()
    expect(existsSync(claim(next.fullScript))).toBe(true)
    expect(readdirSync(directory)).toHaveLength(1)
    next.release()
  })

  it('preserves an original master claim on the same candidate folder after release', () => {
    const expected = selected()
    const first = owner().prepare(original, expected)
    const artifacts = owner({ directory, keepMasterEntry: first.fullScript })
    const next = artifacts.prepare(original, expected)
    next.release()
    expect(existsSync(claim(first.fullScript))).toBe(true)
    first.release()
  })

  it('preserves the original master claim if repairing that same candidate fails', () => {
    const expected = selected()
    const first = owner().prepare(original, expected)
    writeFileSync(first.fullScript, 'damaged original image')
    const artifacts = owner({ keepMasterEntry: first.fullScript })
    hooks.failWrite = (path) => path.endsWith(LEAN_ENTRY)
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_publish_failed')
    expect(existsSync(claim(first.fullScript))).toBe(true)
    hooks.failWrite = null
    first.release()
  })

  it('uses the actual process claim by default and closes an empty selected file', () => {
    const artifacts = createExecutionArtifacts({ directory, bootedAt: 0 })
    const image = artifacts.prepare(original, selected(''))
    expect(existsSync(claim(image.fullScript, process.pid))).toBe(true)
    expect(readFileSync(image.fullScript).length).toBe(0)
    image.release()
    expect(existsSync(claim(image.fullScript, process.pid))).toBe(false)
  })

  it('keeps the original master and other live claims while retiring its own old candidate', () => {
    const first = owner().prepare(original, selected('original master'))
    const second = owner({ directory, pid: 200 }).prepare(original, selected('another master'))
    const artifacts = owner({ directory, keepMasterEntry: first.fullScript, now: () => Date.now() + LEAN_RECENT_MS + 1_000 })
    const candidate = artifacts.prepare(original, selected())
    expect(existsSync(first.fullScript)).toBe(true)
    expect(existsSync(second.fullScript)).toBe(true)
    candidate.release()
    const next = artifacts.prepare(original, selected('a newer cohort'))
    expect(existsSync(candidate.fullScript)).toBe(false)
    expect(existsSync(first.fullScript)).toBe(true)
    expect(existsSync(second.fullScript)).toBe(true)
    next.release()
    first.release()
    second.release()
  })

  it.each(['open', 'stat', 'read', 'close'])('closes source ownership and publishes nothing on %s failure', (failure) => {
    const expected = selected()
    hooks.fail = failure
    expect(() => owner().prepare(original, expected)).toThrow('worker_artifact_source_unavailable')
    expect(existsSync(directory)).toBe(false)
  })

  it.each([-1, 128 * 1024 * 1024 + 1, 1.5])('rejects source length %s before reading or allocating its image', (size) => {
    const expected = selected()
    hooks.statSize = size
    hooks.beforeRead = () => { throw new Error('must not read') }
    expect(() => owner().prepare(original, expected)).toThrow('worker_artifact_source_unavailable')
    expect(hooks.beforeRead).not.toBeNull()
    expect(existsSync(directory)).toBe(false)
  })

  it('rejects a directory, a short read and a growing source instead of silently truncating', () => {
    mkdirSync(original)
    expect(() => owner().prepare(original, digest(''))).toThrow('worker_artifact_source_unavailable')
    rmSync(original, { recursive: true })
    const expected = selected()
    hooks.statSize = CLI.length + 1
    expect(() => owner().prepare(original, expected)).toThrow('worker_artifact_source_unavailable')
    hooks.statSize = CLI.length - 1
    expect(() => owner().prepare(original, expected)).toThrow('worker_artifact_source_unavailable')
    expect(existsSync(directory)).toBe(false)
  })

  it('leaves no partial image or own claim when writing fails and allows the next preparation', () => {
    const code = CLI + leanBlock(FILES)
    const expected = selected(code)
    const artifacts = owner()
    hooks.failWrite = (path) => path.endsWith('cohort-cli.mjs')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_publish_failed')
    expect(readdirSync(directory)).toEqual([])
    hooks.failWrite = null
    const image = artifacts.prepare(original, expected)
    image.release()
  })

  it('removes only its candidate claim after failure replacing a corrupt existing image', () => {
    const expected = selected()
    const first = owner({ directory, pid: 200 }).prepare(original, expected)
    writeFileSync(first.fullScript, 'a corrupted image')
    const artifacts = owner()
    hooks.failWrite = (path) => path.endsWith(LEAN_ENTRY)
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_publish_failed')
    expect(existsSync(claim(first.fullScript))).toBe(false)
    expect(existsSync(claim(first.fullScript, 200))).toBe(true)
    expect(readFileSync(first.fullScript, 'utf8')).toBe('a corrupted image')
    hooks.failWrite = null
    first.release()
  })

  it('keeps ownership and refuses a new candidate when release cannot remove its claim', () => {
    const expected = selected()
    const artifacts = owner()
    const image = artifacts.prepare(original, expected)
    hooks.failRemove = (path) => path === claim(image.fullScript)
    expect(() => image.release()).toThrow('worker_artifact_release_failed')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_in_use')
    hooks.failRemove = null
    image.release()
    expect(existsSync(claim(image.fullScript))).toBe(false)
  })

  it('does not infer successful release from a failed claim stat', () => {
    const expected = selected()
    const artifacts = owner()
    const image = artifacts.prepare(original, expected)
    hooks.failStat = (path) => path === claim(image.fullScript)
    expect(() => image.release()).toThrow('worker_artifact_release_failed')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_in_use')
    hooks.failStat = null
    image.release()
  })

  it('retains failed-publication ownership if its own claim cannot be removed', () => {
    const expected = selected()
    const first = owner({ directory, pid: 200 }).prepare(original, expected)
    writeFileSync(first.fullScript, 'a corrupt prior image')
    const artifacts = owner()
    hooks.failWrite = (path) => path.endsWith(LEAN_ENTRY)
    hooks.failRemove = (path) => path === claim(first.fullScript)
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(existsSync(claim(first.fullScript))).toBe(true)
    hooks.failWrite = null
    hooks.failRemove = null
    first.release()
  })

  it('keeps a failed scratch write owned if its cleanup fails', () => {
    const expected = selected(CLI + leanBlock(FILES))
    const artifacts = owner()
    hooks.failWrite = (path) => path.endsWith('cohort-cli.mjs')
    hooks.failRemove = (path) => path.endsWith('.100.tmp')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(readdirSync(directory)).toHaveLength(1)
    expect(readdirSync(directory)[0]).toMatch(/\.100\.tmp$/)
  })

  it('refuses a newly published candidate if removing its prior complete aside fails', () => {
    const expected = selected()
    const first = owner({ pid: 200 }).prepare(original, expected)
    writeFileSync(first.fullScript, 'the prior complete image')
    const artifacts = owner()
    hooks.failRemove = (path) => path.endsWith('.100.old')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(readFileSync(first.fullScript, 'utf8')).toBe(CLI)
    expect(existsSync(claim(first.fullScript))).toBe(true)
    const old = readdirSync(directory).find((name) => name.endsWith('.old'))!
    expect(readFileSync(join(directory, old, LEAN_ENTRY), 'utf8')).toBe('the prior complete image')
    first.release()
  })

  it('does not infer successful publication cleanup when a scratch path cannot be inspected', () => {
    const expected = selected()
    const artifacts = owner()
    hooks.failStat = (path) => path.endsWith('.100.tmp')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
  })

  it('retains both complete images and refuses another prepare when publication rollback fails', () => {
    const expected = selected()
    const first = owner({ directory, pid: 200 }).prepare(original, expected)
    writeFileSync(first.fullScript, 'a prior complete image')
    const artifacts = owner()
    hooks.failRename = (from, to) => !existsSync(to) && (from.endsWith('.100.tmp') || from.endsWith('.100.old'))
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(() => artifacts.prepare(original, expected)).toThrow('worker_artifact_cleanup_unsettled')
    expect(readdirSync(directory).sort()).toEqual([`${basename(dirname(first.fullScript))}.100.old`, `${basename(dirname(first.fullScript))}.100.tmp`])
    const old = readdirSync(directory).find((name) => name.endsWith('.old'))!
    expect(readFileSync(join(directory, old, LEAN_ENTRY), 'utf8')).toBe('a prior complete image')
    expect(existsSync(join(directory, old, '.claim-200'))).toBe(true)
    hooks.failRename = null
    first.release()
  })
})

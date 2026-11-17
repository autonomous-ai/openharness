import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceInstructions } from './workspaceInstructions.js'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const files = () => ({ prepare: vi.fn(async () => {}), write: vi.fn() })

describe('workspace instruction preparation', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('loads nothing at startup, for a terminal, a cancelled request or malformed input', async () => {
    const writer = vi.fn(async () => files())
    const prepare = createWorkspaceInstructions('/data', () => false, writer)
    expect(writer).not.toHaveBeenCalled()
    expect(await prepare('/work', 'terminal')).toBe(true)
    const abort = new AbortController(); abort.abort()
    expect(await prepare('/work', 'claude', abort.signal)).toBe(false)
    for (const [workspace, engine] of [[null, 'claude'], ['relative', 'claude'], ['/' + 'a'.repeat(4096), 'claude'], ['/work\0escape', 'claude'], ['/work', 'unknown'], ['/work', 1]]) {
      expect(await prepare(workspace as string, engine as string)).toBe(false)
    }
    expect(writer).not.toHaveBeenCalled()
  })

  it.each(['load', 'SCM'] as const)('cancellation during %s prevents the following file effects', async stage => {
    const gate = deferred<void>(), reached = deferred<void>(), state = files()
    const abort = new AbortController()
    const load = vi.fn(async () => {
      if (stage === 'load') { reached.resolve(); await gate.promise }
      return state
    })
    if (stage === 'SCM') state.prepare.mockImplementationOnce(async () => { reached.resolve(); await gate.promise })
    const result = createWorkspaceInstructions('/data', () => false, load)('/work', 'claude', abort.signal)
    await reached.promise
    abort.abort(); gate.resolve()
    expect(await result).toBe(false)
    expect(state.write).not.toHaveBeenCalled()
    if (stage === 'load') expect(state.prepare).not.toHaveBeenCalled()
    else expect(state.prepare).toHaveBeenCalledExactlyOnceWith('/work')
  })

  it('retains all eight admission slots until their actual work settles', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gate = deferred<ReturnType<typeof files>>(), state = files()
    const writer = vi.fn(() => gate.promise)
    const prepare = createWorkspaceInstructions('/data', () => false, writer)
    const abort = new AbortController()
    const active = Array.from({ length: 8 }, () => prepare('/work', 'claude', abort.signal))
    expect(writer).toHaveBeenCalledTimes(8)
    abort.abort()
    expect(await prepare('/work', 'claude')).toBe(false)
    expect(console.warn).toHaveBeenCalledWith('[workspaces] INSTRUCTIONS_BUSY')
    gate.resolve(state)
    expect(await Promise.all(active)).toEqual(Array(8).fill(false))
    expect(state.write).not.toHaveBeenCalled()
    expect(await prepare('/work', 'claude')).toBe(true)
    expect(state.prepare).toHaveBeenCalledExactlyOnceWith('/work')
    expect(state.write).toHaveBeenCalledExactlyOnceWith('/work', 'claude')
  })

  it.each(['load', 'prepare', 'write'] as const)('a %s failure is named without content and releases its settled slot', async stage => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const state = files()
    const writer = vi.fn(async () => state)
    if (stage === 'load') writer.mockRejectedValueOnce(Error('private path and content'))
    if (stage === 'prepare') state.prepare.mockRejectedValueOnce(Error('private path and content'))
    if (stage === 'write') state.write.mockImplementationOnce(() => { throw Error('private path and content') })
    const prepare = createWorkspaceInstructions('/data', () => false, writer)
    expect(await prepare('/work', 'claude')).toBe(false)
    expect(log.mock.calls).toEqual([['[workspaces] INSTRUCTIONS_FAILED']])
    expect(await prepare('/work', 'claude')).toBe(true)
  })

  it('a stopped service rejects new work and revokes work still loading', async () => {
    let stopped = false
    const gate = deferred<ReturnType<typeof files>>(), state = files()
    const writer = vi.fn(() => gate.promise)
    const prepare = createWorkspaceInstructions('/data', () => stopped, writer)
    const active = prepare('/work', 'claude')
    stopped = true
    expect(await prepare('/work', 'claude')).toBe(false)
    gate.resolve(state)
    expect(await active).toBe(false)
    expect(writer).toHaveBeenCalledOnce()
    expect(state.prepare).not.toHaveBeenCalled()
  })

  it('uses the existing metadata-only legacy fallback and workspace eligibility, with idempotent notes', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-api-instructions-')))
    try {
      vi.stubEnv('HOME', root); vi.stubEnv('USERPROFILE', root); vi.stubEnv('HARNESS_OS', '')
      const data = join(root, 'data'), api = join(data, 'api-connections'), project = join(root, 'harnesses', 'scratch')
      const mine = join(root, 'mine'), clone = join(root, 'harnesses', 'clone')
      for (const path of [project, mine, join(clone, '.git')]) mkdirSync(path, { recursive: true })
      mkdirSync(api, { recursive: true, mode: 0o700 })
      // Existence, never contents: even an unparsable old key store is not opened by metadata discovery.
      writeFileSync(join(api, 'connections.json'), 'not JSON and never read', { mode: 0o600 })
      symlinkSync(mine, join(root, 'harnesses', 'linked'), 'junction')
      const prepare = createWorkspaceInstructions(data, () => false)
      for (const folder of [mine, clone, join(root, 'harnesses', 'linked')]) expect(await prepare(folder, 'codex')).toBe(true)
      expect(existsSync(join(mine, 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(clone, 'AGENTS.md'))).toBe(false)
      expect(await prepare(project, 'codex')).toBe(true)
      expect(await prepare(project, 'codex')).toBe(true)
      expect(readFileSync(join(project, 'AGENTS.md'), 'utf8').split('<!-- harness:apis -->')).toHaveLength(2)
      expect(readFileSync(join(api, 'connections.json'), 'utf8')).toBe('not JSON and never read')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

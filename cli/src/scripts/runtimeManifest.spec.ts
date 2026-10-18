import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error — plain ESM with no declaration file
const { readDocument, mergeKey, mergePlatforms, runtimeEntry } = await import('../../scripts/lib/runtimeManifest.mjs') as {
  readDocument: (path: string) => Record<string, any>
  mergeKey: (doc: object, key: string, value: object) => Record<string, any>
  mergePlatforms: (doc: object, name: string, entries: object) => Record<string, any>
  runtimeEntry: (entry: Record<string, unknown>) => Record<string, unknown>
}

const script = join(process.cwd(), 'scripts', 'lib', 'runtimeManifest.mjs')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const sha = 'a'.repeat(64)

describe('the runtime manifests the publish scripts write', () => {
  it('replaces only the platforms a publish ships: the Mac\'s Node keys survive a Windows publish', () => {
    const before = { node: { 'darwin-arm64': { version: 'v22.23.2' }, 'win32-x64': { version: 'v22.0.0' } }, other: { kept: true } }
    const after = mergePlatforms(before, 'node', { 'win32-x64': { version: 'v22.23.2' }, 'win32-arm64': { version: 'v22.23.2' } })
    expect(after).toEqual({ node: { 'darwin-arm64': { version: 'v22.23.2' }, 'win32-x64': { version: 'v22.23.2' }, 'win32-arm64': { version: 'v22.23.2' } }, other: { kept: true } })
    expect(before.node['win32-x64'].version).toBe('v22.0.0')
    expect(mergePlatforms({ node: 'garbage' }, 'node', { 'win32-x64': {} })).toEqual({ node: { 'win32-x64': {} } })
  })

  it('replaces one top-level key whole, as the staging CLI manifest takes the released `cli` entry', () => {
    expect(mergeKey({ cli: { version: '1' }, commander: { version: 'c' } }, 'cli', { version: '2' })).toEqual({ cli: { version: '2' }, commander: { version: 'c' } })
  })

  it('accepts only an entry a daemon or the installer would trust', () => {
    const good = { version: '1.2.3', url: 'https://cdn.example/a.zip', sha256: sha, size: '10' }
    expect(runtimeEntry(good)).toEqual({ version: '1.2.3', url: 'https://cdn.example/a.zip', sha256: sha, size: 10 })
    expect(runtimeEntry({ ...good, archiveRoot: 'node-v1' })).toMatchObject({ archiveRoot: 'node-v1' })
    expect(() => runtimeEntry({ ...good, url: 'http://cdn.example/a.zip' })).toThrow('https')
    expect(() => runtimeEntry({ ...good, sha256: 'ABC' })).toThrow('sha256')
    expect(() => runtimeEntry({ ...good, size: '0' })).toThrow('size')
    expect(() => runtimeEntry({ ...good, version: '' })).toThrow('version')
  })

  it('does the same from the command line the shell scripts use', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-runtime-manifest-'))
    dirs.push(dir)
    const entries = join(dir, 'entries.json')
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    expect(run('entry', entries, 'win32-x64', '1.2.3', 'https://cdn.example/a.zip', sha, '10').status).toBe(0)
    writeFileSync(join(dir, 'src.json'), JSON.stringify({ pty: { 'win32-arm64': { version: '1.2.2' } } }))
    expect(run('platforms', join(dir, 'src.json'), join(dir, 'dst.json'), 'pty', entries).status).toBe(0)
    expect(JSON.parse(readFileSync(join(dir, 'dst.json'), 'utf8'))).toEqual({
      pty: { 'win32-arm64': { version: '1.2.2' }, 'win32-x64': { version: '1.2.3', url: 'https://cdn.example/a.zip', sha256: sha, size: 10 } },
    })
    // A missing source is an empty manifest: the first publish to a new prefix.
    expect(run('platforms', join(dir, 'missing.json'), join(dir, 'fresh.json'), 'pty', entries).status).toBe(0)
    const bad = run('entry', entries, 'win32-x64', '1.2.3', 'http://plain', sha, '10')
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('https')
  })

  // Carried B1.13 / final review R3-3: run through a symlinked folder (a checkout under a linked home), the main guard
  // compared the real path with the linked one, and the helper exited 0 having written nothing. In the publish scripts the
  // zips are uploaded before the manifest is made, so that left immutable objects with no manifest.
  it.skipIf(process.platform === 'win32')('runs its command when started through a symlinked path, as each helper does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-runtime-manifest-'))
    dirs.push(dir)
    const linked = join(dir, 'scripts')
    symlinkSync(join(process.cwd(), 'scripts'), linked)
    const entries = join(dir, 'entries.json')
    const result = spawnSync(process.execPath, [join(linked, 'lib', 'runtimeManifest.mjs'), 'entry', entries, 'win32-x64', '1.2.3', 'https://cdn.example/a.zip', sha, '10'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(entries)).toBe(true)
    const manifest = spawnSync(process.execPath, [join(linked, 'windows-install-manifest.mjs')], { encoding: 'utf8' })
    // Its main ran: it says what it needs, where before it printed nothing and exited 0.
    expect(manifest.status).not.toBe(0)
    expect(manifest.stderr).toMatch(/error:/)
  })

  it('reads a missing or empty manifest as empty, and refuses a malformed one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-runtime-manifest-'))
    dirs.push(dir)
    expect(readDocument(join(dir, 'missing.json'))).toEqual({})
    writeFileSync(join(dir, 'empty.json'), '  \n')
    expect(readDocument(join(dir, 'empty.json'))).toEqual({})
    writeFileSync(join(dir, 'bad.json'), '{"node": ')
    expect(() => readDocument(join(dir, 'bad.json'))).toThrow()
    writeFileSync(join(dir, 'array.json'), '[]')
    expect(() => readDocument(join(dir, 'array.json'))).toThrow('object')
    const cli = spawnSync(process.execPath, [script, 'platforms', join(dir, 'bad.json'), join(dir, 'out.json'), 'pty', join(dir, 'empty.json')], { encoding: 'utf8' })
    expect(cli.status).toBe(1)
  })
})

/** Current core authority and durable publication, using only disposable files and injected rows. */
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import type { PreparedHandoff } from '../lib/handoffAuthority.js'
vi.mock('node:fs', async original => ({ ...await original<object>() }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in publication fixtures') }
  return { exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
let root: string, cwd: string, data: string, row: RegisteredSession
const CHANGE = '1'.repeat(32)
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'handoff-publication-')))
  cwd = join(root, 'project'); data = join(root, 'data')
  fs.mkdirSync(cwd, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 })
  row = { agentId: 'selected', engine: 'opencode', sessionId: 'ses-fixture', cwd, transcriptPath: null,
    registeredAt: 1, boundAt: 1, codexHome: null, hermesHome: null, processIdentity: null } as RegisteredSession
  vi.resetModules()
})
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); fs.rmSync(root, { recursive: true, force: true }) })
async function setup(git = false) {
  const { createHandoffPublisher } = await import('./handoffPublication.js')
  const { handoffSessionFact, handoffExcludeText } = await import('../lib/handoffAuthority.js')
  const { NativeFiles } = await import('../engines/kit/nativeFiles.js')
  const { nativeFileKey } = await import('../engines/kit/nativePaths.js')
  const { handoffGitRoute } = await import('../lib/handoffGit.js')
  const { readHandoffFile } = await import('../lib/handoffFiles.js')
  const exclusion = join(cwd, '.git', 'info', 'exclude')
  if (git) { fs.mkdirSync(dirname(exclusion), { recursive: true, mode: 0o700 }); fs.writeFileSync(exclusion, '# retained\n', { mode: 0o600 }) }
  const files = new NativeFiles(), project = files.locate(cwd)!
  const old = git ? readHandoffFile(exclusion, 128 * 1024) : null
  const prepared: PreparedHandoff = { request: { agentId: row.agentId, changeId: CHANGE, targetEngine: 'claude' },
    sessions: [handoffSessionFact(row)], reads: [], project: { cwd, path: cwd, fileKey: nativeFileKey(project.info), route: files.paths.snapshot() },
    git: handoffGitRoute(cwd), result: { cwd, gitRepo: git, file: `.harness/handoff/selected-${CHANGE}.md`, degraded: git ? [] : ['git'] },
    documents: { markdown: 'The reviewed handoff\n', transcript: 'The reviewed transcript\n' },
    exclude: old && { path: exclusion, before: old.text, after: handoffExcludeText(old.text), version: old.version, route: old.route } }
  const rows = new Map([[row.agentId, row]])
  const deps = { directory: data, resolve: (id: string) => rows.get(id), ownedByOther: () => false, isRecentlyDeleted: () => false }
  const permit = { current: () => true }, publish = createHandoffPublisher(deps)
  return { prepared, permit, publish, deps, rows, exclusion, create: () => createHandoffPublisher(deps) }
}

it.each(['reservation write', 'reservation sync', 'project directory sync', 'partial stage', 'exclude rename', 'transcript link', 'committed receipt sync'])
('recovers the same intent after %s fails, including a fresh core instance', async fault => {
  const ctx = await setup(true), original = structuredClone(ctx.prepared)
  const open = fs.openSync, write = fs.writeFileSync, rename = fs.renameSync, link = fs.linkSync, flush = fs.fsyncSync
  const paths = new Map<number, string>()
  let fired = false, reserved = false, committed = false, recoverySyncs = 0
  const fail = () => { fired = true; throw Object.assign(new Error('injected publication interruption'), { code: 'EIO' }) }
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args); paths.set(fd, String(args[0])); return fd
  })
  vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
    const path = typeof args[0] === 'number' ? paths.get(args[0]) ?? '' : String(args[0])
    if (!fired && fault === 'reservation write' && path.includes('handoff-receipts') && path.endsWith('.tmp')) {
      write(args[0], '{'); fail()
    }
    if (!fired && fault === 'partial stage' && path.endsWith('.stage') && String(args[1]) === original.documents!.transcript) {
      write(args[0], 'The'); fail()
    }
    return write(...args)
  })
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    link(from, to)
    if (String(to).includes('handoff-receipts') && String(to).endsWith('.json')) reserved = true
    if (!fired && fault === 'transcript link' && String(to).endsWith('.transcript.md')) fail()
  })
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).includes('handoff-receipts') && JSON.parse(fs.readFileSync(from, 'utf8')).committed) committed = true
    rename(from, to)
    if (!fired && fault === 'exclude rename' && to === ctx.exclusion) fail()
  })
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    const path = paths.get(fd)
    if (fired) recoverySyncs++
    if (!fired && (fault === 'reservation sync' && reserved && path === join(data, 'handoff-receipts')
      || fault === 'project directory sync' && path === cwd && fs.existsSync(join(cwd, '.harness'))
      || fault === 'committed receipt sync' && committed && path === join(data, 'handoff-receipts'))) fail()
    flush(fd)
  })
  expect(() => ctx.publish(ctx.prepared, ctx.permit)).toThrow()
  expect(fired).toBe(true)
  expect(ctx.create()(original, ctx.permit)).toEqual(original.result)
  expect(recoverySyncs).toBeGreaterThan(0)
  expect(fs.readFileSync(join(cwd, original.result.file!), 'utf8')).toBe(original.documents!.markdown)
  expect(fs.readFileSync(join(cwd, original.result.file!.replace(/\.md$/, '.transcript.md')), 'utf8')).toBe(original.documents!.transcript)
  expect(fs.readFileSync(ctx.exclusion, 'utf8')).toBe(original.exclude!.after)
  expect(ctx.create()(original, ctx.permit)).toEqual(original.result)
})

it('never adopts or overwrites a public file without its durable intent receipt', async () => {
  const ctx = await setup(), target = join(cwd, ctx.prepared.result.file!)
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, 'Someone else owns this', { mode: 0o600 })
  expect(() => ctx.publish(ctx.prepared, ctx.permit)).toThrow()
  expect(fs.readFileSync(target, 'utf8')).toBe('Someone else owns this')
})

it('holds changed public content and a changed project route on a completed retry', async () => {
  const ctx = await setup(), target = join(cwd, ctx.prepared.result.file!)
  ctx.publish(ctx.prepared, ctx.permit)
  fs.writeFileSync(target, 'Changed after publication')
  expect(() => ctx.create()(ctx.prepared, ctx.permit)).toThrow()
  expect(fs.readFileSync(target, 'utf8')).toBe('Changed after publication')
  fs.renameSync(cwd, cwd + '-original'); fs.mkdirSync(cwd)
  expect(() => ctx.create()(ctx.prepared, ctx.permit)).toThrow()
  expect(fs.readdirSync(cwd)).toEqual([])
})

it.each(['directory', 'over limit', 'symlink'])('holds an exclusion that is %s before project writes', async fault => {
  const ctx = await setup(true)
  fs.renameSync(ctx.exclusion, ctx.exclusion + '.original')
  if (fault === 'directory') fs.mkdirSync(ctx.exclusion)
  if (fault === 'over limit') fs.writeFileSync(ctx.exclusion, 'x'.repeat(130 * 1024))
  if (fault === 'symlink') fs.symlinkSync(ctx.exclusion + '.original', ctx.exclusion)
  expect(() => ctx.publish(ctx.prepared, ctx.permit)).toThrow()
  expect(fs.existsSync(join(cwd, '.harness'))).toBe(false)
  expect(fs.readFileSync(ctx.exclusion + '.original', 'utf8')).toBe('# retained\n')
})

it.each(['ignore changed', 'ignore removed', 'ignore replaced', 'exclude changed', 'exclude removed', 'exclude replaced'])
('holds completed publication when %s, preserving the changed filesystem', async fault => {
  const ctx = await setup(true)
  ctx.publish(ctx.prepared, ctx.permit)
  const target = fault.startsWith('ignore') ? join(cwd, '.harness', 'handoff', '.gitignore') : ctx.exclusion
  const original = fs.readFileSync(target, 'utf8')
  if (fault.endsWith('changed')) fs.writeFileSync(target, 'User changes\n')
  else {
    fs.renameSync(target, target + '.kept')
    if (fault.endsWith('replaced')) fs.writeFileSync(target, original, { mode: 0o600 })
  }
  expect(() => ctx.create()(ctx.prepared, ctx.permit)).toThrow()
  if (fault.endsWith('removed')) expect(fs.existsSync(target)).toBe(false)
  else expect(fs.readFileSync(target, 'utf8')).toBe(fault.endsWith('changed') ? 'User changes\n' : original)
})

it('rechecks exclusions changed between the last document link and commit', async () => {
  const ctx = await setup(true), link = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    link(from, to)
    if (to === join(cwd, ctx.prepared.result.file!)) fs.writeFileSync(ctx.exclusion, 'User changes\n')
  })
  expect(() => ctx.publish(ctx.prepared, ctx.permit)).toThrow()
  const receipt = fs.readdirSync(join(data, 'handoff-receipts')).find(name => name.endsWith('.json'))!
  expect(JSON.parse(fs.readFileSync(join(data, 'handoff-receipts', receipt), 'utf8')).committed).toBe(false)
  expect(fs.readFileSync(ctx.exclusion, 'utf8')).toBe('User changes\n')
})

it.each(['preparation', 'request', 'session', 'project', 'route', 'alias', 'git', 'git file', 'result', 'documents', 'exclude'])
('rejects unbounded unknown %s fields before filesystem effects', async where => {
  const ctx = await setup(true), p = ctx.prepared as unknown as Record<string, any>
  const targets: Record<string, Record<string, unknown>> = { preparation: p, request: p.request, session: p.sessions[0],
    project: p.project, route: p.project.route[0], git: p.git, result: p.result, documents: p.documents, exclude: p.exclude }
  if (where === 'alias') { p.project.route[0].alias = { target: '/fixture', version: '1' }; targets.alias = p.project.route[0].alias }
  if (where === 'git file') { p.git.files = [{ path: '/fixture', version: '1' }]; targets['git file'] = p.git.files[0] }
  targets[where].extra = 'x'.repeat(1024 * 1024)
  expect(() => ctx.publish(ctx.prepared, ctx.permit)).toThrow()
  expect(fs.readdirSync(data)).toEqual([]); expect(fs.existsSync(join(cwd, '.harness'))).toBe(false)
})

/** Current core authority and durable publication, using only disposable files and injected rows. */
import * as fs from 'node:fs'
import * as timers from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import type { PreparedHandoff } from '../lib/handoffAuthority.js'
vi.mock('node:fs', async original => ({ ...await original<object>() }))
vi.mock('node:timers/promises', async original => ({ ...await original<object>() }))
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
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(fired).toBe(true)
  expect(await ctx.create()(original, ctx.permit)).toEqual(original.result)
  expect(recoverySyncs).toBeGreaterThan(0)
  expect(fs.readFileSync(join(cwd, original.result.file!), 'utf8')).toBe(original.documents!.markdown)
  expect(fs.readFileSync(join(cwd, original.result.file!.replace(/\.md$/, '.transcript.md')), 'utf8')).toBe(original.documents!.transcript)
  expect(fs.readFileSync(ctx.exclusion, 'utf8')).toBe(original.exclude!.after)
  expect(await ctx.create()(original, ctx.permit)).toEqual(original.result)
})

it('never adopts or overwrites a public file without its durable intent receipt', async () => {
  const ctx = await setup(), target = join(cwd, ctx.prepared.result.file!)
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, 'Someone else owns this', { mode: 0o600 })
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(fs.readFileSync(target, 'utf8')).toBe('Someone else owns this')
})

it('does not write a staged descriptor opened under a temporarily substituted project directory', async () => {
  const ctx = await setup(), open = fs.openSync, folder = join(cwd, '.harness', 'handoff')
  let foreign: string | undefined
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    const name = String(args[0])
    if (foreign || !name.endsWith('.stage') || dirname(name) !== folder) return open(...args)
    fs.renameSync(folder, folder + '.retained'); fs.mkdirSync(folder, { mode: 0o700 })
    const fd = open(...args)
    fs.renameSync(folder, folder + '.foreign'); fs.renameSync(folder + '.retained', folder)
    foreign = name.replace(folder, folder + '.foreign')
    return fd
  })
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(foreign).toBeTypeOf('string')
  expect(fs.readFileSync(foreign!, 'utf8')).toBe('')
  expect(fs.existsSync(join(cwd, ctx.prepared.result.file!))).toBe(false)
  expect(await ctx.create()(ctx.prepared, ctx.permit)).toEqual(ctx.prepared.result)
})

it('holds changed public content and a changed project route on a completed retry', async () => {
  const ctx = await setup(), target = join(cwd, ctx.prepared.result.file!)
  await ctx.publish(ctx.prepared, ctx.permit)
  fs.writeFileSync(target, 'Changed after publication')
  await expect(ctx.create()(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(fs.readFileSync(target, 'utf8')).toBe('Changed after publication')
  fs.renameSync(cwd, cwd + '-original'); fs.mkdirSync(cwd)
  await expect(ctx.create()(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(fs.readdirSync(cwd)).toEqual([])
})

it.each(['directory', 'over limit', 'symlink'])('holds an exclusion that is %s before project writes', async fault => {
  const ctx = await setup(true)
  fs.renameSync(ctx.exclusion, ctx.exclusion + '.original')
  if (fault === 'directory') fs.mkdirSync(ctx.exclusion)
  if (fault === 'over limit') fs.writeFileSync(ctx.exclusion, 'x'.repeat(130 * 1024))
  if (fault === 'symlink') fs.symlinkSync(ctx.exclusion + '.original', ctx.exclusion)
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(fs.existsSync(join(cwd, '.harness'))).toBe(false)
  expect(fs.readFileSync(ctx.exclusion + '.original', 'utf8')).toBe('# retained\n')
})

it.each(['ignore changed', 'ignore removed', 'ignore replaced', 'exclude changed', 'exclude removed', 'exclude replaced'])
('holds completed publication when %s, preserving the changed filesystem', async fault => {
  const ctx = await setup(true)
  await ctx.publish(ctx.prepared, ctx.permit)
  const target = fault.startsWith('ignore') ? join(cwd, '.harness', 'handoff', '.gitignore') : ctx.exclusion
  const original = fs.readFileSync(target, 'utf8')
  if (fault.endsWith('changed')) fs.writeFileSync(target, 'User changes\n')
  else {
    fs.renameSync(target, target + '.kept')
    if (fault.endsWith('replaced')) fs.writeFileSync(target, original, { mode: 0o600 })
  }
  await expect(ctx.create()(ctx.prepared, ctx.permit)).rejects.toThrow()
  if (fault.endsWith('removed')) expect(fs.existsSync(target)).toBe(false)
  else expect(fs.readFileSync(target, 'utf8')).toBe(fault.endsWith('changed') ? 'User changes\n' : original)
})

it('rechecks exclusions changed between the last document link and commit', async () => {
  const ctx = await setup(true), link = fs.linkSync
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    link(from, to)
    if (to === join(cwd, ctx.prepared.result.file!)) fs.writeFileSync(ctx.exclusion, 'User changes\n')
  })
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
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
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(fs.readdirSync(data)).toEqual([]); expect(fs.existsSync(join(cwd, '.harness'))).toBe(false)
})

it.each(['request', 'source', 'receipt', 'project'].flatMap(fault => Array.from({ length: 7 }, (_, index) => [fault, index + 1] as const))
  .concat([3, 4, 5, 6, 7].map(stage => ['ignore', stage] as const), [4, 5, 6, 7].map(stage => ['exclude', stage] as const)))
('holds a changed %s at publication checkpoint %s before another public write', async (fault, stage) => {
  const ctx = await setup(true), yieldLoop = timers.setImmediate, link = fs.linkSync, rename = fs.renameSync
  let count = 0, revoked = false, current = true, writes = 0
  ctx.permit.current = () => current
  const publicPath = (path: fs.PathLike) => String(path) === ctx.exclusion || String(path) === join(cwd, '.harness', 'handoff', '.gitignore')
    || String(path).endsWith('.md')
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => { if (revoked && publicPath(to)) writes++; link(from, to) })
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (revoked && publicPath(to)) writes++; rename(from, to) })
  vi.spyOn(timers, 'setImmediate').mockImplementation(async () => {
    await yieldLoop()
    if (++count !== stage) return
    if (fault === 'request') current = false
    if (fault === 'source') ctx.rows.set(row.agentId, { ...row, boundAt: 2 })
    if (fault === 'receipt') {
      const name = fs.readdirSync(join(data, 'handoff-receipts')).find(name => name.endsWith('.json'))!
      fs.writeFileSync(join(data, 'handoff-receipts', name), '{}')
    }
    if (fault === 'project') { rename(cwd, cwd + '.original'); fs.mkdirSync(cwd) }
    if (fault === 'ignore') fs.writeFileSync(join(cwd, '.harness', 'handoff', '.gitignore'), 'User changes\n')
    if (fault === 'exclude') fs.writeFileSync(ctx.exclusion, 'User changes\n')
    revoked = true
  })
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(revoked).toBe(true); expect(writes).toBe(0)
  if (fault === 'request' || fault === 'source') {
    current = true; ctx.rows.set(row.agentId, row); revoked = false
    expect(await ctx.create()(ctx.prepared, ctx.permit)).toEqual(ctx.prepared.result)
  }
})

it.each(['ignore guard', 'exclusion guard', 'final confirmation'])('holds a request that expires during a synchronous %s', async fault => {
  const ctx = await setup(true), open = fs.openSync, flush = fs.fsyncSync, link = fs.linkSync, rename = fs.renameSync
  const yieldLoop = timers.setImmediate, paths = new Map<number, string>(), document = join(cwd, ctx.prepared.result.file!)
  let clock = 0, fired = false, checkpoint = 0, ignoreSyncs = 0, excludeSyncs = 0, lateWrites = 0
  ctx.permit.current = () => clock < 5_000
  vi.spyOn(timers, 'setImmediate').mockImplementation(async () => { await yieldLoop(); checkpoint++ })
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => { const fd = open(...args); paths.set(fd, String(args[0])); return fd })
  const visible = (path: fs.PathLike) => String(path) === ctx.exclusion || String(path).endsWith('.md') || String(path).endsWith('/.gitignore')
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => { if (clock && visible(to)) lateWrites++; link(from, to) })
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => { if (clock && visible(to)) lateWrites++; rename(from, to) })
  vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    const path = paths.get(fd)
    if (path?.endsWith('/.gitignore')) ignoreSyncs++
    if (path === ctx.exclusion) excludeSyncs++
    if (!fired && (fault === 'ignore guard' && path?.endsWith('/.gitignore') && ignoreSyncs === 2
      || fault === 'exclusion guard' && path === ctx.exclusion && excludeSyncs === 2
      || fault === 'final confirmation' && path === document && checkpoint === 7)) {
      fired = true; clock = 5_001
    }
    flush(fd)
  })
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toMatchObject({ code: 'HANDOFF_UNAVAILABLE' })
  expect(fired).toBe(true); expect(lateWrites).toBe(0)
  clock = 0
  expect(await ctx.create()(ctx.prepared, ctx.permit)).toEqual(ctx.prepared.result)
})

async function peer(ctx: Awaited<ReturnType<typeof setup>>, sameProject: boolean) {
  const { handoffSessionFact } = await import('../lib/handoffAuthority.js')
  const { NativeFiles } = await import('../engines/kit/nativeFiles.js')
  const { nativeFileKey } = await import('../engines/kit/nativePaths.js')
  const { handoffGitRoute } = await import('../lib/handoffGit.js')
  const otherCwd = sameProject ? cwd : join(cwd, 'subproject')
  if (!sameProject) fs.mkdirSync(otherCwd)
  const other = { ...row, agentId: 'peer', cwd: otherCwd }
  ctx.rows.set(other.agentId, other)
  const files = new NativeFiles(), project = files.locate(otherCwd)!
  return { ...structuredClone(ctx.prepared), request: { ...ctx.prepared.request, agentId: other.agentId }, sessions: [handoffSessionFact(other)],
    project: { cwd: otherCwd, path: project.path, fileKey: nativeFileKey(project.info), route: files.paths.snapshot() }, git: handoffGitRoute(otherCwd),
    result: { ...ctx.prepared.result, cwd: otherCwd, file: `.harness/handoff/peer-${CHANGE}.md` } }
}
async function refreshExclude(prepared: PreparedHandoff) {
  const { readHandoffFile } = await import('../lib/handoffFiles.js')
  const { handoffExcludeText } = await import('../lib/handoffAuthority.js')
  const current = readHandoffFile(prepared.exclude!.path, 128 * 1024)
  return { ...prepared, exclude: { path: current.path, before: current.text, after: handoffExcludeText(current.text), version: current.version, route: current.route } }
}

it.each([true, false])('serializes publication and refreshes a stale shared exclusion (same project: %s)', async sameProject => {
  const ctx = await setup(true), second = await peer(ctx, sameProject)
  const pending = ctx.publish(ctx.prepared, ctx.permit)
  await expect(ctx.publish(second, ctx.permit)).rejects.toMatchObject({ code: 'BUSY' })
  expect(await pending).toEqual(ctx.prepared.result)
  await expect(ctx.publish(second, ctx.permit)).rejects.toThrow()
  expect(fs.readdirSync(join(data, 'handoff-receipts')).filter(name => name.endsWith('.json'))).toHaveLength(1)
  expect(await ctx.publish(await refreshExclude(second), ctx.permit)).toEqual(second.result)
})

it('finishes its retained snapshot after interruption and a peer completes the shared exclusion', async () => {
  const ctx = await setup(true), second = await peer(ctx, false), yieldLoop = timers.setImmediate
  vi.spyOn(timers, 'setImmediate').mockRejectedValueOnce(Error('lost request after reservation')).mockImplementation(yieldLoop)
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(await ctx.publish(second, ctx.permit)).toEqual(second.result)
  const fresh = await refreshExclude(ctx.prepared)
  fresh.documents!.markdown = 'A later preparation must not replace the reserved snapshot'
  await expect(ctx.create()(fresh, ctx.permit)).resolves.toEqual(ctx.prepared.result)
  expect(fs.readFileSync(join(cwd, fresh.result.file!), 'utf8')).toBe('The reviewed handoff\n')
})

it.each(['exclusion reservation', 'exclusion rename'])('recovers after %s and a peer publishes through the shared exclusion', async fault => {
  const ctx = await setup(true), second = await peer(ctx, false), rename = fs.renameSync
  let fired = false
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to)
    if (!fired && (fault === 'exclusion rename' ? String(to) === ctx.exclusion
      : String(to).includes('handoff-receipts') && JSON.parse(fs.readFileSync(to, 'utf8')).exclude !== null)) {
      fired = true; throw Error('Interrupted after exclusion progress')
    }
  })
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toThrow()
  expect(fired).toBe(true)
  fs.appendFileSync(ctx.exclusion, '# A user addition must survive\n')
  expect(await ctx.publish(await refreshExclude(second), ctx.permit)).toEqual(second.result)
  const preserved = fs.readFileSync(ctx.exclusion, 'utf8'), fresh = await refreshExclude(ctx.prepared)
  fresh.documents!.markdown = 'Later history must not replace the original snapshot'
  await expect(ctx.create()(fresh, ctx.permit)).resolves.toEqual(ctx.prepared.result)
  expect(fs.readFileSync(ctx.exclusion, 'utf8')).toBe(preserved)
  expect(fs.readFileSync(join(cwd, fresh.result.file!), 'utf8')).toBe('The reviewed handoff\n')
})

it.each(['project key', 'project path', 'missing project route', 'Git metadata', 'Git flag', 'missing exclusion', 'exclusion path', 'exclusion contents'])
('rejects an altered %s before reserving the intent', async field => {
  const ctx = await setup(true), p = ctx.prepared
  if (field === 'project key') p.project.fileKey = '1:2'
  if (field === 'project path') p.project.path = data
  if (field === 'missing project route') p.project.route = p.project.route.slice(1)
  if (field === 'Git metadata') p.git.route = p.git.route.slice(1)
  if (field === 'Git flag') p.result.gitRepo = false
  if (field === 'missing exclusion') p.exclude = null
  if (field === 'exclusion path') p.exclude!.path = join(cwd, 'other-exclude')
  if (field === 'exclusion contents') p.exclude!.after = 'Discard the original file'
  await expect(ctx.publish(p, ctx.permit)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(fs.readdirSync(data)).toEqual([])
})

it('bounds discovery and by-ID selection witnesses without evicting a fresh selection', async () => {
  const ctx = await setup(), { createHandoffPublisher } = await import('./handoffPublication.js')
  let now = 0
  const publish = createHandoffPublisher({ ...ctx.deps, now: () => now })
  for (let index = 0; index < 128; index++) {
    publish.observed({ ...row, agentId: `agent-${index}` }, null)
    publish.selected('codex', `session-${index}`, undefined, '/fixture')
  }
  expect(() => publish.observed({ ...row, agentId: 'extra' }, null)).toThrow()
  expect(() => publish.selected('codex', 'extra', undefined, null)).toThrow()
  publish.observed({ ...row, agentId: 'agent-0' }, null)
  publish.selected('codex', 'session-0', undefined, '/fixture')
  now = 5_001
  publish.observed({ ...row, agentId: 'extra' }, null)
  publish.selected('codex', 'extra', '/profile', null)
  row.sessionId = ''
  const { handoffSessionFact } = await import('../lib/handoffAuthority.js')
  ctx.prepared.sessions = [handoffSessionFact(row)]
  ctx.prepared.documents = null; ctx.prepared.result.file = null
  publish.observed(row, null)
  now += 5_001
  await expect(publish(ctx.prepared, ctx.permit)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  publish.observed(row, null)
  expect(await publish(ctx.prepared, ctx.permit)).toEqual(ctx.prepared.result)
})

it('holds an unserializable inline preparation without filesystem effects', async () => {
  const ctx = await setup()
  await expect(ctx.publish(new Proxy(ctx.prepared, {}), ctx.permit)).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(fs.readdirSync(data)).toEqual([])
})

it('rechecks request lifetime after reading current authority', async () => {
  const ctx = await setup()
  let current = true
  ctx.permit.current = () => current
  ctx.deps.resolve = id => { current = false; return ctx.rows.get(id) }
  await expect(ctx.publish(ctx.prepared, ctx.permit)).rejects.toMatchObject({ code: 'HANDOFF_UNAVAILABLE' })
  expect(fs.readdirSync(data)).toEqual([])
})

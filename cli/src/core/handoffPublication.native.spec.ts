/** Real private transcripts exercise Change agent's identity boundary, including descriptor ABA. */
import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'

const fixtureGit = vi.hoisted(() => ({ enabled: false }))
vi.mock('node:child_process', () => {
  const forbidden = () => { throw Error('Host binaries are forbidden in native handoff fixtures') }
  const execFile = Object.assign(() => forbidden(), { [Symbol.for('nodejs.util.promisify.custom')]: async (command: string, args: string[]) => {
    if (!fixtureGit.enabled || command !== 'git') return forbidden()
    const stdout = args.includes('--is-inside-work-tree') ? 'true\n' : args.includes('--git-path') ? '.git/info/exclude\n'
      : args.includes('--abbrev-ref') ? 'fixture\n' : args.includes('--short') ? 'a1b2c3\n' : ''
    return { stdout, stderr: '' }
  } })
  return { execFile, execFileSync: forbidden, exec: forbidden, execSync: forbidden,
    spawn: forbidden, spawnSync: forbidden, fork: forbidden }
})
vi.mock('node:fs/promises', async original => ({ ...await original<object>() }))
vi.mock('node:fs', async original => ({ ...await original<object>() }))
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
const CHANGE = '1'.repeat(32), AT = Date.parse('2026-10-10T08:00:00Z')
let root: string, cwd: string, path: string, catalog: string, row: RegisteredSession
const write = (file: string, text: string) => { fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }) }
const transcript = (id = ID, text = 'Keep the reviewed conversation', source: unknown = 'cli') => [
  { type: 'session_meta', payload: { id, cwd, source } },
  { timestamp: '2026-10-10T07:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: text } },
  { timestamp: '2026-10-10T07:00:01Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Reviewed answer' } },
  { timestamp: '2026-10-10T07:00:02Z', type: 'event_msg', payload: { type: 'task_complete' } },
].map(line => JSON.stringify(line)).join('\n') + '\n'

beforeEach(() => {
  fixtureGit.enabled = false
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'native-handoff-authority-'))); cwd = join(root, 'project')
  for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'PI_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) {
    vi.stubEnv(name, join(root, name)); fs.mkdirSync(join(root, name), { recursive: true, mode: 0o700 })
  }
  vi.stubEnv('TZ', 'UTC'); fs.mkdirSync(cwd)
  catalog = join(root, 'ADAPTER_DATA_DIR', 'engine-homes.json'); write(catalog, '{}')
  path = join(root, 'CODEX_HOME', 'sessions', `${ID}.jsonl`); write(path, transcript())
  row = { agentId: 'selected', sessionId: ID, engine: 'codex', cwd, transcriptPath: path,
    registeredAt: AT, boundAt: AT, codexHome: null, hermesHome: null, processIdentity: null,
    runtimes: [{ backend: 'tmux', paneId: '%1' }] } as RegisteredSession
  vi.resetModules()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); fs.rmSync(root, { recursive: true, force: true }) })

async function setup(rows = [row], found = true) {
  const { prepareAgentHandoff } = await import('../lib/agentHandoff.js')
  const { createHandoffDependencies } = await import('./handoffDependencies.js')
  const { validTranscriptPath } = await import('../lib/registry.js')
  const current = new Map(rows.map(entry => [entry.agentId, entry]))
  const saved = new Map<string, RegisteredSession>()
  // Real registry/store methods use their receiver. Composition must preserve it.
  class Registry {
    constructor(readonly rows: Map<string, RegisteredSession>) {}
    resolve(id: string) { return structuredClone(this.rows.get(id)) }
    byAgent(id: string) { return this.rows.get(id) }
    bySession(id: string) { return [...this.rows.values()].find(row => row.sessionId === id) }
  }
  class Stopped {
    constructor(readonly rows: Map<string, RegisteredSession>) {}
    get(id: string) { return this.rows.get(id) ?? null }
    ids() { return [...this.rows.keys()] }
  }
  const deps = createHandoffDependencies({
    registry: new Registry(current), stopped: new Stopped(saved),
    mirror: { recentAsks: () => ['A mirror must not bypass unknown native identity'], lastFullText: () => undefined, recent: () => [] },
    databaseHistory: () => undefined, findLiveSession: async () => found ? ({ sessionId: ID, transcriptPath: path }) : null,
    processSession: async () => null, isRecentlyDeleted: () => false, findResumedTranscript: async () => path, validTranscriptPath,
  }, join(root, 'ADAPTER_DATA_DIR'))
  return { current, saved, deps, prepare: () => prepareAgentHandoff(deps, { agentId: row.agentId, targetEngine: 'claude', changeId: CHANGE }) }
}

const noPublication = () => expect(fs.existsSync(join(cwd, '.harness', 'handoff'))).toBe(false)

it.each(['wrong header', 'incomplete header', 'delegated header', 'unavailable catalog'])('holds an own handoff with %s, without a mirror fallback', async fault => {
  const ctx = await setup()
  if (fault === 'wrong header') write(path, transcript(OTHER))
  if (fault === 'incomplete header') write(path, '{"type":"session_meta","payload":')
  if (fault === 'delegated header') write(path, transcript(ID, 'Delegated work', { subagent: { thread_spawn: { parent_thread_id: OTHER } } }))
  if (fault === 'unavailable catalog') write(catalog, '{')
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  noPublication()
})

it('reads only the exact opened descriptor when a pathname moves away and back around open', async () => {
  const ctx = await setup(), open = promises.open
  let swapped = false
  vi.spyOn(promises, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) !== path || swapped) return open(...args)
    swapped = true
    fs.renameSync(path, path + '.original'); write(path, transcript(OTHER, 'Unreviewed private conversation'))
    try { return await open(...args) }
    finally { fs.renameSync(path, path + '.foreign'); fs.renameSync(path + '.original', path) }
  })
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(swapped).toBe(true); noPublication()
  expect(fs.readFileSync(path, 'utf8')).toBe(transcript())
})

it.each(['same-inode header', 'same-header body', 'catalog', 'binding', 'runtime'])('holds before publishing when %s changes after its asynchronous read', async fault => {
  const ctx = await setup()
  ctx.deps.lastFullText = async () => {
    await Promise.resolve()
    if (fault === 'same-inode header') write(path, transcript(OTHER))
    if (fault === 'same-header body') write(path, transcript(ID, 'Replaced conversation body'))
    if (fault === 'catalog') write(catalog, '{')
    if (fault === 'binding') ctx.current.set(row.agentId, { ...row, boundAt: AT + 1 })
    if (fault === 'runtime') ctx.current.set(row.agentId, { ...row, runtimes: [{ backend: 'tmux', paneId: '%2' }] })
    return undefined
  }
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  noPublication()
})

it('keeps an existing handoff unchanged while its native identity is unavailable and recovers on the same request', async () => {
  const ctx = await setup(), original = transcript()
  const result = await ctx.prepare()
  expect(result.file).toBeTypeOf('string')
  const file = join(cwd, result.file!), before = fs.readFileSync(file, 'utf8')
  write(path, transcript(OTHER))
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
  write(path, original)
  expect(await ctx.prepare()).toMatchObject({ file: result.file })
  expect(fs.readFileSync(file, 'utf8')).toBe(before)
})

it('rejects a body rewrite during the final native header fence before any reservation', async () => {
  const ctx = await setup(), bindings = await import('../engines/transcriptBindings.js')
  const evidence = bindings.controlTranscriptEvidence
  let armed = false, fired = false
  ctx.deps.lastFullText = () => { armed = true; return undefined }
  vi.spyOn(bindings, 'controlTranscriptEvidence').mockImplementation((...args) => {
    const proof = evidence(...args)
    return { ...proof, verify: key => {
      proof.verify(key)
      if (armed && !fired) { fired = true; write(path, transcript(ID, 'Rewritten during the final fence')) }
    } }
  })
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  expect(fired).toBe(true); noPublication()
  expect(fs.existsSync(join(root, 'ADAPTER_DATA_DIR', 'handoff-receipts'))).toBe(false)
})

it.each(['reservation', 'transcript link'])('recovers a durably reserved native snapshot after %s interruption and append', async fault => {
  const ctx = await setup(), link = fs.linkSync
  let fired = false
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    link(from, to)
    if (!fired && (fault === 'reservation' ? String(to).includes('handoff-receipts') && String(to).endsWith('.json') : String(to).endsWith('.transcript.md'))) {
      fired = true; throw Object.assign(Error('interrupted after the owned link'), { code: 'EIO' })
    }
  })
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'HANDOFF_UNAVAILABLE' })
  expect(fired).toBe(true)
  fs.appendFileSync(path, JSON.stringify({ timestamp: '2026-10-10T07:00:05Z', type: 'event_msg', payload: { type: 'user_message', message: 'Appended after the snapshot' } }) + '\n')
  const fresh = await setup(), result = await fresh.prepare()
  expect(result.file).toBeTypeOf('string')
  const text = fs.readFileSync(join(cwd, result.file!), 'utf8')
  expect(text).toContain('Keep the reviewed conversation'); expect(text).not.toContain('Appended after the snapshot')
  expect(await processPrepare(fresh)).toMatchObject({ file: result.file })
})

it.each(['full then empty', 'empty then full'])('keeps the first durable result for the same intent: %s', async direction => {
  const empty = transcript().split('\n')[0] + '\n'
  if (direction === 'empty then full') write(path, empty)
  const ctx = await setup(), first = await ctx.prepare()
  write(path, direction === 'full then empty' ? empty : transcript())
  const fresh = await setup()
  expect(await processPrepare(fresh)).toMatchObject({ file: first.file, gitRepo: first.gitRepo })
  if (first.file) expect(fs.readFileSync(join(cwd, first.file), 'utf8')).toContain('Keep the reviewed conversation')
  else noPublication()
  const { prepareAgentHandoff } = await import('../lib/agentHandoff.js')
  write(path, empty)
  await expect(prepareAgentHandoff(fresh.deps, { agentId: row.agentId, changeId: CHANGE, targetEngine: 'codex' }))
    .rejects.toMatchObject({ code: 'CHANGE_CONFLICT' })
})

it.each(['full then empty', 'empty then full'])('recovers an interrupted Git snapshot with %s native history', async direction => {
  fixtureGit.enabled = true
  const exclude = join(cwd, '.git', 'info', 'exclude'), empty = transcript().split('\n')[0] + '\n'
  write(exclude, '# Existing project exclusion\n')
  if (direction === 'empty then full') write(path, empty)
  const ctx = await setup(), link = fs.linkSync
  let fired = false
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    link(from, to)
    if (!fired && String(to).includes('handoff-receipts') && String(to).endsWith('.json')) {
      fired = true; throw Error('Interrupted after durable reservation')
    }
  })
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'HANDOFF_UNAVAILABLE' })
  expect(fired).toBe(true); noPublication()
  write(path, direction === 'full then empty' ? empty : transcript())
  fs.appendFileSync(exclude, '# Added while the request was held\n')
  const result = await processPrepare(await setup())
  expect(result).toMatchObject({ gitRepo: true })
  if (direction === 'full then empty') {
    expect(result.file).toBeTypeOf('string')
    expect(fs.readFileSync(join(cwd, result.file as string), 'utf8')).toContain('Keep the reviewed conversation')
    expect(fs.readFileSync(exclude, 'utf8')).toContain('.harness/handoff/')
  } else { expect(result.file).toBeNull(); noPublication() }
  expect(fs.readFileSync(exclude, 'utf8')).toContain('# Added while the request was held\n')
})

it('does not accept another valid ancestor file with the same session ID', async () => {
  const parent = { ...row, agentId: 'parent' }
  row = { ...row, sessionId: '', transcriptPath: null, forkedFrom: { agentId: parent.agentId, name: 'Parent', sessionId: ID, transcriptPath: path } }
  const ctx = await setup([row, parent])
  const result = await processPrepare(ctx, async prepared => {
    const { readNativeHandoff } = await import('../lib/nativeHandoffRead.js')
    const second = join(dirname(path), 'other', `${ID}.jsonl`)
    write(second, transcript(ID, 'Different native body under the same ID'))
    prepared.reads[0] = (await readNativeHandoff({ engine: 'codex', sessionId: ID, transcriptPath: second }, parent.agentId, undefined, cwd, {})).witness
  })
  expect(result).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', held: true }); noPublication()
})

it('does not inherit a fork link whose exact file now names another native conversation', async () => {
  const parent = { ...row, agentId: 'parent' }
  row = { ...row, sessionId: '', transcriptPath: null,
    forkedFrom: { agentId: parent.agentId, name: 'Parent', sessionId: ID, transcriptPath: path } }
  const ctx = await setup([row, parent])
  write(path, transcript(OTHER))
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  noPublication()
})

it.each(['recorded', 'parent path', 'legacy', 'stopped', 'by ID'])('publishes exactly the selected %s ancestor through the core', async kind => {
  const parent = { ...row, agentId: 'parent' }
  row = { ...row, sessionId: '', transcriptPath: null, forkedFrom: { agentId: parent.agentId, name: 'Parent',
    ...(kind === 'legacy' ? {} : { sessionId: ID, transcriptPath: kind === 'parent path' ? join(root, 'unrelated.jsonl') : path }) } }
  const ctx = await setup([row, parent])
  if (kind === 'stopped') { ctx.current.delete(parent.agentId); ctx.saved.set(parent.agentId, parent) }
  if (kind === 'by ID') {
    const next = join(dirname(path), 'moved', `${ID}.jsonl`)
    fs.mkdirSync(dirname(next)); fs.renameSync(path, next); path = next
    ctx.current.set(parent.agentId, { ...parent, sessionId: OTHER, transcriptPath: null })
  }
  const result = await processPrepare(ctx)
  expect(result.file).toBeTypeOf('string')
  expect(fs.readFileSync(join(cwd, result.file as string), 'utf8')).toContain('Keep the reviewed conversation')
})

it.each(['missing link', 'wrong parent', 'other project', 'invalid cutoff', 'late legacy binding'])
('rejects %s ancestry even when the service supplies matching current row fingerprints', async fault => {
  const parent = { ...row, agentId: 'parent' }
  row = { ...row, sessionId: '', transcriptPath: null,
    forkedFrom: { agentId: parent.agentId, name: 'Parent', sessionId: ID, transcriptPath: path } }
  const ctx = await setup([row, parent])
  const result = await processPrepare(ctx, async prepared => {
    const child = ctx.current.get(row.agentId)!, ancestor = ctx.current.get(parent.agentId)!
    if (fault === 'missing link') child.forkedFrom = undefined
    if (fault === 'wrong parent') child.forkedFrom = { agentId: 'unselected', name: 'Another parent' }
    if (fault === 'other project') { ancestor.cwd = join(root, 'other-project'); fs.mkdirSync(ancestor.cwd) }
    if (fault === 'invalid cutoff') child.registeredAt = NaN
    if (fault === 'late legacy binding') {
      child.forkedFrom = { agentId: parent.agentId, name: 'Parent' }; ancestor.boundAt = AT + 1
    }
    const { handoffSessionFact } = await import('../lib/handoffAuthority.js')
    prepared.sessions = [handoffSessionFact(child), handoffSessionFact(ancestor)]
  })
  expect(result).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', held: true }); noPublication()
})

it('refuses a by-ID file without the current core selection witness', async () => {
  const parent = { ...row, agentId: 'parent' }
  row = { ...row, sessionId: '', transcriptPath: null,
    forkedFrom: { agentId: parent.agentId, name: 'Parent', sessionId: ID, transcriptPath: path } }
  const ctx = await setup([row, parent]), next = join(dirname(path), 'moved', `${ID}.jsonl`)
  fs.mkdirSync(dirname(next)); fs.renameSync(path, next); path = next
  ctx.current.set(parent.agentId, { ...parent, sessionId: OTHER, transcriptPath: null })
  const { createHandoffPublisher } = await import('./handoffPublication.js')
  // This core instance did not observe the lookup supplied by the earlier service preparation.
  ctx.deps.publish = createHandoffPublisher({ directory: join(root, 'ADAPTER_DATA_DIR'),
    resolve: id => ctx.current.get(id), ownedByOther: () => false, isRecentlyDeleted: () => false })
  expect(await processPrepare(ctx)).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', held: true }); noPublication()
})

it.each(['engine', 'path'])('refuses a discovery read whose %s differs from the core observation', async fault => {
  row = { ...row, sessionId: '', transcriptPath: null,
    processIdentity: { pid: 4242, executable: 'codex', startMarker: '2026-10-10T07:00:00Z' } }
  const ctx = await setup()
  const result = await processPrepare(ctx, prepared => {
    if (fault === 'engine') prepared.reads[0].engine = 'claude'
    else prepared.reads[0].path = join(root, 'other-transcript')
  })
  expect(result).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', held: true }); noPublication()
})

it.each([true, false])('requires a real core discovery observation, including confirmed empty (found: %s)', async found => {
  row = { ...row, sessionId: '', transcriptPath: null,
    processIdentity: { pid: 4242, executable: 'codex', startMarker: '2026-10-10T07:00:00Z' } }
  const ctx = await setup([row], found), result = await processPrepare(ctx)
  if (found) expect(result.file).toBeTypeOf('string')
  else { expect(result).toMatchObject({ file: null, degraded: [] }); noPublication() }
})

it('checks unrelated stopped ownership through the store receiver', async () => {
  const ctx = await setup()
  ctx.saved.set('other', { ...row, agentId: 'other', sessionId: OTHER })
  expect((await ctx.prepare()).file).toBeTypeOf('string')
})

it('uses a bound fork own history without consulting an absent parent', async () => {
  row.forkedFrom = { agentId: 'absent', name: 'Parent' }
  const ctx = await setup()
  expect((await ctx.prepare()).file).toBeTypeOf('string')
})

it('walks a complete intermediate fork chain with no bound session', async () => {
  const parent = { ...row, agentId: 'parent' }, middle = { ...row, agentId: 'middle', sessionId: '', transcriptPath: null,
    forkedFrom: { agentId: parent.agentId, name: 'Parent', sessionId: ID, transcriptPath: path } }
  row = { ...row, sessionId: '', transcriptPath: null, forkedFrom: { agentId: middle.agentId, name: 'Middle' } }
  expect((await processPrepare(await setup([row, middle, parent]))).file).toBeTypeOf('string')
})

it('holds discovery whose process owner changes while the lookup is pending', async () => {
  row = { ...row, sessionId: '', transcriptPath: null,
    processIdentity: { pid: 4242, executable: 'codex', startMarker: '2026-10-10T07:00:00Z' } }
  const ctx = await setup(), discover = ctx.deps.discoverSession!
  ctx.deps.discoverSession = async source => {
    const found = await discover(source)
    ctx.current.set(row.agentId, { ...row, processIdentity: { ...row.processIdentity!, pid: 4243 } })
    return found
  }
  await expect(ctx.prepare()).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
  noPublication()
})

/** Real service frames are serialized in both directions; the core builds the request witness. */
async function processPrepare(ctx: Awaited<ReturnType<typeof setup>>,
  beforePublish?: (prepared: import('../lib/handoffAuthority.js').PreparedHandoff, revoke: (why: 'closed' | 'expired' | 'replaced') => void) => void | Promise<void>) {
  const { conversationReads, answerConversationQuery } = await import('./conversationQueries.js')
  const { createServiceLinks } = await import('./serviceLinks.js')
  const { fakeCore } = await import('../testing/fakeCore.js')
  const { handoffCoreApi } = await import('../services/handoffProcess.js')
  const { startHandoff } = await import('../services/handoff.js')
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
  const core = fakeCore({ dataDir: join(root, 'ADAPTER_DATA_DIR'), conversations: conversationReads(ctx.deps) })
  const replies = new Map<string, (payload: Record<string, unknown>) => void>()
  let clock = 0, next = 0
  const owner = { local: true, owner: true, connection: 'private-fixture-owner' }
  const links = createServiceLinks({ token: 'fixture-token', owned: { handoff: ['agent_handoff_prepare'] }, log: () => {}, now: () => clock,
    answer: async (_service, query, payload, authority) => {
      const wire = clone(payload)
      if (query === 'publish') await beforePublish?.(wire.prepared as never, why => {
        if (why === 'closed') links.closeConnection(owner.connection)
        if (why === 'expired') clock = 6_000
        if (why === 'replaced') links.accept('handoff', 'fixture-token', { sendFrame: () => true }, () => {})
      })
      return answerConversationQuery(core, query, wire, authority)
    } })
  const processCore = handoffCoreApi(core.dataDir, (query, payload) => new Promise(resolve => {
    const requestId = `query-${++next}`; replies.set(requestId, resolve)
    link.receive(clone({ type: 'service_query', payload: { ...payload, query, requestId } }))
  }))
  const service = startHandoff(processCore)
  const link = links.accept('handoff', 'fixture-token', { sendFrame: frame => {
    const wire = clone(frame)
    if (wire.type === 'service_query_result') replies.get(String(wire.payload!.requestId))!(wire.payload!)
    else if (wire.type === 'agent_handoff_prepare') void Promise.resolve(service.agent_handoff_prepare!(wire.payload!, owner))
      .then(reply => link.receive(clone({ type: 'agent_handoff_prepare_result', payload: { ...reply, requestId: wire.payload!.requestId } })))
    return true
  } }, () => {})!
  try { return await new Promise<Record<string, unknown>>(resolve => links.route('agent_handoff_prepare',
    { agentId: row.agentId, changeId: CHANGE, targetEngine: 'claude' }, owner, resolve)) }
  finally {
    link.closed()
    for (const reply of replies.values()) reply({ error: 'SERVICE_UNAVAILABLE' })
    await new Promise(resolve => setImmediate(resolve))
  }
}

it.each(['project', 'conversation', 'profile', 'engine', 'omitted read', 'foreign owner', 'target engine', 'unknown read field',
  'extra foreign read', 'duplicate read', 'native path', 'native key', 'native version', 'missing native route', 'missing fork chain'])('the core refuses a JSON preparation with altered %s authority', async fault => {
  if (fault === 'missing fork chain') row = { ...row, sessionId: '', transcriptPath: null, forkedFrom: { agentId: 'parent', name: 'Parent' } }
  const ctx = await setup(), other = join(root, 'other-project'); fs.mkdirSync(other)
  if (fault === 'missing fork chain') {
    // Capture a valid own preparation, then supply an unbound fork fact with no ancestral witness.
    const { handoffSessionFact } = await import('../lib/handoffAuthority.js')
    const { prepareAgentHandoff } = await import('../lib/agentHandoff.js')
    ctx.current.set(row.agentId, { ...row, sessionId: ID, transcriptPath: path, forkedFrom: undefined })
    const publish = ctx.deps.publish!
    ctx.deps.publish = (prepared, permit) => {
      ctx.current.set(row.agentId, row)
      prepared.sessions = [handoffSessionFact(row)]; prepared.reads = []; prepared.documents = null; prepared.result.file = null
      return publish(prepared, permit)
    }
    await expect(prepareAgentHandoff(ctx.deps, { agentId: row.agentId, changeId: CHANGE, targetEngine: 'claude' })).rejects.toMatchObject({ code: 'IDENTITY_UNAVAILABLE' })
    noPublication(); return
  }
  const result = await processPrepare(ctx, async prepared => {
    if (fault === 'project') {
      const { NativeFiles } = await import('../engines/kit/nativeFiles.js')
      const { nativeFileKey } = await import('../engines/kit/nativePaths.js')
      const { handoffGitRoute } = await import('../lib/handoffGit.js')
      const files = new NativeFiles(), destination = files.locate(other)!
      prepared.project = { cwd: other, path: other, fileKey: nativeFileKey(destination.info), route: files.paths.snapshot() }
      prepared.result.cwd = other; prepared.git = handoffGitRoute(other)
    }
    if (fault === 'conversation') {
      const { readNativeHandoff } = await import('../lib/nativeHandoffRead.js')
      const foreign = join(root, 'CODEX_HOME', 'sessions', `${OTHER}.jsonl`)
      write(foreign, transcript(OTHER, 'Another valid native conversation'))
      prepared.reads[0] = (await readNativeHandoff({ engine: 'codex', sessionId: OTHER, transcriptPath: foreign }, row.agentId, undefined, cwd, {})).witness
    }
    if (fault === 'profile') prepared.reads[0].profile = join(root, 'other-profile')
    if (fault === 'engine') prepared.reads[0].engine = 'claude'
    if (fault === 'omitted read') prepared.reads = []
    if (fault === 'foreign owner') prepared.reads[0].ownerAgentId = 'unrecorded-owner'
    if (fault === 'target engine') prepared.request.targetEngine = 'codex'
    if (fault === 'unknown read field') Object.assign(prepared.reads[0], { extra: 'x'.repeat(1024 * 1024) })
    if (fault === 'extra foreign read') prepared.reads.push({ ...prepared.reads[0], ownerAgentId: 'foreign' })
    if (fault === 'duplicate read') prepared.reads.push({ ...prepared.reads[0] })
    if (fault === 'native path') prepared.reads[0].readPath = other
    if (fault === 'native key') prepared.reads[0].fileKey = '1:2'
    if (fault === 'native version') prepared.reads[0].version = 'changed'
    if (fault === 'missing native route') prepared.reads[0].route = prepared.reads[0].route.slice(1)
  })
  expect(result).toMatchObject({ held: true, retryable: true })
  expect(result.file).toBeUndefined(); noPublication(); expect(fs.existsSync(join(other, '.harness'))).toBe(false)
})

it.each(['closed', 'expired', 'replaced'] as const)('holds a %s originating request before the JSON publish query can commit', async why => {
  const ctx = await setup()
  const result = await processPrepare(ctx, (_prepared, revoke) => revoke(why))
  expect(result.error).toBeTypeOf('string'); expect(result.file).toBeUndefined(); noPublication()
  expect(await processPrepare(ctx)).toMatchObject({ file: expect.any(String) })
})

it('keeps the complete intermediate fork chain authoritative after the history read', async () => {
  const parent = { ...row, agentId: 'parent' }, intermediate = { ...row, agentId: 'intermediate', sessionId: '', transcriptPath: null,
    forkedFrom: { agentId: parent.agentId, name: 'Parent', sessionId: ID, transcriptPath: path } }
  row = { ...row, sessionId: '', transcriptPath: null, forkedFrom: { agentId: intermediate.agentId, name: 'Intermediate' } }
  const ctx = await setup([row, intermediate, parent])
  const result = await processPrepare(ctx, () => { ctx.current.get(intermediate.agentId)!.forkedFrom = { agentId: 'other-parent', name: 'Other' } })
  expect(result).toMatchObject({ error: 'IDENTITY_UNAVAILABLE', held: true }); noPublication()
})

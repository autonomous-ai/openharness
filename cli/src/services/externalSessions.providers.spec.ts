/** Real provider records cross the admission service; no host processes or native homes are used. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { claudeProvider } from '../lib/sessionSearch/externals/claude.js'
import { codexProvider } from '../lib/sessionSearch/externals/codex.js'
import { grokProvider } from '../lib/sessionSearch/externals/grok.js'
import type { ProcessView, RunningProcess } from '../lib/sessionSearch/externals/types.js'
import { createExternalSessions } from './externalSessions.js'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const id = '11111111-1111-4111-8111-111111111111', started = 1_787_839_600_000
const json = (path: string, value: unknown) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value) + '\n') }
function setup(engine: 'claude' | 'grok') {
  const root = mkdtempSync(join(tmpdir(), 'adoption-provider-')); roots.push(root)
  const cwd = join(root, 'project'); mkdirSync(cwd)
  const process: RunningProcess = { pid: 101, ppid: 1, executable: engine, args: engine, started, generation: `ps:${started}` }
  const view: ProcessView = { list: async () => [process], alive: pid => pid === 101,
    openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map() }
  const path = engine === 'claude' ? join(root, 'sessions', '101.json') : join(root, 'active_sessions.json')
  if (engine === 'claude') json(join(root, 'projects', 'project', `${id}.jsonl`), {
    type: 'user', sessionId: id, cwd, entrypoint: 'cli', message: { role: 'user', content: 'Fixture' },
  })
  else {
    const folder = join(root, 'sessions', encodeURIComponent(cwd), id)
    json(join(folder, 'summary.json'), { info: { id, cwd }, generated_title: 'Fixture' })
    json(join(folder, 'prompt_context.json'), { audience: 'primary', is_non_interactive: false, working_directory: cwd })
    json(join(folder, 'updates.jsonl'), { method: 'session/update', params: { sessionId: id,
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Fixture' } } } })
  }
  const provider = engine === 'claude' ? claudeProvider({ projectsDir: join(root, 'projects'), home: root }) : grokProvider({ home: root })
  const reader = createExternalSessions({ providers: [provider], generation: () => `ps:${started}`,
    open: { view: () => ({ ...view }), ttys: async () => new Map([[101, '/dev/fixture-terminal']]), harnessTtys: async () => new Set() } })
  const write = (record: unknown) => json(path, engine === 'claude' ? record : [record])
  const valid = engine === 'claude' ? { pid: 101, sessionId: id, startedAt: started + 400, status: 'idle' }
    : { pid: 101, session_id: id, opened_at: started + 400, cwd }
  write(valid)
  return { reader, provider, process, write, valid, request: { engine, sessionId: id } }
}

it.each(['claude', 'grok'] as const)('%s admission requires complete owner records and incarnation evidence', async engine => {
  const test = setup(engine)
  expect(await test.reader.inspect(test.request)).toMatchObject({ ok: true, owner: { pid: 101 } })
  const time = engine === 'claude' ? 'startedAt' : 'opened_at', session = engine === 'claude' ? 'sessionId' : 'session_id'
  for (const value of [undefined, null, 'invalid', Number.NaN, Number.POSITIVE_INFINITY]) {
    test.write({ ...test.valid, [time]: value })
    expect(await test.reader.inspect(test.request), `${time}=${value}`).toMatchObject({ ok: false, error: 'SEARCH_UNAVAILABLE' })
  }
  for (const value of [undefined, '', 'invalid id!', 42]) {
    test.write({ ...test.valid, [session]: value })
    expect(await test.reader.inspect(test.request), `${session}=${value}`).toMatchObject({ ok: false })
  }
  for (const value of [undefined, '101', 0, -1, 1.5, 0x80000000]) {
    test.write({ ...test.valid, pid: value })
    expect(await test.reader.inspect(test.request), `pid=${value}`).toMatchObject({ ok: false })
  }
  test.write(test.valid)
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    test.process.started = value
    expect(await test.reader.inspect(test.request), `process.started=${value}`).toMatchObject({ ok: false })
  }
  test.process.started = started + 60_000
  expect(await test.reader.inspect(test.request)).toMatchObject({ ok: false })
  test.process.executable = 'sh'; test.process.args = 'sh'
  expect(await test.reader.inspect(test.request)).toMatchObject({ ok: true, owner: null })
})

it('Claude proves current ownership and activity in one final record; changed or incomplete records cannot grant idle takeover', async () => {
  const test = setup('claude'), confirm = test.provider.confirmOwner!.bind(test.provider)
  test.provider.confirmOwner = async (owner, process) => {
    test.write({ ...test.valid, status: 'busy' })
    return confirm(owner, process)
  }
  expect(await test.reader.inspect(test.request)).toMatchObject({ ok: true, busy: true, busyConfirmed: true })
  for (const patch of [{ sessionId: '22222222-2222-4222-8222-222222222222' }, { pid: 102 }, { startedAt: undefined }, { startedAt: started - 60_000 }]) {
    test.write(test.valid)
    test.provider.confirmOwner = async (owner, process) => { test.write({ ...test.valid, ...patch }); return confirm(owner, process) }
    expect(await test.reader.inspect(test.request)).toMatchObject({ ok: false })
  }
  test.write(test.valid)
  test.provider.confirmOwner = async (owner, process) => { test.write({ ...test.valid, status: 'unreadable' }); return confirm(owner, process) }
  const unknown = await test.reader.inspect(test.request)
  expect(unknown).toMatchObject({ ok: true, busy: true })
  expect(unknown).not.toHaveProperty('busyConfirmed')
})

it('Codex FD claims require an actual engine process; a command-prefix helper is never stoppable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adoption-codex-')); roots.push(root)
  const cwd = join(root, 'project'); mkdirSync(cwd)
  const file = join(root, 'sessions', 'rollout-2026-10-09T00-00-00-' + id + '.jsonl')
  json(file, { type: 'session_meta', payload: { id, cwd, source: 'cli' } })
  const process: RunningProcess = { pid: 101, ppid: 1, executable: '/fixture/codex-audit', args: '/fixture/codex-audit --read-history', started }
  let listed = true, alive = true
  const view: ProcessView = { list: async () => listed ? [process] : [], alive: () => alive,
    openFiles: async () => new Map(), cwds: async () => new Map(), openFilesOf: async () => new Map([[101, [file]]]) }
  const reader = createExternalSessions({ providers: [codexProvider({ home: root })], generation: () => `ps:${started}`,
    open: { view: () => ({ ...view }), ttys: async () => new Map([[101, '/dev/fixture-terminal']]), harnessTtys: async () => new Set() } })
  const request = { engine: 'codex' as const, sessionId: id }
  expect(await reader.inspect(request)).toMatchObject({ ok: false })
  process.executable = 'codex'; process.args = 'codex'
  listed = false; expect(await reader.inspect(request)).toMatchObject({ ok: false })
  listed = true; alive = false; expect(await reader.inspect(request)).toMatchObject({ ok: false })
  alive = true
  const valid = await reader.inspect(request)
  expect(valid).toMatchObject({ ok: true, owner: { pid: 101 }, busy: true })
  expect(valid).not.toHaveProperty('busyConfirmed')
})

/**
 * CLI 0.3.70: two long-running `claude` TUIs started before Claude Code kept `sessions/<pid>.json` held every
 * adoption on the machine ("held · search · launched 0 of 4"). A process with no record may hold only what its
 * arguments name, or what its own `/resume` lists: its project's conversations.
 */
function unplaced() {
  const root = mkdtempSync(join(tmpdir(), 'adoption-unplaced-')); roots.push(root)
  const cwd = join(root, 'project'), elsewhere = join(root, 'elsewhere'), other = '22222222-2222-4222-8222-222222222222'
  mkdirSync(cwd); mkdirSync(elsewhere); symlinkSync(cwd, join(root, 'link'))
  for (const session of [id, other]) json(join(root, 'projects', 'project', `${session}.jsonl`), {
    type: 'user', sessionId: session, cwd, entrypoint: 'cli', message: { role: 'user', content: 'Fixture' },
  })
  const owner: RunningProcess = { pid: 101, ppid: 1, executable: 'claude', args: 'claude', started, generation: `ps:${started}` }
  const stray: RunningProcess = { pid: 202, ppid: 1, executable: 'claude', args: 'claude --append-system-prompt "be brief"', started }
  // `fresh` is what every look after the first sees: a process that arrives while the first look's reads wait.
  const state = { processes: [stray], cwds: new Map<number, string>([[202, elsewhere]]), asked: [] as number[][], views: 0, fresh: null as RunningProcess[] | null }
  const view = (): ProcessView => {
    const processes = state.views++ && state.fresh ? state.fresh : state.processes
    return { list: async () => processes, alive: pid => processes.some(row => row.pid === pid),
      openFiles: async () => new Map(), openFilesOf: async () => new Map(),
      cwds: async pids => { state.asked.push([...pids]); return new Map([...state.cwds].filter(([pid]) => pids.includes(pid))) } }
  }
  const provider = claudeProvider({ projectsDir: join(root, 'projects'), home: root })
  const reader = createExternalSessions({ providers: [provider], generation: () => `ps:${started}`,
    open: { view, ttys: async pids => new Map(pids.map(pid => [pid, `/dev/fixture-${pid}`])), harnessTtys: async () => new Set() } })
  const inspect = (sessionId = id) => { state.views = 0; return reader.inspect({ engine: 'claude', sessionId }) }
  const own = () => json(join(root, 'sessions', '101.json'), { pid: 101, sessionId: id, startedAt: started + 400, status: 'idle' })
  return { root, cwd, elsewhere, other, owner, stray, state, inspect, own }
}
const unverified = { ok: false, error: 'SEARCH_UNAVAILABLE', detail: "The conversation's current owner could not be verified." }

it('a record-less Claude in another folder holds nothing here: the conversation is free, or its own owner', async () => {
  const test = unplaced()
  expect(await test.inspect()).toMatchObject({ ok: true, owner: null, busy: false })
  // Its folder is asked once, for that process alone.
  expect(test.state.asked).toEqual([[202]])
  test.own(); test.state.processes = [test.owner, test.stray]
  expect(await test.inspect()).toMatchObject({ ok: true, owner: { pid: 101, tty: '/dev/fixture-101' }, busy: false })
})

it("a record-less Claude in the conversation's folder, or one whose folder is unknown, may hold it: nobody can say", async () => {
  const test = unplaced()
  for (const folder of [test.cwd, `${test.cwd}/`, join(test.root, 'link'), join(test.elsewhere, '..', 'project')]) {
    test.state.cwds.set(202, folder)
    expect(await test.inspect(), folder).toMatchObject(unverified)
  }
  test.state.cwds.clear()
  expect(await test.inspect()).toMatchObject(unverified)
  // Gone, it holds nothing: the same conversation is free.
  test.state.processes = []
  expect(await test.inspect()).toMatchObject({ ok: true, owner: null })
})

it('a record-less Claude that arrives in the folder during the observation fails the second look', async () => {
  const test = unplaced()
  test.own(); test.state.processes = [test.owner]
  expect(await test.inspect()).toMatchObject({ ok: true, owner: { pid: 101 } })
  test.state.fresh = [test.owner, test.stray]; test.state.cwds.set(202, test.cwd)
  expect(await test.inspect()).toMatchObject(unverified)
  // In another folder, its arrival changes nothing.
  test.state.cwds.set(202, test.elsewhere)
  expect(await test.inspect()).toMatchObject({ ok: true, owner: { pid: 101 } })
})

it.each([
  ['--resume', (session: string) => `claude --resume ${session}`],
  ['-r', (session: string) => `claude -r ${session}`],
  ['--resume=', (session: string) => `claude --resume=${session}`],
  ['--session-id', (session: string) => `claude --session-id ${session}`],
  ['--session-id=', (session: string) => `claude --session-id=${session}`],
])('a record-less Claude started with %s holds that conversation, and may have moved to another of its folder', async (_flag, args) => {
  const test = unplaced()
  test.stray.args = args(test.other)
  // Wherever it is, the conversation its arguments name may be open there: never stopped for it.
  for (const folder of [test.elsewhere, test.cwd, null]) {
    if (folder) test.state.cwds.set(202, folder); else test.state.cwds.clear()
    expect(await test.inspect(test.other), String(folder)).toMatchObject({ ok: true, owner: { pid: 202, fromArgs: true, tty: '/dev/fixture-202' }, busy: true, generation: `ps:${started}` })
    expect(await test.inspect(test.other)).not.toHaveProperty('busyConfirmed')
  }
  // `/resume` or `/clear` inside moves it to another conversation of its folder: nobody can say which.
  test.state.cwds.set(202, test.cwd)
  expect(await test.inspect()).toMatchObject(unverified)
  test.state.cwds.clear()
  expect(await test.inspect()).toMatchObject(unverified)
  // In another folder, it cannot have this one.
  test.state.cwds.set(202, test.elsewhere)
  expect(await test.inspect()).toMatchObject({ ok: true, owner: null })
  // Beside an exact owner of the same conversation, two processes may have it.
  test.stray.args = args(id); test.own(); test.state.processes = [test.owner, test.stray]
  expect(await test.inspect()).toMatchObject({ ok: false })
})

it('a record-less Claude elsewhere in the same repository may hold it; one merely above or below, outside one, cannot', async () => {
  const test = unplaced()
  // `/resume` never lists a subfolder's conversations: a TUI left open in the home folder (no repository)
  // holds nothing in a project below it, nor one in a folder below the conversation's.
  const below = join(test.cwd, 'packages', 'app'); mkdirSync(below, { recursive: true })
  for (const folder of [test.root, below]) {
    test.state.cwds.set(202, folder)
    expect(await test.inspect(), folder).toMatchObject({ ok: true, owner: null })
  }
  // The conversation's folder is a worktree; the process works in the repository it was added from.
  const main = join(test.root, 'main'); mkdirSync(join(main, '.git', 'worktrees', 'project'), { recursive: true })
  writeFileSync(join(test.cwd, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'project')}\n`)
  test.state.cwds.set(202, main)
  expect(await test.inspect()).toMatchObject(unverified)
  // Another repository, or a sibling folder outside any, is another project.
  const unrelated = join(test.root, 'unrelated'); mkdirSync(join(unrelated, '.git'), { recursive: true })
  for (const folder of [unrelated, test.elsewhere]) {
    test.state.cwds.set(202, folder)
    expect(await test.inspect(), folder).toMatchObject({ ok: true, owner: null })
  }
  // The conversation began in a subfolder of a repository whose root the process works in: one store.
  rmSync(join(test.cwd, '.git')); mkdirSync(join(test.root, '.git'))
  test.state.cwds.set(202, test.root)
  expect(await test.inspect()).toMatchObject(unverified)
})

it('a fork names only its parent: a record-less `--fork-session` is placed by its folder', async () => {
  const test = unplaced()
  test.stray.args = `claude --resume ${test.other} --fork-session`
  expect(await test.inspect(test.other)).toMatchObject({ ok: true, owner: null })
  test.state.cwds.set(202, test.cwd)
  expect(await test.inspect(test.other)).toMatchObject(unverified)
})

it('one live Claude named by two records still fails every conversation', async () => {
  const test = unplaced()
  const second = join(test.root, 'second'); mkdirSync(join(second, 'projects'), { recursive: true })
  json(join(second, 'sessions', '101.json'), { pid: 101, sessionId: test.other, startedAt: started + 400, status: 'idle' })
  test.own(); test.state.processes = [test.owner]
  const reader = createExternalSessions({ providers: [claudeProvider({ projectsDir: '', home: '', roots: () => [join(test.root, 'projects'), join(second, 'projects')] })],
    generation: () => `ps:${started}`, open: { view: () => ({ list: async () => [test.owner], alive: pid => pid === 101,
      openFiles: async () => new Map(), openFilesOf: async () => new Map(), cwds: async () => new Map() }),
    ttys: async () => new Map([[101, '/dev/fixture-101']]), harnessTtys: async () => new Set() } })
  expect(await reader.inspect({ engine: 'claude', sessionId: id })).toMatchObject(unverified)
  expect(await reader.inspect({ engine: 'claude', sessionId: test.other })).toMatchObject(unverified)
})

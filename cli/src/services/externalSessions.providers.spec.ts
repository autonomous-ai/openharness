/** Real provider records cross the admission service; no host processes or native homes are used. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { claudeProvider } from '../lib/sessionSearch/externals/claude.js'
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
    openFiles: async () => new Map(), openFilesOf: async () => new Map() }
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
  return { reader, process, write, valid, request: { engine, sessionId: id } }
}

it.each(['claude', 'grok'] as const)('%s admission requires complete owner records and incarnation evidence', async engine => {
  const test = setup(engine)
  expect(await test.reader.inspect(test.request)).toMatchObject({ ok: true, owner: { pid: 101 } })
  const time = engine === 'claude' ? 'startedAt' : 'opened_at', session = engine === 'claude' ? 'sessionId' : 'session_id'
  for (const value of [undefined, null, 'invalid', Number.NaN, Number.POSITIVE_INFINITY]) {
    test.write({ ...test.valid, [time]: value })
    expect(await test.reader.inspect(test.request), `${time}=${value}`).toMatchObject({ ok: false, error: 'SEARCH_UNAVAILABLE' })
  }
  for (const value of [undefined, '', 42]) {
    test.write({ ...test.valid, [session]: value })
    expect(await test.reader.inspect(test.request), `${session}=${value}`).toMatchObject({ ok: false })
  }
  for (const value of [undefined, '101', 0, -1, 1.5]) {
    test.write({ ...test.valid, pid: value })
    expect(await test.reader.inspect(test.request), `pid=${value}`).toMatchObject({ ok: false })
  }
  test.write(test.valid)
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    test.process.started = value
    expect(await test.reader.inspect(test.request), `process.started=${value}`).toMatchObject({ ok: false })
  }
  test.process.started = started + 60_000
  expect(await test.reader.inspect(test.request)).toMatchObject({ ok: true, owner: null })
})

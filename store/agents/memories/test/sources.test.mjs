import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { claudeIndex, collect, resolveProject } from '../lib/sources.mjs'
import { tomlFlag } from '../lib/agents.mjs'
import { makeHome } from './fixtures.mjs'

const { home, project, env } = makeHome()
const result = collect({ env, home })
const by = (agent) => result.memories.filter((row) => row.agent === agent)
const find = (agent, title) => by(agent).find((row) => row.title === title)

test('Claude Code memories are typed from front matter and titled from MEMORY.md', () => {
  const short = find('claude', 'Short answers')
  assert.equal(short.kind, 'you')
  assert.equal(short.type, 'feedback')
  assert.equal(short.description, 'Wants replies under five lines')
  assert.equal(short.project.name, 'my-app')
  assert.equal(short.project.path, project)
  assert.match(short.body, /Keep replies short/)
  assert.ok(!short.body.includes('---'), 'front matter is not part of the body')
  assert.equal(find('claude', 'Build layout').kind, 'project')
  const docs = find('claude', 'Docs link')
  assert.equal(docs.kind, 'reference')
  assert.equal(docs.description, 'Where the docs are')
  assert.ok(short.path.startsWith('~/.claude/projects/'), 'paths are shown from the home folder')
})

test('a project folder that no longer exists keeps a readable name', () => {
  const old = by('claude').find((row) => row.body.includes('no longer exists'))
  assert.equal(old.project.path, null)
  assert.equal(old.project.name, 'gone-folder')
})

test('a memory file is kept as text, whatever it contains', () => {
  const hostile = by('claude').find((row) => row.body.includes('<script>'))
  assert.equal(hostile.kind, 'you')
  assert.match(hostile.body, /onerror="alert\(1\)"/)
})

test('an oversized file is skipped, not read', () => {
  assert.ok(!result.memories.some((row) => row.path.includes('huge.md')))
})

test('Codex: the summary, each handbook section, notes made on request, conversation summaries', () => {
  const codex = by('codex')
  assert.equal(codex.find((row) => row.type === 'summary v1').title, 'What Codex keeps about you')
  assert.deepEqual(codex.filter((row) => row.type === 'handbook v1').map((row) => row.title), ['Testing', 'Releases'])
  const remembered = codex.find((row) => row.type === 'remembered on request')
  assert.equal(remembered.kind, 'you')
  assert.match(remembered.body, /pnpm/)
  assert.equal(codex.find((row) => row.type === 'conversation summary').title, 'Fixed the login bug')
  assert.ok(new Set(codex.map((row) => row.id)).size === codex.length, 'ids are unique, also within one file')
})

test('Grok Build: global topics are about you, workspace topics about a project, the index is skipped', () => {
  const grok = by('grok')
  assert.equal(grok.find((row) => row.title === 'Code style').kind, 'you')
  const api = grok.find((row) => row.title === 'API build')
  assert.equal(api.kind, 'project')
  assert.equal(api.project.name, 'api')
  assert.equal(grok.find((row) => row.type === 'observation').kind, 'note')
  assert.ok(!grok.some((row) => row.body.includes('generated index')))
})

test('Hermes entries split on §; OpenClaw and Gemini profiles and saved memories', () => {
  assert.deepEqual(by('hermes').filter((row) => row.kind === 'you').map((row) => row.body), ['Name: Sam', 'Prefers terse answers.', 'Works late.'])
  assert.equal(by('openclaw').find((row) => row.kind === 'you').title, 'About Sam')
  assert.equal(by('openclaw').find((row) => row.type === 'daily note').title, '2026-10-02')
  assert.deepEqual(by('gemini').filter((row) => row.kind === 'you').map((row) => row.body), ['Prefers tabs over spaces', 'Lives in UTC+7'])
})

test('what you told your agents is read as instructions', () => {
  const told = result.memories.filter((row) => row.kind === 'instructions').map((row) => `${row.agent}:${row.type}`).sort()
  assert.deepEqual(told, ['claude:CLAUDE.md', 'gemini:GEMINI.md', 'hermes:SOUL.md', 'pi:AGENTS.md', 'windsurf:global_rules.md'])
})

test('the agents: switches, counts, and what cannot be read', () => {
  const agent = (id) => result.agents.find((row) => row.id === id)
  assert.equal(agent('claude').memory, 'on')
  assert.equal(agent('codex').memory, 'on')
  assert.equal(agent('grok').memory, 'on')
  assert.equal(agent('pi').memory, 'none')
  assert.equal(agent('windsurf').unreadable, 2)
  assert.equal(agent('claude').instructions, 1)
  assert.ok(agent('claude').memories >= 4)
  assert.equal(agent('cursor').present, false)
})

test('memory switches follow the agents own settings', () => {
  assert.equal(tomlFlag('[features]\nmemories = false\n', 'features', 'memories'), false)
  assert.equal(tomlFlag('[other]\nmemories = true\n', 'features', 'memories'), undefined)
  assert.equal(tomlFlag(null, 'features', 'memories'), undefined)
  const off = collect({ env: { ...env, GROK_MEMORY: '0', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }, home })
  assert.equal(off.agents.find((row) => row.id === 'grok').memory, 'off')
  assert.equal(off.agents.find((row) => row.id === 'claude').memory, 'off')
})

test('a computer with no agents at all reads as empty, not as an error', () => {
  const empty = collect({ env: {}, home: mkdtempSync(join(tmpdir(), 'memories-empty-')) })
  assert.deepEqual(empty.memories, [])
  assert.deepEqual(empty.problems, [])
  assert.ok(empty.agents.every((row) => !row.present && row.memories === 0))
})

test('MEMORY.md index lines in their common shapes', () => {
  const index = claudeIndex('- [A](a.md) — one\n* [B](sub/b.md): two\n- [C](c.md)\nnot a line')
  assert.deepEqual([...index.keys()], ['a.md', 'b.md', 'c.md'])
  assert.equal(index.get('b.md').hook, 'two')
})

test('folder names resolve from the session index before the disk', () => {
  const folders = new Map([['-x-y-z', '/x/y-z']])
  assert.deepEqual(resolveProject('-x-y-z', { home, folders }), { name: 'y-z', path: '/x/y-z' })
})

/**
 * Codex's hooks' client: it tells the daemon that a turn waits on the person, in six typed fields, only when the turn's
 * own setting says a dialog follows, and decides nothing. Every Codex home is a throwaway folder whose rollout holds
 * Codex 0.172.0's own turn_context lines (__fixtures__/codex-turn-context.jsonl).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseObservedHook } from '../core/observedHook.js'
import type { AskedBody } from './asked.js'
import { codexAskedSummary, runCodexAsked } from './codexAsked.js'

const FIXTURE = readFileSync(new URL('./__fixtures__/codex-turn-context.jsonl', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(Boolean)
/** Line 2: automatic review, Default mode. */
const AUTO_REVIEW_TURN = '01a21860-3b56-7292-b32b-e04f386c56d4'
/** Line 6: the person reviews, Default mode. */
const USER_LINE = FIXTURE[5]
const USER_TURN = '01a21862-356c-7481-bf3a-ea92e3fd707a'
/** Line 6 in Plan mode (no real Plan-mode line was recorded). */
const PLAN_LINE = (() => {
  const record = JSON.parse(USER_LINE) as { payload: { collaboration_mode: Record<string, unknown> } }
  record.payload.collaboration_mode = { ...record.payload.collaboration_mode, mode: 'plan' }
  return JSON.stringify(record)
})()
const ROLLOUT = 'rollout-2026-11-26T14-59-40-019abc00-0000-7000-8000-000000000001.jsonl'
const SECRET = 'sk-live-0123456789'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A Codex home whose session rollout holds [records], and a folder outside it. */
function codexHome(records: string[] = FIXTURE) {
  const root = mkdtempSync(join(tmpdir(), 'codex-asked-'))
  roots.push(root)
  const home = join(root, 'codex')
  const sessions = join(home, 'sessions', '2026', '11', '26')
  mkdirSync(sessions, { recursive: true })
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  const text = records.map((record) => `${record}\n`).join('')
  writeFileSync(join(sessions, ROLLOUT), text)
  writeFileSync(join(elsewhere, ROLLOUT), text)
  return { home, transcript: join(sessions, ROLLOUT), outside: join(elsewhere, ROLLOUT) }
}

/** Codex's hook input for [transcript], as Codex 0.172.0 writes it to the hook's stdin: a PermissionRequest by default. */
function hookInput(transcript: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: '019abc00-0000-7000-8000-000000000001', turn_id: USER_TURN, transcript_path: transcript, cwd: '/repo',
    hook_event_name: 'PermissionRequest', model: 'gpt-5.5', permission_mode: 'default',
    tool_name: 'Bash', tool_input: { command: 'touch /tmp/probe', description: `Make the probe ${SECRET}` }, ...fields,
  }
}

const QUESTION = {
  tool_name: 'request_user_input', hook_event_name: 'PreToolUse', tool_use_id: 'call_7',
  tool_input: { questions: [{ id: 'q1', header: 'Probe', question: 'Which color?', options: [{ label: SECRET, description: SECRET }] }] },
}

async function* chunks(...parts: Array<Buffer | string>): AsyncIterable<Buffer | string> {
  yield* parts
}

/** What runCodexAsked posts for [stdin] with [home] as the session's Codex home. */
async function posted(home: string, ...stdin: Array<Record<string, unknown> | string>): Promise<AskedBody[]> {
  const bodies: AskedBody[] = []
  for (const input of stdin) {
    const text = typeof input === 'string' ? input : JSON.stringify(input)
    expect(await runCodexAsked({ stdin: chunks(text), post: async (body) => { bodies.push(body) }, codexHome: home })).toBe(0)
  }
  return bodies
}

const BODY: AskedBody = {
  engine: 'codex', sessionId: '019abc00-0000-7000-8000-000000000001', event: 'asked', tool: 'Bash', summary: 'touch /tmp/probe', cwd: '/repo',
}

describe('codexAskedSummary', () => {
  it.each([
    ['Bash', { command: 'touch /tmp/probe' }, 'touch /tmp/probe'],
    ['Bash', { command: '\ncd repo\nnpm test' }, 'cd repo …'],
    ['apply_patch', { command: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch' }, 'src/app.ts'],
    ['apply_patch', { command: '*** Begin Patch\n*** Add File: a.ts\n+x\n*** Delete File: b.ts\n*** End Patch' }, 'a.ts'],
    ['apply_patch', { command: '*** Begin Patch\r\n*** Delete File: c.ts\r\n*** End Patch' }, 'c.ts'],
    ['apply_patch', { command: '*** Begin Patch\n*** End Patch' }, 'apply_patch'],
    ['apply_patch', {}, 'apply_patch'],
    ['request_user_input', { questions: [{ id: 'q1', header: 'Probe', question: 'Which color?', options: [] }] }, 'Which color?'],
    ['request_user_input', { questions: [] }, 'request_user_input'],
    ['request_user_input', { questions: [{ id: 'q1', question: 7 }] }, 'request_user_input'],
    ['request_user_input', null, 'request_user_input'],
    ['write_stdin', { session_id: 3, chars: 'y\n' }, 'write_stdin'],
    ['request_permissions', { permissions: ['network'] }, 'request_permissions'],
    ['mcp__github__create_issue', { title: 'A bug' }, 'mcp__github__create_issue'],
  ])('the summary per tool: %s %j is %j', (tool, input, summary) => {
    expect(codexAskedSummary(tool, input)).toBe(summary)
  })

  it('cuts 300 bytes of multi-byte text to at most 200 on a character', () => {
    expect(codexAskedSummary('request_user_input', { questions: [{ question: '日'.repeat(100) }] })).toBe('日'.repeat(66))
  })

  it('a tab or a newline in the summary becomes a space, as does every other control character', () => {
    expect(codexAskedSummary('apply_patch', { command: '*** Update File: src/a\tb\u0085c.ts\n' })).toBe('src/a b c.ts')
    expect(codexAskedSummary('request_user_input', { questions: [{ question: 'Which\ncolor?' }] })).toBe('Which color?')
  })
})

describe('runCodexAsked', () => {
  it('posts a PermissionRequest of a turn the person reviews', async () => {
    const { home, transcript } = codexHome()
    expect(await posted(home, hookInput(transcript))).toStrictEqual([BODY])
  })

  it('posts a request_user_input PreToolUse of a Plan-mode turn', async () => {
    const { home, transcript } = codexHome([PLAN_LINE])
    expect(await posted(home, hookInput(transcript, QUESTION)))
      .toStrictEqual([{ ...BODY, tool: 'request_user_input', summary: 'Which color?' }])
  })

  it('posts nothing for a turn its automatic review approves', async () => {
    const { home, transcript } = codexHome()
    expect(await posted(home, hookInput(transcript, { turn_id: AUTO_REVIEW_TURN }))).toEqual([])
  })

  it('posts nothing for a turn with no turn_context', async () => {
    const { home, transcript } = codexHome()
    expect(await posted(home, hookInput(transcript, { turn_id: '01a21899-0000-7000-8000-000000000000' }))).toEqual([])
  })

  it('posts nothing for a transcript_path outside the home', async () => {
    const { home, outside } = codexHome()
    expect(await posted(home, hookInput(outside))).toEqual([])
  })

  // Codex reads an app tool's reviewer from config.toml's [apps], over the turn's: the rollout cannot say who reviews it.
  it('posts nothing for an app tool of Codex\'s (mcp__codex_apps__…) in a turn the person reviews', async () => {
    const { home, transcript } = codexHome()
    expect(await posted(home, hookInput(transcript, { tool_name: 'mcp__codex_apps__github_create_issue', tool_input: {} }))).toEqual([])
  })

  it('posts nothing for a request_user_input PreToolUse in Default mode', async () => {
    const { home, transcript } = codexHome()
    expect(await posted(home, hookInput(transcript, QUESTION))).toEqual([])
  })

  it('posts nothing for a PreToolUse of any other tool in Plan mode', async () => {
    const { home, transcript } = codexHome([PLAN_LINE])
    expect(await posted(home, hookInput(transcript, { hook_event_name: 'PreToolUse', tool_use_id: 'call_7' }))).toEqual([])
  })

  it('posts nothing for another event', async () => {
    const { home, transcript } = codexHome()
    expect(await posted(home, hookInput(transcript, { hook_event_name: 'Stop' }))).toEqual([])
  })

  it.each([
    ['stdin that is not JSON', 'not json'],
    ['JSON that is not an object', '["Bash"]'],
    ['no session_id', { session_id: undefined }],
    ['an empty session_id', { session_id: '' }],
    ['a session_id that is not a string', { session_id: 7 }],
    ['no turn_id', { turn_id: undefined }],
    ['a turn_id that is not a string', { turn_id: 7 }],
    ['no transcript_path', { transcript_path: undefined }],
    ['a transcript_path that is not a string', { transcript_path: 7 }],
    ['no tool_name', { tool_name: undefined }],
    ['a tool_name that is not a string', { tool_name: 7 }],
  ])('posts nothing for %s', async (_case, input) => {
    const { home, transcript } = codexHome()
    expect(await posted(home, typeof input === 'string' ? input : hookInput(transcript, input))).toEqual([])
  })

  it('posts nothing for 256 KiB + 1 of stdin', async () => {
    const { home, transcript } = codexHome()
    const base = JSON.stringify(hookInput(transcript, { pad: '' }))
    const text = JSON.stringify(hookInput(transcript, { pad: 'x'.repeat(256 * 1024 + 1 - Buffer.byteLength(base)) }))
    expect(Buffer.byteLength(text)).toBe(256 * 1024 + 1)
    expect(await posted(home, text)).toEqual([])
  })

  it('nothing else of the input leaves', async () => {
    const { home, transcript } = codexHome()
    const plan = codexHome([PLAN_LINE])
    const patch = `*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+API_KEY=${SECRET}\n*** End Patch`
    const bodies = [
      ...await posted(home, hookInput(transcript), hookInput(transcript, { tool_name: 'apply_patch', tool_input: { command: patch } })),
      ...await posted(plan.home, hookInput(plan.transcript, QUESTION)),
    ]
    expect(bodies.map((body) => body.summary)).toEqual(['touch /tmp/probe', 'src/app.ts', 'Which color?'])
    expect(JSON.stringify(bodies)).not.toContain(SECRET)
    expect(JSON.stringify(bodies)).not.toContain(USER_TURN)
    expect(JSON.stringify(bodies)).not.toContain(transcript)
  })

  // The core's own check (core/observedHook.ts): an event it refused would show nothing on the dial.
  it('the core takes every body it sends, at each bound', async () => {
    const { home, transcript } = codexHome()
    const plan = codexHome([PLAN_LINE])
    const mcp = `mcp__server__${'t'.repeat(57)}`
    expect(mcp).toHaveLength(70)
    const bodies = [
      ...await posted(home, hookInput(transcript, { tool_name: mcp, tool_input: {}, cwd: `/${'d'.repeat(1023)}` })),
      ...await posted(plan.home, hookInput(plan.transcript, { ...QUESTION, tool_input: { questions: [{ question: '日'.repeat(100) }] } })),
    ]
    expect(bodies.map((body) => [body.tool, body.summary])).toEqual([[mcp.slice(0, 64), mcp], ['request_user_input', '日'.repeat(66)]])
    for (const body of bodies) expect(parseObservedHook(body)).toStrictEqual(body)
  })

  it('always exits 0: a post that throws, stdin that fails', async () => {
    const { home, transcript } = codexHome()
    const stdin = chunks(JSON.stringify(hookInput(transcript)))
    expect(await runCodexAsked({ stdin, post: async () => { throw new Error('boom') }, codexHome: home })).toBe(0)
    async function* failing(): AsyncIterable<Buffer> { yield Buffer.from('{'); throw new Error('EIO') }
    expect(await runCodexAsked({ stdin: failing(), post: async () => {}, codexHome: home })).toBe(0)
  })
})

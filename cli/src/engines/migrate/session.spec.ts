import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readClaudeHead } from '../../lib/sessionSearch/externals/claude.js'
import { readCodexHead } from '../../lib/sessionSearch/externals/codex.js'
import { readSessionTurns } from '../../lib/sessionSearch/sessionTurns.js'
import { readClaudeTranscript, writeClaudeTranscript } from './claudeCode.js'
import { readCodexRollout } from './codex.js'
import { claudeProjectFolder, claudeSessionPath, codexRolloutPath, convertSession, ConvertError, writeNewSessionFile } from './session.js'

/**
 * A conversation moved between Claude Code and Codex must read back, through Harness's own readers of the target
 * engine, as the same turns the source reads as: the person's words, the agent's answers and its tool calls.
 */
const CWD = '/Users/someone/work/my_app'
const NEW_ID = '0b5a3c1e-7d2f-4e8a-9c61-2f4d8b7a1e90'
const NOW = Date.parse('2026-11-19T10:00:00.000Z')

/** A Claude Code transcript as its CLI writes one: bookkeeping lines, a signed thinking block, a Bash call and its
 *  result, a local command, two turns. */
function claudeFixture(sessionId = 'c1d2e3f4-0000-4000-8000-000000000001'): string {
  let parent: string | null = null, n = 0
  const line = (record: Record<string, unknown>) => {
    const uuid = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
    const out = { parentUuid: parent, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId, version: '2.1.317',
      gitBranch: 'main', timestamp: new Date(Date.parse('2026-11-18T09:00:00.000Z') + n * 1000).toISOString(), uuid, ...record }
    parent = uuid
    return JSON.stringify(out)
  }
  return [
    JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }),
    line({ type: 'user', message: { role: 'user', content: 'List the files and fix the typo in README.md' } }),
    line({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'thinking', thinking: 'I should look at the folder first.', signature: 'sig-abc' }] } }),
    line({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls', description: 'List files' } }], stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 } } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'README.md\nsrc' }] } }),
    line({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'tool_use', id: 'toolu_02', name: 'Edit', input: { file_path: `${CWD}/README.md`, old_string: 'teh', new_string: 'the' } }] } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'The file was updated.' }] } }),
    line({ type: 'assistant', message: { id: 'msg_3', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Fixed the typo in README.md.' }],
      stop_reason: 'end_turn' } }),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1200, uuid: 'sys-1', timestamp: '2026-11-18T09:00:09.000Z' }),
    line({ type: 'user', message: { role: 'user', content: 'Thanks. What does src hold?' } }),
    line({ type: 'assistant', message: { id: 'msg_4', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Only the parser for now.' }] } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'Typo fix', sessionId }),
    '{"type":"user","torn',
  ].join('\n') + '\n'
}

/** A Codex rollout as its CLI writes one: session meta, setup prelude, turn context, reasoning, an exec call with
 *  both its function output and its exec event, a patch, two turns. */
function codexFixture(id = '019a0000-1111-7222-8333-444455556666'): string {
  let n = 0
  const at = () => new Date(Date.parse('2026-11-18T09:00:00.000Z') + ++n * 1000).toISOString()
  const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(), type, payload })
  return [
    line('session_meta', { id, timestamp: '2026-11-18T09:00:00.000Z', cwd: CWD, originator: 'codex_cli_rs', cli_version: '0.166.0', source: 'cli', model_provider: 'openai',
      base_instructions: { text: 'You are Codex.' }, git: { branch: 'main' } }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd>\n</environment_context>' }] }),
    line('turn_context', { turn_id: 't1', cwd: CWD, model: 'gpt-6' }),
    line('event_msg', { type: 'task_started', turn_id: 't1' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run the tests and tell me what fails' }] }),
    line('event_msg', { type: 'user_message', message: 'Run the tests and tell me what fails', kind: 'plain' }),
    line('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Running the test suite first.' }], encrypted_content: 'gAAA' }),
    line('event_msg', { type: 'agent_reasoning', text: 'Running the test suite first.' }),
    line('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test', workdir: CWD }), call_id: 'call_1' }),
    line('event_msg', { type: 'exec_command_end', call_id: 'call_1', exit_code: 1, aggregated_output: '1 failing: parser' }),
    line('response_item', { type: 'function_call_output', call_id: 'call_1', output: 'Process exited with code 1\n1 failing: parser' }),
    line('response_item', { type: 'custom_tool_call', status: 'completed', call_id: 'call_2', name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: src/parser.ts\n@@\n-return 1\n+return 2\n*** End Patch' }),
    line('response_item', { type: 'custom_tool_call_output', call_id: 'call_2', output: JSON.stringify({ output: 'Success. Updated src/parser.ts', metadata: { exit_code: 0 } }) }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The parser test failed; I fixed the return value.' }] }),
    line('event_msg', { type: 'agent_message', message: 'The parser test failed; I fixed the return value.' }),
    line('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } } }),
    line('event_msg', { type: 'task_complete', turn_id: 't1' }),
    line('turn_context', { turn_id: 't2', cwd: CWD, model: 'gpt-6' }),
    line('event_msg', { type: 'task_started', turn_id: 't2' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Good. Commit it?' }] }),
    line('event_msg', { type: 'user_message', message: 'Good. Commit it?', kind: 'plain' }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Not yet: say the word and I will.' }] }),
    line('event_msg', { type: 'agent_message', message: 'Not yet: say the word and I will.' }),
    line('event_msg', { type: 'task_complete', turn_id: 't2' }),
  ].join('\n') + '\n'
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'migrate-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const turnsOf = async (engine: string, sessionId: string, text: string) => {
  const path = join(dir, `${engine}-${sessionId}.jsonl`)
  writeFileSync(path, text)
  return (await readSessionTurns({ engine, sessionId, transcriptPath: path })).map(turn => ({ ask: turn.ask, answer: turn.answer, tools: turn.tools }))
}
const records = (text: string) => text.trim().split('\n').map(line => JSON.parse(line) as Record<string, any>)

describe('Claude Code to Codex', () => {
  it('reads back through Harness\'s Codex reader as the same turns', async () => {
    const source = claudeFixture()
    const { text } = convertSession('claude', source, { sessionId: NEW_ID, cwd: CWD, now: NOW })
    const before = await turnsOf('claude', 'c1d2e3f4-0000-4000-8000-000000000001', source)
    const after = await turnsOf('codex', NEW_ID, text)
    expect(after.map(({ ask, answer }) => ({ ask, answer }))).toEqual(before.map(({ ask, answer }) => ({ ask, answer })))
    expect(after).toHaveLength(2)
    expect(after[0]!.answer).toBe('Fixed the typo in README.md.')
    expect(after[0]!.tools).toContain('ls')
    expect(after[0]!.tools).toContain('README.md')
  })

  it('writes the session Codex resumes: its meta first, the call and its result paired, the reasoning as a summary', () => {
    const { text } = convertSession('claude', claudeFixture(), { sessionId: NEW_ID, cwd: CWD, now: NOW })
    const lines = records(text)
    expect(lines[0]).toEqual({ timestamp: '2026-11-19T10:00:00.000Z', type: 'session_meta', payload: {
      id: NEW_ID, timestamp: '2026-11-19T10:00:00.000Z', cwd: CWD, originator: 'codex_cli_rs', cli_version: '', source: 'cli',
      model_provider: 'openai', base_instructions: null, git: { branch: 'main' } } })
    const items = lines.filter(line => line.type === 'response_item').map(line => line.payload)
    expect(items.find(item => item.type === 'reasoning')).toEqual({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'I should look at the folder first.' }], encrypted_content: null })
    expect(items.find(item => item.type === 'function_call')).toEqual({ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls"}', call_id: 'toolu_01' })
    expect(items.find(item => item.type === 'function_call_output')).toEqual({ type: 'function_call_output', call_id: 'toolu_01', output: 'README.md\nsrc' })
    // An Edit is Codex's own apply_patch, and its result the custom output that pairs with it.
    expect(items.find(item => item.type === 'custom_tool_call')).toMatchObject({ name: 'apply_patch', call_id: 'toolu_02',
      input: `*** Begin Patch\n*** Update File: ${CWD}/README.md\n@@\n-teh\n+the\n*** End Patch` })
    expect(JSON.parse(items.find(item => item.type === 'custom_tool_call_output').output)).toEqual({ output: 'The file was updated.', metadata: { exit_code: 0, duration_seconds: 0 } })
    expect(lines.filter(line => line.payload.type === 'user_message').map(line => line.payload.message))
      .toEqual(['List the files and fix the typo in README.md', 'Thanks. What does src hold?'])
    // Every call has its result.
    const calls = items.filter(item => /call$/.test(item.type)).map(item => item.call_id)
    const results = items.filter(item => /output$/.test(item.type)).map(item => item.call_id)
    expect(results).toEqual(calls)
  })

  it('is a conversation Harness adopts as a terminal\'s, in its folder', async () => {
    const { text } = convertSession('claude', claudeFixture(), { sessionId: NEW_ID, cwd: CWD, now: NOW })
    const path = codexRolloutPath(join(dir, 'codex'), NOW, NEW_ID)
    writeNewSessionFile(path, text)
    expect(await readCodexHead(path)).toEqual({ sessionId: NEW_ID, cwd: CWD, origin: 'terminal' })
    expect(readCodexRollout(text).meta).toMatchObject({ id: NEW_ID, cwd: CWD, gitBranch: 'main' })
  })
})

describe('Codex to Claude Code', () => {
  it('reads back through Harness\'s Claude reader as the same turns', async () => {
    const source = codexFixture()
    const { text } = convertSession('codex', source, { sessionId: NEW_ID, cwd: CWD, now: NOW })
    const before = await turnsOf('codex', '019a0000-1111-7222-8333-444455556666', source)
    const after = await turnsOf('claude', NEW_ID, text)
    expect(after.map(({ ask, answer }) => ({ ask, answer }))).toEqual(before.map(({ ask, answer }) => ({ ask, answer })))
    expect(after).toHaveLength(2)
    expect(after[0]!.tools).toContain('npm test')
  })

  it('writes the transcript Claude Code resumes: one parent chain, every call answered, no unsigned reasoning', () => {
    const { text } = convertSession('codex', codexFixture(), { sessionId: NEW_ID, cwd: CWD, now: NOW })
    const lines = records(text)
    let parent: string | null = null
    for (const line of lines) {
      expect(line).toMatchObject({ sessionId: NEW_ID, cwd: CWD, entrypoint: 'cli', isSidechain: false, userType: 'external', parentUuid: parent })
      expect(line.version).toBeUndefined()
      parent = line.uuid
    }
    const blocks = lines.flatMap(line => line.message.content as Array<Record<string, any>>)
    expect(blocks.some(block => block.type === 'thinking')).toBe(false)
    expect(blocks.filter(block => block.type === 'tool_use')).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'npm test', workdir: CWD } },
      { type: 'tool_use', id: 'call_2', name: 'Edit', input: { file_path: 'src/parser.ts', old_string: 'return 1', new_string: 'return 2' } },
    ])
    // The exec event's result stands; the duplicate function output that shadows it is gone.
    expect(blocks.filter(block => block.type === 'tool_result')).toEqual([
      { type: 'tool_result', tool_use_id: 'call_1', content: '1 failing: parser', is_error: true },
      { type: 'tool_result', tool_use_id: 'call_2', content: 'Success. Updated src/parser.ts' },
    ])
    const used = lines.find(line => line.message.usage)?.message
    expect(used).toMatchObject({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } })
    expect(used.model, 'a Codex model is never the resumed Claude Code\'s').toBeUndefined()
  })

  it('is a conversation Harness adopts as a terminal\'s, in Claude Code\'s folder for its cwd', async () => {
    const { text } = convertSession('codex', codexFixture(), { sessionId: NEW_ID, cwd: CWD, now: NOW })
    const path = claudeSessionPath(join(dir, 'projects'), CWD, NEW_ID)
    expect(path).toBe(join(dir, 'projects', '-Users-someone-work-my-app', `${NEW_ID}.jsonl`))
    writeNewSessionFile(path, text)
    expect(await readClaudeHead(path)).toEqual({ sessionId: NEW_ID, cwd: CWD, origin: 'terminal' })
  })

  it('carries a title, an image and a slash command, and makes a call id Anthropic accepts', () => {
    const at = '2026-11-18T09:00:01.000Z'
    const rollout = [
      { timestamp: at, type: 'session_meta', payload: { id: 'x', cwd: CWD, source: 'cli' } },
      { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is this?' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBOR' }] } },
      { timestamp: at, type: 'response_item', payload: { type: 'web_search_call', action: { type: 'search', query: 'q' } } },
      { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A chart.' }] } },
    ].map(row => JSON.stringify(row)).join('\n')
    const blocks = records(convertSession('codex', rollout, { sessionId: NEW_ID, cwd: CWD, now: NOW }).text).flatMap(line => line.message.content)
    expect(blocks).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } })
    expect(blocks).toContainEqual({ type: 'tool_use', id: 'web_search_1', name: 'WebSearch', input: { type: 'search', query: 'q' } })
  })
})

describe('round trips and slash commands', () => {
  it('keeps a Claude slash command and its output as Claude Code\'s own envelopes', () => {
    const base = { sessionId: 's', cwd: CWD, timestamp: '2026-11-18T09:00:00.000Z' }
    const source = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' } },
      { ...base, type: 'system', subtype: 'local_command', uuid: 'u2', parentUuid: 'u1', content: '<local-command-stdout>Set model to \u001b[1mopus\u001b[22m</local-command-stdout>' },
      { ...base, type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: 'hello' } },
      { ...base, type: 'assistant', uuid: 'u4', parentUuid: 'u3', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ].map(row => JSON.stringify(row)).join('\n')
    const read = readClaudeTranscript(source)
    expect(read.messages[0]!.content).toEqual([{ type: 'tool_use', id: 'u1', tool: { name: '/model', input: { args: 'opus' } } }])
    expect(read.messages[1]!.content).toEqual([{ type: 'tool_result', toolUseId: 'u1', content: { text: 'Set model to opus' }, isError: false }])
    const lines = records(writeClaudeTranscript({ ...read, meta: { ...read.meta, id: NEW_ID } }))
    expect(lines[0]!.message.content).toBe('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>')
    expect(lines[1]).toMatchObject({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Set model to opus</local-command-stdout>' })
  })

  it('leaves a Claude slash command and what it printed out of Codex, which showed a `_model` row for each', () => {
    const base = { sessionId: 's', cwd: CWD, timestamp: '2026-11-18T09:00:00.000Z' }
    const source = [
      { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>' } },
      { ...base, type: 'system', subtype: 'local_command', uuid: 'u2', parentUuid: 'u1', content: '<local-command-stdout>Set model to opus</local-command-stdout>' },
      { ...base, type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: 'hello' } },
      { ...base, type: 'assistant', uuid: 'u4', parentUuid: 'u3', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ].map(row => JSON.stringify(row)).join('\n')
    const text = convertSession('claude', source, { sessionId: NEW_ID, cwd: CWD, now: NOW }).text
    expect(text).not.toContain('_model')
    expect(text).not.toContain('Set model to')
    expect(readCodexRollout(text).messages.flatMap(m => m.content)).toEqual([
      { type: 'text', text: 'hello' }, { type: 'text', text: 'hi' },
    ])
  })

  it('refuses a conversation with nothing said', () => {
    expect(() => convertSession('claude', '{"type":"summary","summary":"x"}\n', { sessionId: NEW_ID, cwd: CWD, now: NOW })).toThrow(ConvertError)
  })
})

describe('where a converted session is written', () => {
  it('names Codex\'s dated folder and file in local time', () => {
    const at = new Date(2026, 10, 19, 8, 5, 3).getTime()
    expect(codexRolloutPath('/h', at, NEW_ID)).toBe(join('/h', 'sessions', '2026', '11', '19', `rollout-2026-11-19T08-05-03-${NEW_ID}.jsonl`))
  })

  it('uses a long folder only when Claude Code made it', () => {
    const projects = join(dir, 'projects')
    const long = `/${'a'.repeat(250)}`
    expect(() => claudeProjectFolder(projects, long)).toThrow(ConvertError)
    const made = join(projects, `-${'a'.repeat(199)}-12345`)
    mkdirSync(made, { recursive: true })
    expect(claudeProjectFolder(projects, long)).toBe(made)
  })

  it('writes a new file its owner alone reads, and never over one', () => {
    const path = join(dir, 'a', 'b', 'session.jsonl')
    writeNewSessionFile(path, 'one\n')
    expect(readFileSync(path, 'utf8')).toBe('one\n')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => writeNewSessionFile(path, 'two\n')).toThrow(/EEXIST/)
    expect(readFileSync(path, 'utf8')).toBe('one\n')
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['session.jsonl'])
  })
})

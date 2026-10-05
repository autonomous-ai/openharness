import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { claudeMemoryCapability, runClaudeMemoryInference } from './claudeInference.js'

let directory: string, binary: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'claude-memory-inference-')); binary = join(directory, 'claude-fixture'); vi.stubEnv('CLAUDE_PATH', binary) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })
function program(body: string, version = '2.1.285'): void {
  writeFileSync(binary, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('${version} (Claude Code)'); process.exit(0); }
let input = ''; process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => { ${body} });
`, { mode: 0o700 })
}
const emit = (event: unknown) => `console.log(${JSON.stringify(JSON.stringify(event))});`
const success = emit({ type: 'result', subtype: 'success', is_error: false, result: '{"proposals":[]}' })

it.each(['2.1.285', '2.1.286', '2.1.287'])('uses a fresh %s native process with the selected model/effort and an empty tool catalog', async version => {
  const capture = join(directory, 'launch.json')
  program(`require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),
    foreignToken:process.env.ANTHROPIC_AUTH_TOKEN, tmux:process.env.TMUX, prompt:input}));
    ${emit({ type: 'system', subtype: 'init', tools: [] })} ${success}`, version)
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'not-the-selected-account')
  vi.stubEnv('TMUX', 'parent-terminal')
  expect(await runClaudeMemoryInference({ cwd: directory, prompt: 'synthetic evidence', model: 'selected-model', effort: 'high' }))
    .toEqual({ text: '{"proposals":[]}' })
  const launch = JSON.parse(readFileSync(capture, 'utf8'))
  expect(launch.args).toEqual(expect.arrayContaining(['--model', 'selected-model', '--effort', 'high', '--tools', '',
    '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence']))
  expect(launch.prompt).toBe('synthetic evidence')
  expect(launch.foreignToken).toBeUndefined()
  expect(launch.tmux).toBeUndefined()
})

it('lets native credential lookup use the actual OS user, never an inherited claimed identity', async () => {
  program(`const owner=require('node:os').userInfo().username;
    if(process.env.USER!==owner || process.env.LOGNAME!==owner) process.exit(7);
    ${emit({ type: 'system', subtype: 'init', tools: [] })} ${success}`)
  vi.stubEnv('USER', 'a-different-user')
  vi.stubEnv('LOGNAME', 'a-different-user')
  expect(await runClaudeMemoryInference({ cwd: directory, prompt: 'synthetic evidence', model: 'selected-model' }))
    .toEqual({ text: '{"proposals":[]}' })
})

it.each([
  { type: 'system', subtype: 'init', tools: ['Bash'] },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'false' } }] } },
  { type: 'system', subtype: 'hook_started' },
])('rejects tool availability or a tool attempt before accepting any result', async event => {
  program(`${emit(event)} ${success}`)
  await expect(runClaudeMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model' })).rejects.toThrow('inference_tool_or_error')
})

it('does not treat an error result or partial assistant prose as a completed extraction', async () => {
  program(`${emit({ type: 'assistant', message: { content: [{ type: 'text', text: '{"proposals":[]}' }] } })}
    ${emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['quota exhausted'] })}`)
  await expect(runClaudeMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model' })).rejects.toThrow('inference_usage_limit')
})

// Sanitized native 2.1.286 observations: weekly-limit rejection, assistant.error=rate_limit,
// and a success-subtype result with is_error=true. Omitted account/session identifiers and prose.
it.each([
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day' } },
  { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Usage unavailable' }] } },
  { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit" },
])('defers native usage rejection without accepting a later answer', async event => {
  program(`${emit(event)} ${success}`)
  await expect(runClaudeMemoryInference({ cwd: directory, prompt: 'synthetic evidence', model: 'opus' }))
    .rejects.toThrow('inference_usage_limit')
})

it.each(['allowed', 'allowed_warning'])('allows %s rate-limit telemetry without inventing a quota failure', async status => {
  program(`${emit({ type: 'rate_limit_event', rate_limit_info: { status } })} ${success}`)
  expect(await runClaudeMemoryInference({ cwd: directory, prompt: 'synthetic evidence', model: 'opus' }))
    .toEqual({ text: '{"proposals":[]}' })
})

it('rejects a native assistant error even if a later frame claims success', async () => {
  program(`${emit({ type: 'assistant', error: 'authentication_failed', message: { content: [{ type: 'text', text: 'Unavailable' }] } })} ${success}`)
  await expect(runClaudeMemoryInference({ cwd: directory, prompt: 'synthetic evidence', model: 'opus' }))
    .rejects.toThrow('inference_unavailable')
})

it('waits on an uncertified native release', async () => {
  program('throw new Error("must not invoke")', '2.99.0')
  expect(await claudeMemoryCapability()).toEqual({ supported: false, version: '2.99.0' })
  await expect(runClaudeMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model' })).rejects.toThrow('claude_version_uncertified')
})

it('preserves a Unicode response split across pipe chunks', async () => {
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"claim":"café"}' }) + '\n'
  program(`const bytes=Buffer.from(${JSON.stringify(result)}); const split=bytes.indexOf(Buffer.from('é'))+1;
    process.stdout.write(bytes.subarray(0,split)); setTimeout(()=>process.stdout.write(bytes.subarray(split)),20);`)
  expect((await runClaudeMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model' })).text).toBe('{"claim":"café"}')
})

it('reports only the resolved model and native usage/cost, excluding source text and raw events', async () => {
  program(`${emit({ type: 'system', subtype: 'init', tools: [], model: 'claude-opus-4-6', session_id: 'private-session' })}
    ${emit({ type: 'assistant', message: { content: [{ type: 'thinking', text: 'private reasoning' }] } })}
    ${emit({ type: 'result', subtype: 'success', result: '{"proposals":[]}', total_cost_usd: 0.12,
      usage: { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, private_field: 'private' } })}`)
  const observations: unknown[] = []
  await runClaudeMemoryInference({ cwd: directory, prompt: 'synthetic evidence', model: 'opus', observe: value => { observations.push(value) } })
  expect(observations).toEqual([{ model: 'claude-opus-4-6' }, {
    usage: { inputTokens: 4, outputTokens: 9, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 }, reportedCostUsd: 0.12,
  }])
})

it.each(['sync', 'async'])('leaves absent or invalid diagnostics unknown and ignores a %s observer failure', async mode => {
  program(`${emit({ type: 'system', subtype: 'init', tools: [], model: 'unexpected\ntext' })}
    ${emit({ type: 'result', subtype: 'success', result: '{"proposals":[]}', total_cost_usd: -1, usage: { input_tokens: 3 } })}`)
  const observations: unknown[] = []
  expect(await runClaudeMemoryInference({ cwd: directory, prompt: 'evidence', model: 'opus', observe: value => {
    observations.push(value)
    if (mode === 'async') return Promise.reject(new Error('diagnostic sink unavailable'))
    throw new Error('diagnostic sink unavailable')
  } })).toEqual({ text: '{"proposals":[]}' })
  expect(observations).toEqual([{ usage: undefined }])
})

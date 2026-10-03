import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexMemoryCapability, CODEX_MEMORY_DISABLED_FEATURES, runCodexMemoryInference } from './inference.js'

let directory: string
let binary: string
const fixtures: string[] = []
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-inference-')); fixtures.push(directory)
  binary = join(directory, 'codex-fixture'); vi.stubEnv('CODEX_PATH', binary)
})
afterEach(() => { vi.unstubAllEnvs(); for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }) })
function program(body: string, version = '0.159.0'): void {
  writeFileSync(binary, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex-cli ${version}'); process.exit(0); }
let input = ''; process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => { ${body} });
`, { mode: 0o700 })
}
const emit = (type: string, item?: unknown) => `console.log(${JSON.stringify(JSON.stringify({ type, ...(item ? { item } : {}) }))});`

it('uses the selected model/account and disables the certified execution features', async () => {
  const capture = join(directory, 'launch.json')
  program(`require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),
    profile:process.env.CODEX_HOME, tmux:process.env.TMUX, apiKey:process.env.CODEX_API_KEY, prompt:input}));
    ${emit('thread.started')} ${emit('turn.started')} ${emit('item.completed', { type: 'agent_message', text: '{"proposals":[]}' })}
    ${emit('turn.completed')}`)
  vi.stubEnv('TMUX', 'terminal-context')
  vi.stubEnv('CODEX_API_KEY', 'unselected-ambient-key')
  const result = await runCodexMemoryInference({ cwd: directory, prompt: 'synthetic evidence', model: 'selected-model',
    effort: 'xhigh', codexHome: join(directory, 'selected-account'), timeoutMs: 3000 })
  expect(result.text).toBe('{"proposals":[]}')
  const launch = JSON.parse(readFileSync(capture, 'utf8'))
  expect(launch.args).toEqual(expect.arrayContaining(['--model', 'selected-model', 'model_reasoning_effort="xhigh"', 'web_search="disabled"']))
  for (const feature of CODEX_MEMORY_DISABLED_FEATURES) expect(launch.args).toContain(feature)
  expect(launch.profile).toBe(join(directory, 'selected-account'))
  expect(launch.prompt).toBe('synthetic evidence')
  expect(launch.tmux).toBeUndefined()
  expect(launch.apiKey).toBeUndefined()
})

it.each(['command_execution', 'mcp_tool_call', 'error'])('refuses a %s item even when a final answer follows', async type => {
  program(`${emit('item.completed', { type, text: 'untrusted tool result' })}
    ${emit('item.completed', { type: 'agent_message', text: '{"proposals":[]}' })} ${emit('turn.completed')}`)
  await expect(runCodexMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model', timeoutMs: 3000 }))
    .rejects.toThrow('inference_tool_or_error')
})

it.each(['0.159.3', '0.160.0', '0.999.0'])('does not invoke uncertified extraction release %s or silently select a different provider', async version => {
  program('throw new Error("must not run inference")', version)
  expect(await codexMemoryCapability()).toEqual({ supported: false, version })
  await expect(runCodexMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model' })).rejects.toThrow('codex_version_uncertified')
})

it('rejects an unknown event instead of assuming a changed protocol is harmless', async () => {
  program(`${emit('new_tool_event')} ${emit('item.completed', { type: 'agent_message', text: '{"proposals":[]}' })} ${emit('turn.completed')}`)
  await expect(runCodexMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model' })).rejects.toThrow('inference_protocol_changed')
})

it('aborts a background process and does not accept its later answer', async () => {
  program('setTimeout(() => {}, 10000)')
  const controller = new AbortController()
  const result = runCodexMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model', signal: controller.signal })
  const assertion = expect(result).rejects.toThrow('inference_cancelled')
  setTimeout(() => controller.abort(), 100)
  await assertion
})

it('cancels while checking the native version without misreporting an unsupported release', async () => {
  writeFileSync(binary, `#!${process.execPath}\nsetTimeout(() => console.log('codex-cli 0.159.0'), 10000);\n`, { mode: 0o700 })
  const controller = new AbortController()
  const result = runCodexMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model', signal: controller.signal })
  const assertion = expect(result).rejects.toThrow('inference_cancelled')
  setTimeout(() => controller.abort(), 50)
  await assertion
})

it('preserves native token counters without inventing a resolved model or price', async () => {
  const complete = { type: 'turn.completed', usage: { input_tokens: 123, cached_input_tokens: 40, output_tokens: 22, private_field: 'private' } }
  program(`${emit('item.completed', { type: 'agent_message', text: '{"proposals":[]}' })}
    console.log(${JSON.stringify(JSON.stringify(complete))});`)
  const observations: unknown[] = []
  await runCodexMemoryInference({ cwd: directory, prompt: 'evidence', model: 'selected-model', observe: value => { observations.push(value) } })
  expect(observations).toEqual([{ usage: { inputTokens: 123, outputTokens: 22, cacheReadInputTokens: 40 } }])
})

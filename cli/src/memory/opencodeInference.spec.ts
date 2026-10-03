import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lstat } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import providerRefusal from './__fixtures__/opencode-1.18.34-provider-refusal.json' with { type: 'json' }
import { openCodeSnapshotIdentity, opencodeMemoryCapability, runOpenCodeMemoryInference, type OpenCodeMemorySnapshot } from './opencodeInference.js'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, lstat: vi.fn(original.lstat) }
})

let directory: string, binary: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'opencode-memory-test-'))
  binary = join(directory, 'opencode-fixture'); vi.stubEnv('OPENCODE_PATH', binary)
})
afterEach(() => { vi.unstubAllEnvs(); vi.mocked(lstat).mockReset(); rmSync(directory, { recursive: true, force: true }) })
const snapshot: OpenCodeMemorySnapshot = { model: 'selected/model', variant: 'high', auth: { type: 'api', key: 'synthetic-account-a' },
  provider: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://selected.invalid/v1' },
    models: { model: { name: 'Selected model', limit: { context: 128_000, output: 4096 } } } } }
const event = (type: string, part: Record<string, unknown>) => ({ type, sessionID: 'session',
  part: { sessionID: 'session', messageID: 'message', ...part } })
const start = event('step_start', { type: 'step-start' })
const text = (value = '{"proposals":[]}') => event('text', { type: 'text', id: 'text', text: value })
const finish = event('step_finish', { type: 'step-finish', reason: 'stop' })
const emit = (events: unknown[]) => events.map(value => `console.log(${JSON.stringify(JSON.stringify(value))})`).join(';')
function program(body = emit([start, text(), finish]), version = '1.18.34'): void {
  writeFileSync(binary, `#!${process.execPath}
if(process.argv.includes('--version')){ console.log('${version}'); process.exit(0) }
let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{${body}})
`, { mode: 0o700 })
}
function options() {
  return { cwd: directory, prompt: 'synthetic evidence', model: snapshot.model, timeoutMs: 2000,
    expectedSnapshot: openCodeSnapshotIdentity(snapshot), readSnapshot: vi.fn(async () => snapshot) }
}

it('uses only the bound provider, credential, model and variant in disposable native storage', async () => {
  const output = join(directory, 'launch.json')
  program(`const env=process.env;
    require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),prompt:input,
      auth:JSON.parse(env.OPENCODE_AUTH_CONTENT),config:JSON.parse(env.OPENCODE_CONFIG_CONTENT),db:env.OPENCODE_DB,
      originalConfig:env.OPENCODE_CONFIG,foreignKey:env.OPENAI_API_KEY,tmux:env.TMUX,nodeOptions:env.NODE_OPTIONS}));
    ${emit([start, text(), finish])}`)
  vi.stubEnv('OPENAI_API_KEY', 'unselected-account'); vi.stubEnv('OPENCODE_CONFIG', '/unselected/provider.json')
  vi.stubEnv('TMUX', 'foreground-pane'); vi.stubEnv('NODE_OPTIONS', '--require=unselected-hook')
  const opts = options()
  expect(await runOpenCodeMemoryInference(opts)).toEqual({ text: '{"proposals":[]}' })
  expect(opts.readSnapshot).toHaveBeenCalledTimes(3)
  const launch = JSON.parse(readFileSync(output, 'utf8'))
  expect(launch.args).toEqual(['run', '--pure', '--format', 'json', '--model', snapshot.model, '--agent', 'harness_memory',
    '--title', 'Private coding memory', '--variant', 'high'])
  expect(launch.auth).toEqual({ selected: snapshot.auth })
  expect(launch.config).toMatchObject({ model: snapshot.model, small_model: snapshot.model, enabled_providers: ['selected'],
    permission: { '*': 'deny' }, agent: { harness_memory: { permission: { '*': 'deny' } } }, provider: { selected: snapshot.provider } })
  for (const key of ['originalConfig', 'foreignKey', 'tmux', 'nodeOptions']) expect(launch[key]).toBeUndefined()
  expect(launch.cwd).toContain('/opencode-memory-')
  expect(launch.db).toContain('/opencode-memory-')
  expect(launch.prompt).toBe('synthetic evidence')
  expect(readdirSync(directory).filter(name => name.startsWith('opencode-memory-'))).toEqual([])
})

it.each(['model', 'variant', 'auth', 'provider'] as const)('rejects a changed %s before launching a leased prompt', async field => {
  program('process.exit(9)')
  const changed = { ...snapshot, [field]: field === 'model' ? 'other/model' : field === 'variant' ? 'low'
    : field === 'auth' ? { type: 'api', key: 'synthetic-account-b' } : { ...snapshot.provider, options: { baseURL: 'https://other.invalid' } } }
  await expect(runOpenCodeMemoryInference({ ...options(), readSnapshot: async () => changed }))
    .rejects.toThrow('inference_context_changed')
  expect(readdirSync(directory)).toEqual(['opencode-fixture'])
})

it('rechecks the binding immediately before invocation and after output, then removes temporary state', async () => {
  program()
  for (const failAt of [2, 3]) {
    let reads = 0
    await expect(runOpenCodeMemoryInference({ ...options(), readSnapshot: async () => ++reads === failAt ? null : snapshot }))
      .rejects.toThrow('inference_context_changed')
    expect(readdirSync(directory)).toEqual(['opencode-fixture'])
  }
})

it('preserves final synchronous host authorization after asynchronous snapshot checks', async () => {
  program('process.exit(9)')
  await expect(runOpenCodeMemoryInference({ ...options(), assertAuthorized: () => { throw new Error('owner_changed') } }))
    .rejects.toThrow('owner_changed')
  expect(readdirSync(directory)).toEqual(['opencode-fixture'])
})

it.each([
  event('tool_use', { type: 'tool', tool: 'bash', state: { status: 'error' } }),
  event('step_finish', { type: 'step-finish', reason: 'tool-calls' }),
])('rejects even unsuccessful native tool attempts before a later answer', bad => {
  program(emit([start, bad, text(), finish]))
  return expect(runOpenCodeMemoryInference(options())).rejects.toThrow('inference_tool_or_error')
})

it.each([
  [text(), finish],
  [start, text()],
  [start, text(), finish, start],
  [start, { ...text(), sessionID: 'another-session' }, finish],
  [start, text('first'), text('different'), finish],
  [start, { type: 'unknown_event' }, text(), finish],
].map(events => ({ events })))('rejects partial, mixed, rewritten or changed-protocol output', ({ events }) => {
  program(emit(events))
  return expect(runOpenCodeMemoryInference(options())).rejects.toThrow()
})

it('combines complete native text parts without duplicating repeated full snapshots', async () => {
  program(emit([start, text('{"pro'), text('{"proposals":'), event('text', { type: 'text', id: 'second', text: '[]}' }), finish]))
  expect(await runOpenCodeMemoryInference(options())).toEqual({ text: '{"proposals":[]}' })
})

it('identifies the recorded provider restriction without treating it as a transient outage', async () => {
  program(emit([providerRefusal]))
  await expect(runOpenCodeMemoryInference(options())).rejects.toThrow('inference_provider_restricted')
  expect(readdirSync(directory)).toEqual(['opencode-fixture'])
})

it.each([
  { ...providerRefusal.error.data, statusCode: 429 },
  { ...providerRefusal.error.data, isRetryable: true },
  { ...providerRefusal.error.data, responseBody: 'unrecognized provider response' },
  { ...providerRefusal.error.data, responseBody: '{"error":{"type":"FreeTierError","message":"Another free tier error"}}' },
])('does not turn other provider failures into a permanent restriction', async data => {
  program(emit([{ type: 'error', error: { name: 'APIError', data } }]))
  await expect(runOpenCodeMemoryInference(options())).rejects.toThrow('inference_unavailable')
})

it('retains only native usage and cost, leaving the provider-resolved model unknown', async () => {
  program(emit([start, text(), event('step_finish', { type: 'step-finish', reason: 'stop', cost: 0.02,
    tokens: { input: 20, output: 10, cache: { read: 4, write: 5 }, private: 'ignored' } })]))
  const observations: unknown[] = []
  await runOpenCodeMemoryInference({ ...options(), observe: value => { observations.push(value) } })
  expect(observations).toEqual([{ reportedCostUsd: 0.02, usage: { inputTokens: 20, outputTokens: 10,
    cacheReadInputTokens: 4, cacheCreationInputTokens: 5 } }])
})

it('does not probe accounts or invoke an uncertified version', async () => {
  program('process.exit(9)', '2.0.0')
  expect(await opencodeMemoryCapability()).toEqual({ supported: false, version: '2.0.0' })
  const opts = options()
  await expect(runOpenCodeMemoryInference(opts)).rejects.toThrow('opencode_version_uncertified')
  expect(opts.readSnapshot).not.toHaveBeenCalled()
})

it.each(['present', 'unreadable'])('refuses %s managed policy instead of overriding it', async kind => {
  program('process.exit(9)')
  if (kind === 'present') vi.mocked(lstat).mockResolvedValue({} as Awaited<ReturnType<typeof lstat>>)
  else vi.mocked(lstat).mockRejectedValue(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
  const opts = options()
  await expect(runOpenCodeMemoryInference(opts)).rejects.toThrow('opencode_managed_config_unsupported')
  expect(opts.readSnapshot).not.toHaveBeenCalled()
  expect(readdirSync(directory)).toEqual(['opencode-fixture'])
})

it('refuses unresolved routing, implicit model definitions and nested executable providers', () => {
  for (const provider of [
    { ...snapshot.provider, npm: 'file:///tmp/provider.mjs' },
    { ...snapshot.provider, models: {} },
    { ...snapshot.provider, models: { model: {}, other: {} } },
    { ...snapshot.provider, models: { model: { provider: { npm: 'unselected-package' } } } },
    { ...snapshot.provider, options: { baseURL: '{env:UNSELECTED_URL}' } },
    { ...snapshot.provider, options: { apiKey: '{file:/private/credential}' } },
    { ...snapshot.provider, options: { baseURL: 'https://${UNSELECTED_HOST}/v1' } },
  ]) expect(() => openCodeSnapshotIdentity({ ...snapshot, provider } as OpenCodeMemorySnapshot)).toThrow()
})

it('cancels a running native process and cleans up its private session storage', async () => {
  program('setTimeout(()=>{},10000)')
  const controller = new AbortController()
  const assertion = expect(runOpenCodeMemoryInference({ ...options(), signal: controller.signal })).rejects.toThrow('inference_cancelled')
  setTimeout(() => controller.abort(), 100)
  await assertion
  expect(readdirSync(directory)).toEqual(['opencode-fixture'])
})

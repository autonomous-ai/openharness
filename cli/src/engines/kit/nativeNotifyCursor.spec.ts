import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeNotifyContext } from '../../../hook/notify.mjs'
import { createNativeNotifyCursor, nativeCursorBody, nativeNotifyRuntime } from './nativeNotifyCursor.js'
import { deliverNativeHookClient } from './nativeHookClient.js'
import { captureNativeHookClientOrigin } from './nativeHookOrigin.js'
import { openNativeHookStorage } from './nativeHookStorage.js'
import { sendNativeHookRequest } from './nativeHookTransport.js'
import { probeNativeProcessControl } from '../../lib/nativeProcessControlProbe.js'
import { prepareProcessImageHelper } from '../../lib/nativeProcessImageArtifact.js'
import { creationFingerprint } from '../../lib/agentCreationReceipt.js'
import { appendNativeAllocation } from '../../lib/nativeAllocation.js'
import { nativeCreateFingerprint, parseNativeCreateRequest } from '../../lib/nativeCreateRequest.js'

vi.mock('./nativeHookClient.js', () => ({ deliverNativeHookClient: vi.fn() }))
vi.mock('./nativeHookOrigin.js', () => ({ captureNativeHookClientOrigin: vi.fn() }))
vi.mock('./nativeHookStorage.js', () => ({ openNativeHookStorage: vi.fn() }))
vi.mock('./nativeHookTransport.js', () => ({ sendNativeHookRequest: vi.fn() }))
vi.mock('../../lib/nativeProcessControlProbe.js', () => ({ probeNativeProcessControl: vi.fn() }))
vi.mock('../../lib/nativeProcessImageArtifact.js', () => ({ prepareProcessImageHelper: vi.fn() }))
let root: string
const input = (): NativeNotifyContext => ({ event: 'stop', input: { conversation_id: 'fixture-conversation', generation_id: 'fixture-generation',
  status: 'aborted', cursor_version: 'fixture-version', workspace_roots: ['/fixture/project'] },
  tmuxPane: '%1', port: 19400, dataDir: root, credential: 'fixture-token', id: 'fixture-native-delivery', firedAt: 1000,
  callerPid: 42, timeoutMs: 4000 })
const runtime = () => ({ schemaVersion: 2, agentId: 'fixture-agent', engine: 'cursor', active: true,
  processIdentity: { pid: 42, startMarker: 'fixture-start', executable: '<cursor>' },
  runtimes: [{ backend: 'tmux', paneId: '%1' }], primaryRuntimeKey: 'tmux:%1' })
beforeEach(() => {
  vi.clearAllMocks()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-notify-')))
  vi.mocked(deliverNativeHookClient).mockResolvedValue({ owned: true, completed: [] })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

it.each(['beforeSubmitPrompt', 'preToolUse', 'afterAgentResponse', 'stop'])('preserves native identity and the exact %s payload', event => {
  const context = input(); context.event = event
  Object.assign(context.input, { prompt: 'é📘', tool_name: 'Read', tool_use_id: 'fixture-tool', tool_input: { path: '/fixture/file' }, text: 'First line\nSecond line' })
  expect(nativeCursorBody(context)).toMatchObject({ engine: 'cursor', hookEvent: event, sessionId: 'fixture-conversation',
    generationId: 'fixture-generation', callerPid: 42, runtimeHints: [{ backend: 'tmux', paneId: '%1' }] })
  if (event === 'beforeSubmitPrompt') expect(nativeCursorBody(context)?.prompt).toBe('é📘')
  if (event === 'preToolUse') expect(nativeCursorBody(context)).toMatchObject({ toolName: 'Read', toolUseId: 'fixture-tool', input: { path: '/fixture/file' } })
  if (event === 'afterAgentResponse') expect(nativeCursorBody(context)?.responseText).toBe('First line\nSecond line')
  if (event === 'stop') expect(nativeCursorBody(context)?.status).toBe('aborted')
})

it.each([undefined, '', 42, 'bad\nid'])('holds missing or invalid generation %j before opening storage or sending', async generation_id => {
  const context = input(); context.input.generation_id = generation_id
  await expect(createNativeNotifyCursor({ selfPid: 43 })(context)).rejects.toThrow('generation ID')
  expect(deliverNativeHookClient).not.toHaveBeenCalled()
})

it('keeps session discovery separate from generation and end hints do not delete task state', async () => {
  const context = input(); context.event = 'sessionStart'; delete context.input.generation_id
  expect(nativeCursorBody(context)).not.toHaveProperty('generationId')
  context.event = 'sessionEnd'
  writeFileSync(join(root, 'cursor-pending-tasks.json'), '["unrelated task"]')
  await createNativeNotifyCursor({ selfPid: 43 })(context)
  expect(deliverNativeHookClient).not.toHaveBeenCalled()
  expect(readFileSync(join(root, 'cursor-pending-tasks.json'), 'utf8')).toBe('["unrelated task"]')
})

it('holds incomplete outcomes and oversized response bytes without truncating them', () => {
  const context = input(); context.input.status = 'success'
  expect(() => nativeCursorBody(context)).toThrow('outcome')
  context.event = 'afterAgentResponse'
  expect(() => nativeCursorBody(context)).toThrow('complete Cursor response')
  context.input.text = 'é'.repeat(65537)
  expect(() => nativeCursorBody(context)).toThrow('retained response limit')
  context.event = 'beforeSubmitPrompt'; context.input.prompt = 'x'.repeat(256 * 1024)
  expect(() => nativeCursorBody(context)).toThrow('retained delivery limit')
})

it.each([
  { status: ['completed'] }, { cursor_version: 42 }, { transcript_path: 'x'.repeat(4097) },
])('refuses unsupported metadata before retaining a permanent retry %j', async extra => {
  const context = input(); Object.assign(context.input, extra)
  await expect(createNativeNotifyCursor({ selfPid: 43 })(context)).rejects.toThrow()
  expect(deliverNativeHookClient).not.toHaveBeenCalled()
})

it.each(['beforeSubmitPrompt', 'preToolUse'])('checks individual %s payload limits before retention', async event => {
  const context = input(); context.event = event
  Object.assign(context.input, { prompt: 'x'.repeat(128 * 1024 + 1), tool_input: { value: 'x'.repeat(128 * 1024) } })
  await expect(createNativeNotifyCursor({ selfPid: 43 })(context)).rejects.toThrow('field limit')
  expect(deliverNativeHookClient).not.toHaveBeenCalled()
})

it('captures one original runtime and routes a single retained phase through the pinned helper', async () => {
  const row = runtime(); writeFileSync(join(root, 'registry.json'), JSON.stringify([row]), { mode: 0o600 })
  const context = input(), artifact = { schema: 1 as const, size: 32, sha256: 'a'.repeat(64), base64: 'fixture' }
  context.runtime = nativeNotifyRuntime(root, '%1')
  vi.mocked(prepareProcessImageHelper).mockResolvedValue('/fixture/native-helper')
  let finish!: () => void
  vi.mocked(deliverNativeHookClient).mockImplementation(async () => {
    await new Promise<void>(resolve => { finish = resolve })
    return { owned: true, completed: [] }
  })
  const running = createNativeNotifyCursor({ selfPid: 43, artifact })(context)
  const [delivery, deps] = vi.mocked(deliverNativeHookClient).mock.calls[0]
  context.input.generation_id = 'successor'; context.port++; context.callerPid++
  row.processIdentity.pid++; writeFileSync(join(root, 'registry.json'), JSON.stringify([row]))
  expect(delivery).toMatchObject({ id: 'fixture-native-delivery', firedAt: 1000, port: 19400,
    phases: [{ name: 'registration', path: '/api/hook/session-start', body: { generationId: 'fixture-generation', callerPid: 42 } }] })
  expect(delivery.phases).toHaveLength(1)
  await deps.captureOrigin()
  const [self, caller, budget, probe, originalRuntime] = vi.mocked(captureNativeHookClientOrigin).mock.calls[0]
  expect([self, caller]).toEqual([43, 42]); expect(originalRuntime?.processIdentity?.pid).toBe(42)
  await probe([43], budget)
  const helpers = vi.mocked(probeNativeProcessControl).mock.calls[0][4]
  expect(await helpers.prepare()).toEqual({ path: '/fixture/native-helper', key: artifact.sha256 })
  expect(prepareProcessImageHelper).toHaveBeenCalledWith(artifact, join(root, 'native-hook-client-runtime'))
  await deps.openStorage()
  expect(openNativeHookStorage).toHaveBeenCalledWith(join(root, 'native-hook-deliveries'), helpers)
  const request = { id: delivery.id, firedAt: delivery.firedAt, port: delivery.port, path: '/api/native-hook/v1/session-start', body: '{}' }
  const current = () => true
  await deps.send(request, current)
  expect(sendNativeHookRequest).toHaveBeenCalledWith(request, 'fixture-token', current, expect.any(Number))
  expect(vi.mocked(sendNativeHookRequest).mock.calls[0][3]).toBeLessThanOrEqual(4000)
  expect(deps.timeoutMs).toBeLessThan(4000)
  finish(); await running
})

it('does not renew the delivery allowance after synchronous preprocessing', async () => {
  vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValue(5100)
  await createNativeNotifyCursor({ selfPid: 43 })(input())
  expect(vi.mocked(deliverNativeHookClient).mock.calls[0][1].timeoutMs).toBe(0)
  expect(captureNativeHookClientOrigin).not.toHaveBeenCalled()
  expect(openNativeHookStorage).not.toHaveBeenCalled()
  expect(sendNativeHookRequest).not.toHaveBeenCalled()
})

it('reports unowned delivery without any legacy fallback', async () => {
  vi.mocked(deliverNativeHookClient).mockResolvedValue({ owned: false, completed: [], reason: 'fixture flush unavailable' })
  await expect(createNativeNotifyCursor({ selfPid: 43 })(input())).rejects.toThrow('fixture flush unavailable')
  expect(deliverNativeHookClient).toHaveBeenCalledOnce()
  expect(() => readFileSync(join(root, 'registry.json'))).toThrow()
})

it('reads only one private runtime, without changing registry permissions or guessing ambiguity', () => {
  const path = join(root, 'registry.json'), row = runtime()
  expect(nativeNotifyRuntime(root, '%1')).toBeUndefined()
  writeFileSync(path, JSON.stringify([row]), { mode: 0o600 })
  expect(nativeNotifyRuntime(root, '%1')).toMatchObject({ agentId: row.agentId, processIdentity: row.processIdentity })
  writeFileSync(path, JSON.stringify([row, { ...row, agentId: 'another-agent' }]))
  expect(nativeNotifyRuntime(root, '%1')).toBeUndefined()
  writeFileSync(path, JSON.stringify([row])); chmodSync(path, 0o666)
  expect(nativeNotifyRuntime(root, '%1')).toBeUndefined()
  rmSync(path); mkdirSync(path)
  expect(nativeNotifyRuntime(root, '%1')).toBeUndefined()
  rmSync(path, { recursive: true }); symlinkSync('/missing-fixture', path)
  expect(nativeNotifyRuntime(root, '%1')).toBeUndefined()
})

it('keeps delivering native evidence for a cancelled row while refusing malformed control versions', () => {
  const path = join(root, 'registry.json'), row = runtime()
  const nativeControl = { version: 1, cancel: { processKey: 'original-process', target: 'a'.repeat(64), request: {
    requestId: 'original-cancel-request', nonce: 'original-cancel-nonce', agentId: row.agentId,
    conversationId: 'fixture-conversation', frontier: { index: -1, digest: null },
  } } }
  writeFileSync(path, JSON.stringify([{ ...row, schemaVersion: 3, nativeControl }]), { mode: 0o600 })
  expect(nativeNotifyRuntime(root, '%1')?.agentId).toBe(row.agentId)
  const choice = { kind: 'native-rearm', agentId: row.agentId, operation: 'restart', source: 'live' }
  const nativeAllocation = appendNativeAllocation(undefined, { fingerprint: creationFingerprint(choice), request: {
    ...choice, creationId: 'original-creation-request', launchToken: 'original-launch-token', target: 'a'.repeat(64), sourceProcess: { processKey: null },
  } })
  writeFileSync(path, JSON.stringify([{ ...row, schemaVersion: 4, nativeControl, nativeAllocation }]))
  expect(nativeNotifyRuntime(root, '%1')?.agentId).toBe(row.agentId)
  for (const candidate of [{ ...row, nativeControl }, { ...row, schemaVersion: 3 },
    { ...row, schemaVersion: 3, nativeControl: { ...nativeControl, version: 2 } },
    { ...row, nativeAllocation }, { ...row, schemaVersion: 3, nativeControl, nativeAllocation },
    { ...row, schemaVersion: 4, nativeControl }, { ...row, schemaVersion: 4, nativeAllocation },
    { ...row, schemaVersion: 4, nativeControl, nativeAllocation, agentId: 'foreign-agent' },
    { ...row, schemaVersion: 4, nativeControl, nativeAllocation: { version: 1, receipts: [] } }]) {
    writeFileSync(path, JSON.stringify([candidate]))
    expect(nativeNotifyRuntime(root, '%1')).toBeUndefined()
  }
})

it('reads the distinct initial allocation schema without treating lost Cancel as first admission', () => {
  const path = join(root, 'registry.json'), row = runtime()
  const request = parseNativeCreateRequest({ kind: 'native-create-v2', creationId: 'initial-creation-request', agentId: row.agentId,
    launchToken: 'initial-launch-token', label: 'harness-cursor-first', local: true,
    input: { engine: 'cursor', cwd: '/fixture/project' }, selection: null })!
  const nativeAllocation = appendNativeAllocation(undefined, { request, fingerprint: nativeCreateFingerprint(request) })
  writeFileSync(path, JSON.stringify([{ ...row, schemaVersion: 5, nativeAllocation }]), { mode: 0o600 })
  expect(nativeNotifyRuntime(root, '%1')?.agentId).toBe(row.agentId)
  const choice = { kind: 'native-rearm', agentId: row.agentId, operation: 'restart', source: 'live' }
  const later = appendNativeAllocation(nativeAllocation, { fingerprint: creationFingerprint(choice), request: {
    ...choice, creationId: 'second-creation-request', launchToken: 'second-launch-token', target: 'b'.repeat(64), sourceProcess: { processKey: null },
  } })
  for (const candidate of [
    { ...row, schemaVersion: 4, nativeAllocation }, { ...row, schemaVersion: 5 },
    { ...row, schemaVersion: 5, nativeAllocation, nativeControl: {} },
    { ...row, schemaVersion: 5, nativeAllocation, agentId: 'foreign-agent' },
    { ...row, schemaVersion: 5, nativeAllocation: later },
    { ...row, schemaVersion: 5, nativeAllocation: { ...nativeAllocation, version: 1 } },
  ]) {
    writeFileSync(path, JSON.stringify([candidate]))
    expect(nativeNotifyRuntime(root, '%1')).toBeUndefined()
  }
})

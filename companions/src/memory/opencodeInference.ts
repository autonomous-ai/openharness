/** Isolated OpenCode extraction. A host-bound snapshot is required; native defaults are never guessed. */
import { execFile } from 'node:child_process'
import { lstat, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { digest } from './admission.js'
import { nativeMemoryEnvironment } from './account.js'
import { MemoryError, parse } from './types.js'
import { nativeMemoryUsage, runInferenceProcess, type MemoryInferenceOptions, type InferenceFrame } from './inferenceProcess.js'

const exec = promisify(execFile)
const bundledSdks = ['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic'] as const
function resolvedProvider(value: unknown): boolean {
  if (typeof value === 'string') return !/\{(?:env|file):|\$\{/.test(value)
  if (!value || typeof value !== 'object') return true
  return Object.entries(value).every(([key, child]) => (key !== 'npm' || bundledSdks.includes(child as typeof bundledSdks[number]))
    && resolvedProvider(child))
}
const snapshotSchema = z.object({
  model: z.string().max(200).regex(/^[a-z0-9][\w.-]*\/[\w./-]+$/i),
  variant: z.string().max(40).regex(/^[a-z][a-z0-9_-]*$/).optional(),
  // API credentials are the first supported native auth type. OAuth needs separate refresh/account certification.
  auth: z.object({ type: z.literal('api'), key: z.string().min(1).max(8_000),
    metadata: z.record(z.string().max(200), z.string().max(2_000)).optional() }).strict(),
  provider: z.object({
    name: z.string().max(200).optional(),
    // Do not let a provider snapshot load arbitrary npm packages or local executable modules.
    npm: z.enum(bundledSdks),
    options: z.record(z.string(), z.json()).optional(),
    models: z.record(z.string(), z.json()),
  }).strict().refine(resolvedProvider),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 48_000
  && Object.keys(value.provider.models).length === 1
  && Object.hasOwn(value.provider.models, value.model.slice(value.model.indexOf('/') + 1)))

/** Supplied by a native account/config observer, never by an extraction response or remembered text. */
export type OpenCodeMemorySnapshot = z.infer<typeof snapshotSchema>
export function parseOpenCodeMemorySnapshot(value: unknown): OpenCodeMemorySnapshot {
  return parse(snapshotSchema, value)
}
export interface OpenCodeMemoryInferenceOptions extends MemoryInferenceOptions {
  expectedSnapshot: string
  /** Fresh observation of the same selected runtime's provider, account, model and variant. */
  readSnapshot: () => Promise<OpenCodeMemorySnapshot | null>
}

export function openCodeSnapshotIdentity(value: OpenCodeMemorySnapshot): string {
  return digest(parse(snapshotSchema, value))
}

export async function opencodeMemoryCapability(signal?: AbortSignal): Promise<{ supported: boolean; version: string | null }> {
  try {
    const result = await exec(process.env.OPENCODE_PATH || 'opencode', ['--version'], {
      timeout: 5_000, maxBuffer: 2_000, env: nativeMemoryEnvironment(), ...(signal ? { signal } : {}),
    })
    const version = /^(\d+\.\d+\.\d+)$/.exec(result.stdout.trim())?.[1] ?? null
    return { supported: version === '1.18.34', version }
  } catch { return { supported: false, version: null } }
}

export async function runOpenCodeMemoryInference(options: OpenCodeMemoryInferenceOptions): Promise<{ text: string }> {
  if (options.signal?.aborted) throw new MemoryError('inference_cancelled')
  if (!options.model || Buffer.byteLength(options.prompt) > 120_000 || !/^[a-f0-9]{64}$/.test(options.expectedSnapshot)) throw new MemoryError('invalid_inference_input')
  await assertNoManagedConfig()
  const capability = await opencodeMemoryCapability(options.signal)
  if (options.signal?.aborted) throw new MemoryError('inference_cancelled')
  if (!capability.supported) throw new MemoryError('opencode_version_uncertified')
  const read = async (): Promise<OpenCodeMemorySnapshot> => {
    await assertNoManagedConfig()
    const raw = await options.readSnapshot()
    if (!raw) throw new MemoryError('inference_context_changed')
    const snapshot = parse(snapshotSchema, raw)
    if (snapshot.model !== options.model || digest(snapshot) !== options.expectedSnapshot) throw new MemoryError('inference_context_changed')
    return snapshot
  }
  const snapshot = await read()
  const providerId = snapshot.model.slice(0, snapshot.model.indexOf('/'))
  const config = JSON.stringify({ autoupdate: false, share: 'disabled', snapshot: false,
    model: snapshot.model, small_model: snapshot.model, enabled_providers: [providerId],
    permission: { '*': 'deny' }, plugin: [], mcp: {}, instructions: [],
    agent: { harness_memory: { mode: 'primary', description: 'Private coding memory extraction',
      prompt: 'Extract only the requested JSON from the supplied historical evidence. Do not use tools.',
      permission: { '*': 'deny' }, steps: 1 } },
    provider: { [providerId]: snapshot.provider },
  })
  // Strings are immutable snapshots. A later caller mutation cannot change credentials or routing mid-launch.
  const auth = JSON.stringify({ [providerId]: snapshot.auth })
  const directory = await mkdtemp(join(options.cwd, 'opencode-memory-'))
  try {
    for (const name of ['home', 'config', 'data', 'cache', 'state', 'work']) await mkdir(join(directory, name), { mode: 0o700 })
    const environment = { ...nativeMemoryEnvironment(), HOME: join(directory, 'home'), TMPDIR: directory,
      XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
      XDG_CACHE_HOME: join(directory, 'cache'), XDG_STATE_HOME: join(directory, 'state'),
      OPENCODE_DB: join(directory, 'opencode.db'), OPENCODE_CONFIG_CONTENT: config, OPENCODE_AUTH_CONTENT: auth,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_AUTOCOMPACT: '1',
    }
    const args = ['run', '--pure', '--format', 'json', '--model', snapshot.model, '--agent', 'harness_memory',
      '--title', 'Private coding memory', ...(snapshot.variant ? ['--variant', snapshot.variant] : [])]
    const result = await runInferenceProcess({ ...options, cwd: join(directory, 'work'), beforeRun: async () => {
      await options.beforeRun?.()
      await read()
    } }, process.env.OPENCODE_PATH || 'opencode', args, environment, openCodeMemoryDecoder())
    await read()
    return result
  } finally { await rm(directory, { recursive: true, force: true }) }
}

/** Native 1.18.34 merges system policy after inline configuration. Refuse, never bypass it. */
async function assertNoManagedConfig(): Promise<void> {
  const directory = process.platform === 'darwin' ? '/Library/Application Support/opencode'
    : process.platform === 'win32' ? join('C:\\ProgramData', 'opencode') : '/etc/opencode'
  const paths = ['opencode.json', 'opencode.jsonc'].map(name => join(directory, name))
  if (process.platform === 'darwin') {
    let username = 'user'
    try { username = userInfo().username || username } catch { /* Match the native fallback. */ }
    paths.push(join('/Library/Managed Preferences', username, 'ai.opencode.managed.plist'),
      '/Library/Managed Preferences/ai.opencode.managed.plist')
  }
  for (const path of paths) {
    try { await lstat(path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new MemoryError('opencode_managed_config_unsupported')
    }
    throw new MemoryError('opencode_managed_config_unsupported')
  }
}

/** Events observed on native 1.18.34, including rejected forced tool calls. */
function openCodeMemoryDecoder(): (event: Record<string, unknown>) => InferenceFrame {
  let started = false, completed = false, session: unknown, message: unknown
  const text = new Map<string, string>()
  return event => {
    if (event.type === 'tool_use') return { error: 'inference_tool_or_error' }
    if (event.type === 'error') return { error: providerRestricted(event.error) ? 'inference_provider_restricted'
      : /rate.?limit|quota|usage limit/i.test(JSON.stringify(event.error)) ? 'inference_usage_limit' : 'inference_unavailable' }
    const part = event.part as Record<string, unknown> | undefined
    if (!part || typeof part !== 'object' || !['step_start', 'text', 'step_finish'].includes(String(event.type))) return { error: 'inference_protocol_changed' }
    if (event.type === 'step_start') {
      if (started || completed || part.type !== 'step-start' || typeof event.sessionID !== 'string' || typeof part.messageID !== 'string') return { error: 'inference_protocol_changed' }
      started = true; session = event.sessionID; message = part.messageID
      return {}
    }
    if (!started || completed || event.sessionID !== session || part.sessionID !== session || part.messageID !== message) return { error: 'inference_protocol_changed' }
    if (event.type === 'text') {
      if (part.type !== 'text' || typeof part.id !== 'string' || typeof part.text !== 'string'
        || !part.text.startsWith(text.get(part.id) ?? '')) return { error: 'invalid_inference_output' }
      text.set(part.id, part.text)
      return { text: [...text.values()].join('') }
    }
    if (part.type !== 'step-finish' || part.reason !== 'stop') return { error: 'inference_tool_or_error' }
    completed = true
    const tokens = part.tokens as Record<string, unknown> | undefined
    const cache = tokens?.cache as Record<string, unknown> | undefined
    return { completed: true, observation: {
      usage: nativeMemoryUsage({ input_tokens: tokens?.input, output_tokens: tokens?.output,
        cache_read_input_tokens: cache?.read, cache_creation_input_tokens: cache?.write }),
      ...(typeof part.cost === 'number' && Number.isFinite(part.cost) && part.cost >= 0 ? { reportedCostUsd: part.cost } : {}),
    } }
  }
}

// Match the recorded non-retryable policy refusal only. An arbitrary 403, free-tier error,
// or quoted message must not permanently disable learning for this connection.
const restrictionSchema = z.object({ name: z.literal('APIError'), data: z.object({
  statusCode: z.literal(403), isRetryable: z.literal(false), responseBody: z.string().max(64_000),
}) })
function providerRestricted(error: unknown): boolean {
  const result = restrictionSchema.safeParse(error)
  if (!result.success) return false
  try {
    const body = JSON.parse(result.data.data.responseBody)
    return body?.type === 'error' && body?.error?.type === 'FreeTierError'
      && body.error.message === "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"
  } catch { return false }
}

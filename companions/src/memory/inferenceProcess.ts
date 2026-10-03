import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { OneShotOptions } from '../../../cli/src/lib/oneshot.js'
import { MemoryError } from './types.js'

export interface MemoryInferenceObservation {
  /** Native CLI report; an init event alone does not prove the provider executed this model. */
  model?: string
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
  reportedCostUsd?: number
}
export interface MemoryInferenceOptions extends OneShotOptions {
  /** Recheck asynchronous native account metadata after the version probe, before spawning. */
  beforeRun?: () => Promise<void>
  /** Final synchronous owner/runtime check; no await separates it from process launch. */
  assertAuthorized?: () => void
  /** Optional diagnostic observer. Never receives source text, reasoning, credentials or raw events. */
  observe?: (observation: MemoryInferenceObservation) => void | Promise<void>
}
export interface InferenceFrame { text?: string; completed?: boolean; error?: string; observation?: MemoryInferenceObservation }

/** Only native usage counters; unknown/missing readings stay unknown, never a fabricated zero. */
export function nativeMemoryUsage(value: unknown): MemoryInferenceObservation['usage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!count(raw.input_tokens) || !count(raw.output_tokens)) return undefined
  return { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens,
    ...(count(raw.cache_read_input_tokens ?? raw.cached_input_tokens) ? { cacheReadInputTokens: (raw.cache_read_input_tokens ?? raw.cached_input_tokens) as number } : {}),
    ...(count(raw.cache_creation_input_tokens) ? { cacheCreationInputTokens: raw.cache_creation_input_tokens } : {}) }
}

/** Bounded JSONL process transport shared by the two certified native adapters. */
export async function runInferenceProcess(options: MemoryInferenceOptions, command: string, args: string[], env: NodeJS.ProcessEnv,
  decode: (event: Record<string, unknown>) => InferenceFrame): Promise<{ text: string }> {
  if (options.signal?.aborted) throw new MemoryError('inference_cancelled')
  if (options.beforeRun) await options.beforeRun()
  if (options.signal?.aborted) throw new MemoryError('inference_cancelled')
  options.assertAuthorized?.()
  if (!options.model || Buffer.byteLength(options.prompt) > 120_000) throw new MemoryError('invalid_inference_input')
  const child = spawn(command, args, { cwd: options.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let pending = true
    let buffer = '', stderr = '', answer = '', totalBytes = 0
    let completed = false
    const decoder = new StringDecoder('utf8')
    const kill = (): void => {
      if (child.pid == null || child.exitCode !== null) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }
    const settle = (error?: string): void => {
      if (!pending) return
      pending = false
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) { kill(); reject(new MemoryError(error)) }
      else resolve({ text: answer })
    }
    const abort = (): void => settle('inference_cancelled')
    const timer = setTimeout(() => settle('inference_timeout'), Math.max(1, Math.min(options.timeoutMs ?? 90_000, 90_000)))
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const line = (text: string): void => {
      if (!pending || !text.trim()) return
      try {
        const event: unknown = JSON.parse(text)
        if (!event || typeof event !== 'object' || Array.isArray(event)) { settle('invalid_inference_output'); return }
        const frame = decode(event as Record<string, unknown>)
        if (frame.error) { settle(frame.error); return }
        if (frame.observation) {
          try { void Promise.resolve(options.observe?.(frame.observation)).catch(() => {}) }
          catch { /* A diagnostic sink cannot change extraction. */ }
        }
        if (frame.text !== undefined) {
          if (typeof frame.text !== 'string') { settle('invalid_inference_output'); return }
          answer = frame.text
        }
        if (frame.completed) completed = true
      } catch { settle('invalid_inference_output') }
    }
    child.stdout.on('data', chunk => {
      if (!pending) return
      totalBytes += Buffer.byteLength(chunk)
      buffer += decoder.write(chunk)
      if (totalBytes > 1_000_000 || Buffer.byteLength(buffer) > 300_000) { settle('inference_output_too_large'); return }
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const text of lines) line(text)
    })
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(0, 8_000) })
    child.stdin.on('error', () => settle('inference_unavailable'))
    child.on('error', () => settle('inference_unavailable'))
    child.on('close', code => {
      buffer += decoder.end()
      if (buffer) line(buffer)
      if (code !== 0 || !completed || !answer) settle(/rate.?limit|quota|usage limit/i.test(stderr) ? 'inference_usage_limit' : 'inference_unavailable')
      else if (Buffer.byteLength(answer) > 280_000) settle('inference_output_too_large')
      else settle()
    })
    child.stdin.end(options.prompt)
  })
}

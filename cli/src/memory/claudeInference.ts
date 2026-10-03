/** Fresh, bounded Claude extraction. No reuse of a worker created under an older login. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nativeMemoryEnvironment } from './account.js'
import { MemoryError } from './types.js'
import { nativeMemoryUsage, runInferenceProcess, type MemoryInferenceOptions } from './inferenceProcess.js'

const exec = promisify(execFile)
const CERTIFIED_CLAUDE_VERSIONS = new Set(['2.1.285', '2.1.286', '2.1.287'])
export async function claudeMemoryCapability(signal?: AbortSignal): Promise<{ supported: boolean; version: string | null }> {
  try {
    const result = await exec(process.env.CLAUDE_PATH || 'claude', ['--version'], { timeout: 5_000, maxBuffer: 2_000,
      env: nativeMemoryEnvironment(), ...(signal ? { signal } : {}) })
    const version = /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(result.stdout.trim())?.[1] ?? null
    return { supported: !!version && CERTIFIED_CLAUDE_VERSIONS.has(version), version }
  } catch { return { supported: false, version: null } }
}

export async function runClaudeMemoryInference(options: MemoryInferenceOptions): Promise<{ text: string }> {
  if (options.signal?.aborted) throw new MemoryError('inference_cancelled')
  const capability = await claudeMemoryCapability(options.signal)
  if (options.signal?.aborted) throw new MemoryError('inference_cancelled')
  if (!capability.supported) throw new MemoryError('claude_version_uncertified')
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--no-session-persistence', '--safe-mode',
    '--disable-slash-commands', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--model', options.model ?? '', ...(options.effort ? ['--effort', options.effort] : [])]
  // The native subscription is selected before invocation. Custom-provider/env-token routes are
  // unavailable in the account adapter, rather than silently falling back to another credential.
  const env: NodeJS.ProcessEnv = { ...nativeMemoryEnvironment(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  return runInferenceProcess(options, process.env.CLAUDE_PATH || 'claude', args, env, event => {
    if (event.type === 'system') {
      if (event.subtype === 'init' && (!Array.isArray(event.tools) || event.tools.length)) return { error: 'inference_tool_or_error' }
      if (typeof event.subtype === 'string' && event.subtype.startsWith('hook_')) return { error: 'inference_tool_or_error' }
      if (event.subtype === 'init' && typeof event.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/@+\[\]-]{0,199}$/.test(event.model)) {
        return { observation: { model: event.model } }
      }
      return {}
    }
    if (event.type === 'assistant') {
      if (event.error) return { error: event.error === 'rate_limit' ? 'inference_usage_limit' : 'inference_unavailable' }
      const content = (event.message as { content?: Array<{ type?: string }> } | undefined)?.content
      return !Array.isArray(content) || content.some(part => !['text', 'thinking', 'redacted_thinking'].includes(part.type ?? ''))
        ? { error: 'inference_tool_or_error' } : {}
    }
    if (event.type === 'result') {
      if (event.is_error || event.subtype !== 'success') return { error: /rate.?limit|quota|usage limit|hit.{0,20}limit|limit reached/i.test(JSON.stringify([event.errors, event.result]))
        ? 'inference_usage_limit' : 'inference_unavailable' }
      return typeof event.result === 'string' ? { text: event.result, completed: true,
        observation: { usage: nativeMemoryUsage(event.usage),
          ...(typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0
            ? { reportedCostUsd: event.total_cost_usd } : {}) } } : { error: 'invalid_inference_output' }
    }
    if (event.type === 'rate_limit_event') return {
      ...((event.rate_limit_info as { status?: string } | undefined)?.status === 'rejected' ? { error: 'inference_usage_limit' } : {}),
    }
    return { error: 'inference_protocol_changed' }
  })
}

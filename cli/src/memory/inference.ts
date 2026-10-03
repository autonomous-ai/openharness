/** Restricted extraction through the selected native CLI, with no alternate model/account. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { memoryCodexHome, nativeMemoryEnvironment } from './account.js'
import { MemoryError } from './types.js'
import { nativeMemoryUsage, runInferenceProcess, type MemoryInferenceOptions } from './inferenceProcess.js'

const exec = promisify(execFile)
// Certified with a local mock Responses endpoint. New releases require recertification of the tool catalog.
const CERTIFIED_CODEX_VERSIONS = new Set(['0.159.0'])
export const CODEX_MEMORY_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'in_app_browser', 'multi_agent', 'hooks', 'plugins',
  'remote_plugin', 'view_image', 'code_mode_host', 'tool_suggest', 'workspace_dependencies', 'skill_search', 'sleep_tool',
  'goals', 'memories', 'shell_snapshot', 'enable_request_compression', 'daemon_auto_start'] as const

export async function codexMemoryCapability(signal?: AbortSignal): Promise<{ supported: boolean; version: string | null }> {
  try {
    const result = await exec(process.env.CODEX_PATH || 'codex', ['--version'], {
      timeout: 5_000, maxBuffer: 2_000, env: nativeMemoryEnvironment(), ...(signal ? { signal } : {}),
    })
    const version = /^(?:codex-cli|codex) (\d+\.\d+\.\d+)\s*$/.exec(result.stdout.trim())?.[1] ?? null
    return { supported: !!version && CERTIFIED_CODEX_VERSIONS.has(version), version }
  } catch { return { supported: false, version: null } }
}

/** The remaining request_user_input tool is unusable in exec mode; any error/tool item rejects this run. */
export async function runCodexMemoryInference(options: MemoryInferenceOptions): Promise<{ text: string }> {
  if (options.signal?.aborted) throw new MemoryError('inference_cancelled')
  const capability = await codexMemoryCapability(options.signal)
  if (options.signal?.aborted) throw new MemoryError('inference_cancelled')
  if (!capability.supported) throw new MemoryError('codex_version_uncertified')
  if (!options.model || Buffer.byteLength(options.prompt) > 120_000) throw new MemoryError('invalid_inference_input')
  const args = ['exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
    '--ignore-user-config', '--ignore-rules', '--model', options.model,
    '-c', 'web_search="disabled"', ...CODEX_MEMORY_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
    ...(options.effort ? ['-c', `model_reasoning_effort="${options.effort}"`] : []), '-']
  const codexHome = memoryCodexHome(options.codexHome)
  if (!codexHome) throw new MemoryError('inference_unavailable')
  const childEnv = { ...nativeMemoryEnvironment(), CODEX_HOME: codexHome }
  return runInferenceProcess(options, process.env.CODEX_PATH || 'codex', args, childEnv, event => {
    const item = event.item as { type?: string; text?: string } | undefined
    if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      if (!['agent_message', 'reasoning'].includes(item?.type ?? '')) return { error: 'inference_tool_or_error' }
      if (event.type === 'item.completed' && item?.type === 'agent_message') return { text: item.text ?? '' }
    } else if (event.type === 'turn.completed') return { completed: true, observation: { usage: nativeMemoryUsage(event.usage) } }
    else if (event.type === 'error' || event.type === 'turn.failed') return { error: 'inference_unavailable' }
    else if (!['thread.started', 'turn.started'].includes(String(event.type))) return { error: 'inference_protocol_changed' }
    return {}
  })
}

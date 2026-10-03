import type { AgentEngine } from '../engines/types.js'

export const DEFAULT_HARNESS_ENGINE = 'opencode' as const
export const DEFAULT_HARNESS_MODEL = 'opencode/muse-spark-1.3-contributor-free'
export const DEFAULT_HARNESS_EFFORT = 'xhigh'
export const DEFAULT_HARNESS_PERMISSION = 'auto'

function opencodePermission(config: Record<string, any>, permissionMode: string) {
  return permissionMode === 'ask' ? 'ask'
    : typeof config.permission === 'object' && config.permission !== null
      ? { '*': 'allow', ...config.permission } : 'allow'
}

/** Apply an explicit permission change without replacing the conversation's model or tools. */
export function harnessPermissionEnvironment(engine: AgentEngine, env: Record<string, string>, permissionMode: string): Record<string, string> {
  if (engine !== 'opencode') return env
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}')
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission: opencodePermission(config, permissionMode) }) }
}

/** Fresh own-provider launches only. Restores and explicit model routes keep their choices. */
export function freshHarnessEnvironment(engine: AgentEngine, env: Record<string, string> = {},
  explicitRoute = false, permissionMode = DEFAULT_HARNESS_PERMISSION): Record<string, string> {
  if (engine !== DEFAULT_HARNESS_ENGINE || explicitRoute) return env
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}')
  const modelId = DEFAULT_HARNESS_MODEL.split('/')[1]!
  const provider = config.provider?.opencode ?? {}
  const model = provider.models?.[modelId] ?? {}
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({
    ...config,
    permission: opencodePermission(config, permissionMode),
    model: DEFAULT_HARNESS_MODEL,
    small_model: DEFAULT_HARNESS_MODEL,
    provider: { ...config.provider, opencode: { ...provider, models: {
      ...provider.models,
      [modelId]: { ...model, options: { ...model.options, reasoningEffort: DEFAULT_HARNESS_EFFORT } },
    } } },
    agent: { ...config.agent,
      build: { ...config.agent?.build, model: DEFAULT_HARNESS_MODEL, variant: DEFAULT_HARNESS_EFFORT },
      plan: { ...config.agent?.plan, model: DEFAULT_HARNESS_MODEL, variant: DEFAULT_HARNESS_EFFORT },
    },
  }) }
}

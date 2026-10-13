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

/**
 * A chosen grid names its model in the file it writes (`OPENCODE_CONFIG`, lib/gridLaunch.ts), and OpenCode
 * lets inline config outrank that file: a package's own model there would run instead of the person's grid.
 */
function withoutPackageModel(env: Record<string, string>): Record<string, string> {
  if (!env.OPENCODE_CONFIG_CONTENT) return env
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT)
  if (config.model === undefined && config.small_model === undefined) return env
  delete config.model
  delete config.small_model
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
}

/** Fresh own-provider launches only. Restores, explicit model routes and a package's own model keep their choices. */
export function freshHarnessEnvironment(engine: AgentEngine, env: Record<string, string> = {},
  explicitRoute = false, permissionMode = DEFAULT_HARNESS_PERMISSION): Record<string, string> {
  if (engine !== DEFAULT_HARNESS_ENGINE) return env
  if (explicitRoute) return withoutPackageModel(env)
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}')
  // A package that names its own model keeps it. Memories reads a person's whole message history, so it
  // pins a free model whose provider keeps nothing and trains on nothing (store/agents/memories/harness.json)
  // rather than the default above, whose terms let its maker train on what it is sent.
  if (typeof config.model === 'string' && config.model) {
    return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission: opencodePermission(config, permissionMode) }) }
  }
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

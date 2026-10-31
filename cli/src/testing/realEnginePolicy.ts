import { isAbsolute, join } from 'node:path'

export type RealEngine = 'claude' | 'codex'
export type RealEnginePlan = { engines: RealEngine[]; models: Partial<Record<RealEngine, string>> }

/** Found by QA on a quiet machine: fakes missed native records. Live probes need an explicit,
 * separate boundary so an ordinary test run cannot spend inference quota or read a person's homes. */
export function realEnginePlan(env: NodeJS.ProcessEnv): RealEnginePlan {
  if (env.REAL_ENGINES !== '1') throw new Error('Real-engine tests require REAL_ENGINES=1')
  if (['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'TF_BUILD', 'GITLAB_CI', 'JENKINS_URL']
    .some((key) => env[key] && !['0', 'false'].includes(env[key]!.toLowerCase()))) {
    throw new Error('The real-engine suite never runs in CI')
  }
  const selected = env.REAL_ENGINE ?? 'all'
  if (!['all', 'claude', 'codex'].includes(selected)) throw new Error('REAL_ENGINE must be claude, codex or all')
  const engines: RealEngine[] = selected === 'all' ? ['claude', 'codex'] : [selected as RealEngine]
  const models: RealEnginePlan['models'] = {}
  for (const engine of engines) {
    if (engine === 'claude' && !env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) throw new Error('Missing CLAUDE_CODE_OAUTH_TOKEN')
    if (engine === 'codex' && !(env.CODEX_API_KEY || env.OPENAI_API_KEY)?.trim()) throw new Error('Missing CODEX_API_KEY or OPENAI_API_KEY')
    const key = `REAL_${engine.toUpperCase()}_MODEL`
    const model = env[key]
    if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) throw new Error(`Pin a model with ${key}`)
    models[engine] = model
  }
  return { engines, models }
}

export const REAL_ENGINE_FOLDERS = {
  HOME: 'home', ZDOTDIR: 'home', TMPDIR: 'tmp', TMUX_TMPDIR: 'tmux',
  CLAUDE_CONFIG_DIR: 'claude', CODEX_HOME: 'codex',
  XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'share', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state',
  ADAPTER_DATA_DIR: 'data', ADAPTER_RUNTIME_DIR: 'runtime', HARNESS_AUTH_DIR: 'auth', DSH_DIR: 'dsh',
  npm_config_cache: 'npm-cache',
} as const

/** An allowlist, not a list of credentials we happened to know about when this was written. */
export function realEngineEnvironment(inherited: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const plan = realEnginePlan(inherited)
  if (!isAbsolute(root)) throw new Error('The real-engine run root must be absolute')
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM']) if (inherited[key]) env[key] = inherited[key]
  for (const [key, folder] of Object.entries(REAL_ENGINE_FOLDERS)) env[key] = join(root, folder)
  Object.assign(env, {
    SHELL: '/bin/sh', REAL_ENGINES: '1', REAL_ENGINE: inherited.REAL_ENGINE ?? 'all',
    E2E_BUNDLE: '1', NO_COLOR: '1', DISABLE_AUTOUPDATER: '1', DISABLE_AUTO_UPDATE: 'true',
    DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    HARNESS_STORE_CATALOG_URL: 'http://127.0.0.1:9',
  })
  for (const engine of plan.engines) env[`REAL_${engine.toUpperCase()}_MODEL`] = plan.models[engine]
  if (plan.engines.includes('claude')) env.CLAUDE_CODE_OAUTH_TOKEN = inherited.CLAUDE_CODE_OAUTH_TOKEN
  // An explicit env_key works for the interactive provider too; CODEX_API_KEY alone is an exec override.
  if (plan.engines.includes('codex')) env.OPENAI_API_KEY = inherited.CODEX_API_KEY || inherited.OPENAI_API_KEY
  return env
}

/** Apply to complete buffered output, so a secret split across stdout chunks is still removed. */
export function redactRealEngineOutput(text: string, env: NodeJS.ProcessEnv, root: string): string {
  for (const secret of [env.CLAUDE_CODE_OAUTH_TOKEN, env.CODEX_API_KEY, env.OPENAI_API_KEY]
    .filter((value): value is string => !!value).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[redacted]')
  }
  return text.split(root).join('<run>')
    .replace(/\/(?:Users|home)\/[^/\s"'<>]+/g, '<home>')
    .replace(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<email>')
}

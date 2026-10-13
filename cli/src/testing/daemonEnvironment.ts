import { isAgentSessionVariable } from '../lib/agentSessionEnv.js'

/**
 * A test daemon starts its own supervisor; it must not inherit the host daemon's topology or token, nor the session of
 * an agent running the tests: its harnesses would all look like that agent (agentClient/model.ts `outsideCaller`), and
 * only on the developer's machine, never in CI.
 */
export function daemonEnvironment(inherited: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => !key.startsWith('HARNESSD_') && !isAgentSessionVariable(key)))
  return { ...clean, ...own }
}

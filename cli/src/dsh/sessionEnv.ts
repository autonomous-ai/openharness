/** Inert session contract. Package parsing and expansion belong to the Store. */
export const DSH_SESSION_ENV = ['HARNESS_DSH', 'HARNESS_DSH_DIR', 'HARNESS_WORKSPACE', 'HARNESS_CONTEXT_FILE', 'HARNESS_SKILLS_DIR', 'HARNESS_PRIVATE_GRID'] as const

/** A new session cannot inherit another session's package or account facts. */
export function harnessEnvToClear(launchEnv: Record<string, string> = {}): string[] {
  return DSH_SESSION_ENV.filter(name => !Object.hasOwn(launchEnv, name))
}

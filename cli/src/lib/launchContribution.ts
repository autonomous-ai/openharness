/** Bounds shared by contributions to the existing pane launcher; no service can enlarge that authority. */
export const LAUNCH_CONTRIBUTION_LIMITS = { bytes: 1024 * 1024, textBytes: 64 * 1024, environment: 256, arguments: 1024 } as const

export const launchRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function launchText(value: unknown, maxBytes: number = LAUNCH_CONTRIBUTION_LIMITS.textBytes): value is string {
  return typeof value === 'string' && value.length <= maxBytes && !value.includes('\0') && Buffer.byteLength(value) <= maxBytes
}

/** Copies only accepted fields. Inline service code cannot change admitted argv or env after this returns. */
export function launchContributionIn(value: unknown): { env: Record<string, string>; args: string[] } | null {
  if (!launchRecord(value) || !launchRecord(value.env) || !Array.isArray(value.args)
    || value.args.length > LAUNCH_CONTRIBUTION_LIMITS.arguments) return null
  const env: Record<string, string> = {}, args: string[] = []
  let count = 0, bytes = 0
  for (const name in value.env) {
    if (!Object.hasOwn(value.env, name)) return null
    if (++count > LAUNCH_CONTRIBUTION_LIMITS.environment || name.length > 256 || !/^[A-Z_][A-Z0-9_]*$/.test(name)) return null
    const item = value.env[name]
    if (!launchText(item)) return null
    bytes += name.length + Buffer.byteLength(item)
    if (bytes > LAUNCH_CONTRIBUTION_LIMITS.bytes) return null
    env[name] = item
  }
  for (const item of value.args) {
    if (!launchText(item)) return null
    bytes += Buffer.byteLength(item)
    if (bytes > LAUNCH_CONTRIBUTION_LIMITS.bytes) return null
    args.push(item)
  }
  return { env, args }
}

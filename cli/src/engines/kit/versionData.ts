/** Declared version parsing and executable snapshot shape; no process work. */
export interface VersionRule { output: RegExp; args: readonly string[]; timeoutMs: number }
export interface VersionProbe { identity(): string | null; read(): string | Promise<string> }
export interface NativeVersionProbe extends VersionProbe { command(): string | null }
export interface NativeExecutableSnapshot {
  command: string
  identity: string
  current(): boolean
}

/** Retain the file used by the probe through later preparation and dispatch. */
export function executableSnapshot(probe: NativeVersionProbe): NativeExecutableSnapshot | null {
  const command = probe.command(), identity = probe.identity()
  return command && identity ? { command, identity, current: () => probe.identity() === identity } : null
}

export function parseMajor(rule: VersionRule, output: string): number | null {
  const match = rule.output.exec(output)
  return match ? Number(match[1]) : null
}

export type Release = readonly [number, number, number]

export function parseRelease(rule: VersionRule, output: string): Release | null {
  const match = rule.output.exec(output)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function releaseAtLeast(release: Release, floor: Release): boolean {
  for (let part = 0; part < 3; part++) if (release[part] !== floor[part]) return release[part]! > floor[part]!
  return true
}

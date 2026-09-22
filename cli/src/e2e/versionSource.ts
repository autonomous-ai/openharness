/**
 * Version sources for the E2E trigger.
 *
 * The trigger runs a matrix run when the INSTALLED (current) version of a coding-agent tool
 * differs from the tool's LATEST released version. "Latest" is read through a pluggable
 * `VersionSource` so we can develop/test offline against a MOCK (no network, $0), then swap in a
 * real implementation without changing the trigger logic.
 */
import type { AgentEngine } from '../engines/types.js'

export interface VersionSource {
  /** The latest released version string for `engine`, or null when it cannot be determined. */
  latestVersion(engine: AgentEngine): Promise<string | null>
}

/** Fixture "latest" versions, keyed by engine. Defaults make the offline trigger readable. */
const MOCK_LATEST: Partial<Record<AgentEngine, string>> = {
  codex: '0.156.0',
  claude: '2.1.279',
}

/**
 * Offline source used during development and in CI. Lets the whole trigger + matrix decision run
 * with no network and no accounts. Point at fixtures in a spec to exercise each branch.
 */
export class MockVersionSource implements VersionSource {
  constructor(private readonly overrides: Partial<Record<AgentEngine, string>> = {}) {}

  async latestVersion(engine: AgentEngine): Promise<string | null> {
    return this.overrides[engine] ?? MOCK_LATEST[engine] ?? null
  }
}

/**
 * Real source: the npm registry `latest` dist-tag for the package that ships each engine.
 * The engine's own release feed is the source of truth; npm `latest` is the fastest stable signal
 * many of them publish (`@openai/codex`, `@anthropic-ai/claude-code`).
 *
 * This is the piece we "learn how to read from which API" — switched on by
 * `E2E_VERSION_SOURCE=npm` once it is validated.
 */
import { NPM_PACKAGE } from './npmPackages.js'

export class NpmVersionSource implements VersionSource {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async latestVersion(engine: AgentEngine): Promise<string | null> {
    const pkg = NPM_PACKAGE[engine]
    if (!pkg) return null
    try {
      const res = await this.fetchImpl(`https://registry.npmjs.org/${pkg}/latest`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
      })
      if (!res.ok) return null
      const body = (await res.json()) as { version?: string }
      return body.version ?? null
    } catch {
      return null
    }
  }
}

/** Pick the source from `E2E_VERSION_SOURCE` (default `mock` until the real one is validated). */
export function versionSourceFromEnv(env: Record<string, string | undefined> = process.env): VersionSource {
  return env.E2E_VERSION_SOURCE === 'npm' ? new NpmVersionSource() : new MockVersionSource()
}

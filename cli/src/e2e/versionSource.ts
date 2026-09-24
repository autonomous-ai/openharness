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
 * Real source: each engine's STABLE release channel on npm — and only that.
 *
 * "Stable" is not the same dist-tag everywhere, which is why this is a table rather than `/latest`
 * for all (dist-tags read 2026-09-24):
 *
 *   @openai/codex              latest 0.156.1  ← stable      alpha 0.158.0-alpha.8 (pre-releases)
 *   @anthropic-ai/claude-code  stable 2.1.273  ← stable      latest/next 2.1.281 (the fast channel)
 *
 * Reading `latest` for claude tested its fast channel, eight releases ahead of what Claude Code
 * itself calls stable. And a version with a pre-release suffix (`-alpha.8`, `-beta.1`, `-rc.2`) is
 * refused whatever tag it came from: a pipeline that must never test a nightly should not depend on
 * a vendor never mis-tagging one.
 */
import { NPM_PACKAGE } from './npmPackages.js'

export const STABLE_TAG: Partial<Record<AgentEngine, string>> = { codex: 'latest', claude: 'stable' }

/** `0.156.1` yes; `0.158.0-alpha.8`, `2.1.0-beta` no. */
export function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

export class NpmVersionSource implements VersionSource {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async latestVersion(engine: AgentEngine): Promise<string | null> {
    const pkg = NPM_PACKAGE[engine]
    if (!pkg) return null
    try {
      // No `Accept: application/vnd.npm.install-v1+json` here, however natural it looks: the
      // abbreviated-metadata type is offered for the PACKAGE document, and asking for it on the
      // `/latest` dist-tag endpoint gets a 406 with an empty body. That failure is silent — the
      // catch below turns it into `latest=null`, which the trigger reads as "nothing new", so the
      // whole pipeline would sit quiet forever while looking perfectly healthy. Measured:
      //   curl -o /dev/null -w '%{http_code}' -H 'Accept: application/vnd.npm.install-v1+json' \
      //     https://registry.npmjs.org/@openai/codex/latest   -> 406
      //   curl -s https://registry.npmjs.org/@openai/codex/latest | jq .version -> "0.156.1"
      const res = await this.fetchImpl(`https://registry.npmjs.org/${pkg}/${STABLE_TAG[engine] ?? 'latest'}`)
      if (!res.ok) return null
      const body = (await res.json()) as { version?: string }
      return body.version && isStableVersion(body.version) ? body.version : null
    } catch {
      return null
    }
  }
}

/** Pick the source from `E2E_VERSION_SOURCE` (default `mock` until the real one is validated). */
export function versionSourceFromEnv(env: Record<string, string | undefined> = process.env): VersionSource {
  return env.E2E_VERSION_SOURCE === 'npm' ? new NpmVersionSource() : new MockVersionSource()
}

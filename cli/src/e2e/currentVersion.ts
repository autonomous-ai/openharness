/**
 * current version provider — reads the INSTALLED version of each coding-agent tool on the server.
 * The harness already captures this as `cli_version` on a registered agent; here we read it from
 * each binary's `--version` for the trigger to compare against latest.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentEngine } from '../engines/types.js'
import type { VersionProvider } from './trigger.js'

const execFileP = promisify(execFile)

/** How to ask each engine binary its version. */
const VERSION_COMMAND: Partial<Record<AgentEngine, string[]>> = {
  codex: ['--version'],
  claude: ['--version'],
}

/** Nice display names for logs/notifies. */
export const ENGINE_BIN: Partial<Record<AgentEngine, string>> = {
  codex: 'codex',
  claude: 'claude',
}

/** Extract the dotted version from a `--version` string like `codex-cli 0.155.0` / `2.0.34`. */
export function parseVersionLine(line: string): string | null {
  const m = line.match(/\b\d+\.\d+(?:\.\d+)*\b/)
  return m ? m[0] : null
}

/** Reads installed versions from the real binaries on PATH. */
export class InstalledCurrentVersion implements VersionProvider {
  constructor(private readonly bin: Partial<Record<AgentEngine, string>> = ENGINE_BIN) {}

  async currentVersion(engine: AgentEngine): Promise<string | null> {
    const argv = VERSION_COMMAND[engine]
    const binary = this.bin[engine]
    if (!argv || !binary) return null
    try {
      const { stdout } = await execFileP(binary, argv, { timeout: 10_000 })
      return parseVersionLine(stdout) ?? null
    } catch {
      return null
    }
  }
}

/**
 * What the core knows of OpenCode without loading its code: declared data, read in line where a launch is built
 * (docs/design/2026-10-08-other-engines-out-of-core.md). It imports nothing of OpenCode's code.
 */

/** The first major whose TUI rejects `-m` / `--agent` and whose sessions live behind its API. */
const OPENCODE_V2_MAJOR = 2

/** Whether a major version (`engines/opencode/version.ts` reads it) is v2 or later; unknown reads as v1. */
export function isOpencodeV2(major: number | null | undefined): boolean {
  return (major ?? 0) >= OPENCODE_V2_MAJOR
}

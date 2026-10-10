/**
 * Refuses a test run that has no throwaway home and data folder.
 *
 * `vitest.setup.ts` gives every spec its own home, data, runtime and auth folders, but only when Vitest
 * runs from `cli/`, where its config is. Run from the repository root it finds no config, skips the setup,
 * and every spec reads and writes the developer's real `~/.harness`, `~/.claude` and `~/.codex`. The
 * 2026-10-10 audit found 19 of `stopAgentService.spec.ts`'s fixtures (pid 77, session `saved`, folder
 * `/tmp`) in one Mac's live `stopped-agents/`, listed in its Cmd-P as stopped harnesses.
 *
 * `env.ts` imports this first, before anything resolves or moves a folder under the home.
 */
export const TEST_ISOLATED = 'HARNESS_TEST_ISOLATED'

export function assertTestIsolation(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.VITEST || env[TEST_ISOLATED] === '1') return
  throw new Error('This test run has no isolated home or data folder, so it would use the real ~/.harness. '
    + 'Run the CLI tests from cli/ (npm test, or npx vitest there).')
}

assertTestIsolation()

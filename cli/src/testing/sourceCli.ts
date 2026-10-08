/**
 * Launch scripts that install a missing agent run this CLI (`harness agents install`, by
 * lib/cliEntry.ts's command). A daemon names the cli.js it runs from; a spec runs the sources, through
 * tsx as cliCommand.spec.ts does, so a pane script it builds reaches the code under test.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setHarnessCliCommand } from '../lib/cliEntry.js'

export const CLI_ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const TSX_CLI = join(CLI_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
export const CLI_SOURCE = join(CLI_ROOT, 'src', 'cli.ts')

/** The command a launch script runs this CLI by: the sources, through tsx. */
export const SOURCE_CLI_COMMAND: readonly string[] = [process.execPath, TSX_CLI, CLI_SOURCE]

export function useSourceCli(): void {
  setHarnessCliCommand(SOURCE_CLI_COMMAND)
}

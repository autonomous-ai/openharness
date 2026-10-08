/**
 * How a pane runs this CLI: `<node> <cli.js>`, both absolute, so that the shell of a pane, which may
 * have neither on its PATH (the managed runtime never is), reaches the same build as the daemon that
 * wrote its script. The pane's install-if-missing runs `harness agents install` this way
 * (engineLaunch.ts `installIfMissingScript`).
 *
 * Set by whoever knows the script: the core when it starts (core/main.ts `runCore`, from the cli.js it
 * was started on even when its own code is the lean bundle's) and the CLI itself (cli.ts, for
 * `harness shell-launch`). Unset, the installed copy under ~/.harness/cli.
 */
import { join } from 'node:path'
import { env } from '../config/env.js'
import { baseNode } from '../harnessd/baseNode.js'

let command: readonly string[] | null = null

/** [script] is cli.js, or src/cli.ts from the sources, which needs this process's loader flags (tsx). */
export function setHarnessCliScript(script: string): void {
  command = [baseNode(process.execPath), ...(script.endsWith('.ts') ? process.execArgv : []), script]
}

/** For a test that runs the sources through its own loader. */
export function setHarnessCliCommand(argv: readonly string[]): void {
  command = [...argv]
}

export function harnessCliCommand(): readonly string[] {
  return command ?? [baseNode(process.execPath), join(env.ADAPTER_CLI_DIR, 'cli.js')]
}

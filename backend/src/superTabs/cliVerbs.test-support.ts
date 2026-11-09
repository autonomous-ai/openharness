import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The CLI's `harness super-tab` command, whose usage line lists its verbs. */
export const CLI_COMMAND = fileURLToPath(new URL('../../../cli/src/superTabs/command.ts', import.meta.url))

/** The verbs of `harness super-tab` in the CLI today, read from its usage line (cli/src/superTabs/command.ts USAGE), so this list
 *  follows the CLI: `harness super-tab [--tab ID] ... status [...] | messages GROUP ... | message ...`, each verb the first word of
 *  its alternative. A notice or an answer the Swarm writes for an agent names only these: an agent that runs a verb the CLI no
 *  longer has is refused and loses its turn. */
export function superTabVerbs(source = readFileSync(CLI_COMMAND, 'utf8')): string[] {
  const usage = /^const USAGE = '([^']+)'$/m.exec(source)?.[1]
  if (!usage) throw new Error(`No usage line in ${CLI_COMMAND}`)
  return usage.replace(/^harness super-tab(?: \[[^\]]*\])*/, '').split(' | ').map(part => /^\s*([a-z][a-z-]*)/.exec(part)?.[1] ?? '')
}

/** The `harness super-tab` verbs [text] names that [verbs] lacks, each once. The options the command takes before its verb
 *  (`--tab ID`, `--agent ID`, `--port N`, `--machine ID`, also as `--tab=ID`) are skipped, and so is a line break. */
export function missingVerbs(text: string, verbs: readonly string[] = superTabVerbs()): string[] {
  const named = [...text.matchAll(/harness\s+super-tab(?:\s+--(?:tab|agent|port|machine)(?:=\S+|\s+\S+))*\s+([a-z][a-z-]*)/g)].map(match => match[1]!)
  return [...new Set(named.filter(verb => !verbs.includes(verb)))]
}

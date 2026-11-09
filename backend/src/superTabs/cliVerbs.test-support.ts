/** The verbs of `harness super-tab` in the CLI today, as its usage line lists them (cli/src/superTabs/command.ts USAGE). A notice or an
 *  answer the Swarm writes for an agent names only these: an agent that runs a verb the CLI no longer has is refused and loses its
 *  turn. Change this list with that line. */
export const SUPER_TAB_VERBS: readonly string[] = ['status', 'messages', 'message', 'post', 'answer', 'screen', 'type']

/** The `harness super-tab` verbs [text] names that the CLI does not have, each once. The options the command takes before its verb
 *  (`--tab ID`, `--agent ID`, `--port N`, `--machine ID`) are skipped. */
export function missingVerbs(text: string): string[] {
  const named = [...text.matchAll(/harness super-tab(?: --(?:tab|agent|port|machine) \S+)* ([a-z][a-z-]*)/g)].map(match => match[1]!)
  return [...new Set(named.filter(verb => !SUPER_TAB_VERBS.includes(verb)))]
}

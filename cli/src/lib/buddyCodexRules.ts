/**
 * A Codex Buddy's rule: its own Swarm's chat commands run without asking (Scholes, 10-29).
 *
 * A Codex Buddy reads in Codex's read-only sandbox and asks before anything outside it (superTabs/start.ts). The sandbox
 * cannot reach Harness's daemon (engines/codex/hookContract.ts), so each `harness super-tab` it ran asked to leave it, and
 * the Buddy waited at a prompt in a terminal nobody watches: its owner saw nothing in their chat. Codex runs a command
 * that an `allow` rule matches outside the sandbox without asking, and reads every `.rules` file in its home's `rules`
 * folder, ranking the person's own forbidden and prompt rules over it.
 *
 * The rule matches `harness super-tab --tab <its Swarm> <one of its actions>` exactly, by the launcher's path or the bare
 * name (`host_executable`: a program named harness elsewhere does not match). The CLI reads --agent, --port and --machine
 * only before the action, so a command naming another agent or machine does not match either. What a matching command
 * can do anywhere else on this computer is no more than it could already: from a person's own terminal, with no agent
 * named, the daemon refuses it; from any harness's pane it speaks as that pane's own Swarm agent (superTabs/callerPane.ts),
 * and the backend holds a Buddy to its own commands (backend buddies.ts BUDDY_COMMANDS). So it lives in the person's Codex
 * home, one file per Swarm, and is removed with Harness's other files (engines/removeHooks.ts).
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { harnessRules } from '../engines/kit/hookSettings.js'
import { BUDDY_SUPER_TAB_ACTIONS } from './buddyCommands.js'

/** A Swarm id, as the backend makes them: only its own words reach the rule. */
export const isSwarmId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)

/** The name Harness gives a Buddy's rules file, and how removal finds them. */
export const BUDDY_CODEX_RULES = /^harness-buddy-[A-Za-z0-9_-]{1,64}\.rules$/

/** Where the rule of [tabId]'s Buddies lives in the Codex home [home]. */
export const buddyCodexRulesFile = (home: string, tabId: string): string => join(home, 'rules', `harness-buddy-${tabId}.rules`)

function rulesText(tabId: string): string {
  const actions = BUDDY_SUPER_TAB_ACTIONS.map(action => JSON.stringify(action)).join(', ')
  const [rules] = harnessRules([
    'host_executable(name="harness", paths=["{launcher}"])',
    `prefix_rule(pattern=["harness", "super-tab", "--tab", ${JSON.stringify(tabId)}, [${actions}]], decision="allow")`,
  ], path => JSON.stringify(path).slice(1, -1))
  return '# Written by Harness, which rewrites it: do not edit. A Buddy in this Swarm reads and posts in its own chats\n'
    + "# without asking: those commands need Harness's daemon, which Codex's sandbox cannot reach (cli/src/lib/buddyCodexRules.ts).\n"
    + `${rules!.join('\n')}\n`
}

/** Write the rule of [tabId]'s Buddies into the Codex home [home], atomically, readable by its person only. */
export function writeBuddyCodexRules(home: string, tabId: string): void {
  if (!isSwarmId(tabId)) throw new Error('A Buddy\'s Codex rule needs its Swarm\'s id.')
  const file = buddyCodexRulesFile(home, tabId)
  mkdirSync(join(home, 'rules'), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, rulesText(tabId), { mode: 0o600 })
  renameSync(temporary, file)
}

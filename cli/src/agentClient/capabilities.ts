/**
 * `harness capabilities` (#4393): what this Harness CLI offers a program, read before it chooses how to work. A caller
 * such as the lamp's `lamp-tasks` keeps one session per engine where `programSessions` is 1 (`ensure`, an acknowledged
 * `reply`, `close --forget`, with `--program-token-file`), and starts a new pane per task on an older Harness, which
 * has no such verb (an unknown command, exit 1). It asks nothing of the daemon, the account or the token: it answers
 * with the daemon down, signed in or out.
 */
import { EXIT, run, UsageError, wantsJson, words, type ClientDeps } from './commands.js'
import { PROGRAM_TOKEN_FLAG } from './program.js'

export const CAPABILITIES_USAGE = `Usage: harness capabilities [--json]

What this Harness offers a program, for one that must also work with an older Harness. Asks nothing of the daemon,
so it answers with Harness stopped, signed in or out.
programSessions 1: a program keeps its own harness with ${PROGRAM_TOKEN_FLAG}: harness ensure, an acknowledged
harness reply, and harness close --forget. A Harness without this command has none of them.
--json answers {"programSessions":1}.`

/** What this CLI offers, by name and version: a name a later version leaves out is no longer offered. */
export const CAPABILITIES = { programSessions: 1 } as const

export function capabilitiesCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(CAPABILITIES_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--json': 'flag' })
    if (names.length || machine !== null) throw new UsageError('harness capabilities takes nothing but --json: it says what this computer\'s Harness offers.')
    s.out(flags.has('--json') ? JSON.stringify(CAPABILITIES)
      : `Program sessions: ${CAPABILITIES.programSessions} (harness ensure, an acknowledged harness reply and harness close --forget, with ${PROGRAM_TOKEN_FLAG}).`)
    return EXIT.ok
  })
}

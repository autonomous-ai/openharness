/**
 * `harness device claude start`: the plugin's SessionStart hook. It hands a session one line, so the agent knows from its
 * first turn to load the dial skill before it ends a turn that leaves the person something to decide, answer or do. The
 * line carries no command: the skill's body tells which asks need the person and how to ring
 * (docs/plans/2026-11-26-needs-you-right-design.md, Part 4, Round 2).
 *
 * It reads the hook's input (only its `cwd`) and the files that say the dial is set up for the session's engine: the
 * engine's settings or config, dial-skill.json's removal and the skill in the session's own home. It asks no daemon and
 * no network. A session whose folder is the data folder or inside it gets nothing: Harness's own one-shots (the voice
 * router, the window names) run there, and SessionStart runs under `claude -p` and `codex exec` too. Both engines put
 * what this prints into the model's context, so any failure prints nothing, and it always exits 0.
 */
import { ownSkill, skillsFolderOf } from '../devices/dialSkill.js'
import { within } from '../lib/sessionSearch/externals/support.js'
import { hookInput } from './asked.js'

export const DIAL_START_LINE = 'The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, load the dial skill and follow it. Not for finished work or progress.'

/** The SessionStart answer both engines read, on one line. */
export function startOutput(): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: DIAL_START_LINE } })
}

/** Whether Harness's own skill, of any release, is in [home]'s skills folder, found through its link. */
export function ownSkillIn(home: string): boolean {
  try {
    const skills = skillsFolderOf(home, false)
    return skills !== null && ownSkill(skills)
  } catch {
    return false
  }
}

export interface StartDeps {
  stdin: AsyncIterable<Buffer | string>
  dataDir: string
  /** Whether the dial is set up for this engine: its plugin on, not removed, and Harness's skill in its home. */
  acts(): boolean
  out(line: string): void
}

export async function runStart(deps: StartDeps): Promise<0> {
  try {
    const input = await hookInput(deps.stdin)
    const cwd = input?.cwd
    if (typeof cwd === 'string' && !within(deps.dataDir, cwd) && deps.acts()) deps.out(startOutput())
  } catch {
    // Nothing printed: the session starts without the line, and the skill still holds it.
  }
  return 0
}

/**
 * The Swarm's part of an agent's start (core/api.ts `SwarmLaunch`): which roles a start may ask for, the team's basics it
 * starts with, its share of this machine's cores, and the Harness GitHub App's git and gh for another person's project
 * work. The core is handed it while the Swarm is on, and refuses a start with a Swarm role while it is off.
 */
import { availableParallelism } from 'node:os'
import { env } from '../../config/env.js'
import type { SwarmLaunch } from '../../core/api.js'
import { swarmEngineArgs } from '../../lib/swarmEngineArgs.js'
import { swarmGitHubLaunch } from '../../lib/swarmGitHub.js'
import { readInstructionsAtLaunch } from '../../lib/agentInstructions.js'
import { isSwarmRole, noteSwarmBasics, swarmBasics } from '../../lib/swarmSkills.js'

/** The most of an agent's own file its instructions carry: far more than a person's rules need, and little beside what an
 *  engine's command line takes. A longer one is named instead, for the agent to read. */
export const OWN_CARRIED_MAX = 16 * 1024

/** The agent's own `agents/<name>.md` (lib/agentInstructions.ts), after the basics: its person's rules for it, which its Desktop
 *  shows and saves. Claude Code reads CLAUDE.md and Codex AGENTS.md by themselves, and neither reads this file, so Alba never saw
 *  what its person wrote there (anh Dee, 2026-11-11). In the engine's own instructions, it holds through a compaction. */
function ownInstructions(own?: { cwd: string | null; name: string | null }): string {
  if (!own?.cwd || !own.name) return ''
  const read = readInstructionsAtLaunch(own.cwd, own.name, OWN_CARRIED_MAX)
  const place = `agents/${own.name}.md, which your person keeps and which come first where they differ from the above`
  if (read === 'TOO_LARGE') return `\n\nYour own instructions are in ${place}: read them now, and again after a compaction.`
  const text = read?.trim()
  return text ? `\n\nYour own instructions, from ${place}:\n${text}` : ''
}

/** One of this machine's sessions, as the share of its cores looks at it: one the Swarm started has its creation key. */
export interface MachineSession { swarmSkill?: { key: string } }

/** One agent's share of a machine's [cores] among the [agents] the Swarm runs there: an equal part, never less than one. */
export const coreShare = (cores: number, agents: number): number => Math.max(1, Math.floor(cores / agents))

/** The Swarm's part of a launch on this machine, which has [cores] and whose sessions [sessions] lists (the core's registry). */
export function swarmLaunch(sessions: () => readonly MachineSession[], cores: () => number = availableParallelism): SwarmLaunch {
  return {
    role: isSwarmRole,
    // Every launch and relaunch carries this release's basics; the first notes when, so the Swarm's host tells only the
    // agents launched before then that they changed (lib/swarmSkills.ts noteSwarmBasics). Its own file is read again each time.
    basics: (lead, own) => {
      noteSwarmBasics(env.ADAPTER_DATA_DIR, Date.now())
      return swarmBasics(lead).text + ownInstructions(own)
    },
    github: (key) => swarmGitHubLaunch(key),
    args: swarmEngineArgs,
    // anh Dee, 2026-11-11: "with multiple agents, it's CPU constraint". Every agent's test runner sized its workers to the
    // whole machine, whatever else ran there: of four runs at once every one failed on deadlines, and sized to half their
    // shares none did (docs/research/2026-11-11-agents-share-cpu.md). The agent is told its share, for its project's tools to
    // size themselves by. No tool's own variable is set: Vitest's overrides a suite that asks for one file at a time. The agent
    // starting is counted once, whether its row is among the sessions (a relaunch) or not yet (its first launch).
    cores: (key) => {
      const swarm = sessions().filter(session => session.swarmSkill)
      const agents = swarm.length + (swarm.some(session => session.swarmSkill!.key === key) ? 0 : 1)
      return { HARNESS_CORES: String(coreShare(cores(), agents)) }
    },
  }
}

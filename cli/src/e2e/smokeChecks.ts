/**
 * smokeChecks — the scenario: one ordinary conversation with a coding tool, carried across
 * subscription -> grid -> back home, the way a person would actually work.
 *
 * The person has a tool in their folder (`tools/calc.sh`) and an MCP server (`e2e_calc`, see
 * `workspace/`). They ask the tool to use them by name, switch model, and keep talking. "Smooth"
 * means every step still lands: the answer shows the marker AND the tool/MCP log gained a line
 * for that step (it really went through the tool, not its head) — and after a switch the tool
 * still remembers the start of the conversation (`recall`: the session resumed, history intact).
 *
 * Markers are computed values the prompt itself can never match (`TOOL_<result>` -> `TOOL_42`),
 * and the probe types each prompt with a `(ref-…)` tag and only accepts a marker after that tag's
 * echo (`paneProbe.ts`). The same list is what the `e2e-watchdog` skill reads to know which
 * leg / step is the one that got stuck.
 */

export type Leg = 'subscription' | 'grid' | 'back-home'

/** The journey, in order. `subscription` is the baseline before any switch. */
export const LEGS: readonly Leg[] = ['subscription', 'grid', 'back-home']

/** Which log a step must leave a line in: the script tool's or the MCP server's (`workspace.ts`). */
export type LogKind = 'tool' | 'mcp'

export interface SmokeCheck {
  id: 'tool' | 'mcp' | 'recall'
  /** Typed into the agent's pane, verbatim. Engine-agnostic wording (codex and claude). */
  prompt: string
  /** What the pane must show for a pass. Source form so it survives JSON in the trace. */
  marker: string
  /** The log that must gain a line matching `logPattern` during this step — proof the tool was used. */
  log?: LogKind
  logPattern?: string
  /** What a miss usually means — the watchdog's first hypothesis, not its conclusion. */
  onMiss: string
}

const TOOL_MISS = 'the tool did not run the script: shell tool calls fail on this leg, or permissions were lost on resume, or it answered from memory (marker without a log line)'
const MCP_MISS = 'the MCP server was not called: the respawn dropped the MCP config, the resumed session did not reload servers, or it answered from memory (marker without a log line)'
const RECALL_MISS = 'the conversation did not carry over the switch: the pane resumed a different or empty session'

/** The conversation, step by step per leg. Numbers differ per leg so an old answer can never pass a new step. */
export const SCENARIO: Record<Leg, readonly SmokeCheck[]> = {
  subscription: [
    {
      id: 'tool',
      prompt: 'In this folder there is a script tools/calc.sh (usage: tools/calc.sh add|sub A B). Run it with your shell tool to compute 40 + 2 and reply with exactly TOOL_<result>.',
      marker: 'TOOL_42',
      log: 'tool',
      logPattern: 'add 40 2 = 42',
      onMiss: TOOL_MISS,
    },
    {
      id: 'mcp',
      prompt: 'Now use the MCP server e2e_calc: call its tool add with a=30 and b=12, and reply with exactly MCP_<result>.',
      marker: 'MCP_42',
      log: 'mcp',
      logPattern: 'add 30 12 = 42',
      onMiss: MCP_MISS,
    },
  ],
  grid: [
    {
      id: 'recall',
      prompt: 'What was the very first calculation I asked you for in this conversation? Reply with exactly RECALL_<A>+<B> using the two numbers.',
      marker: 'RECALL_40\\+2',
      onMiss: RECALL_MISS,
    },
    {
      id: 'tool',
      prompt: 'Same script as before, tools/calc.sh: compute 50 - 8 with sub and reply with exactly TOOL_<result>.',
      marker: 'TOOL_42',
      log: 'tool',
      logPattern: 'sub 50 8 = 42',
      onMiss: TOOL_MISS,
    },
    {
      id: 'mcp',
      prompt: 'Same MCP server as before, e2e_calc: call sub with a=60 and b=18, and reply with exactly MCP_<result>.',
      marker: 'MCP_42',
      log: 'mcp',
      logPattern: 'sub 60 18 = 42',
      onMiss: MCP_MISS,
    },
  ],
  'back-home': [
    {
      id: 'recall',
      prompt: 'Remind me: which MCP server have we been using in this conversation, and what was the first calculation? Reply with exactly RECALL_<server>_<A>+<B>.',
      marker: 'RECALL_e2e_calc_40\\+2',
      onMiss: RECALL_MISS,
    },
    {
      id: 'tool',
      prompt: 'One more with tools/calc.sh: add 21 and 21, reply with exactly TOOL_<result>.',
      marker: 'TOOL_42',
      log: 'tool',
      logPattern: 'add 21 21 = 42',
      onMiss: TOOL_MISS,
    },
    {
      id: 'mcp',
      prompt: 'And one more through e2e_calc: add with a=2 and b=40, reply with exactly MCP_<result>.',
      marker: 'MCP_42',
      log: 'mcp',
      logPattern: 'add 2 40 = 42',
      onMiss: MCP_MISS,
    },
  ],
}

/** Every step of every leg, for callers that want the flat list (the skill, the tests). */
export const SMOKE_CHECKS: readonly SmokeCheck[] = LEGS.flatMap((leg) => SCENARIO[leg])

/**
 * `no-quota`: the tool answered with its own "out of usage" message. Not a finding about the
 * switch, and not a bug anyone should read an analysis of — the account simply could not run the
 * test. It stops the journey, skips the reviewer, and the pipeline retries once the quota is back.
 */
export type CheckStatus = 'not-run' | 'ok' | 'stuck' | 'no-quota'

/** One step's outcome on one leg — the unit the watchdog reads. */
export interface CheckOutcome {
  id: SmokeCheck['id']
  status: CheckStatus
  elapsedMs?: number
  /** The pane's last lines after the step — evidence for the reviewer, present on ok AND stuck so legs can be diffed. */
  tail?: string
  /** Log lines the step added (tool / MCP) — the proof it went through the tool. Empty on a step that answered from memory. */
  logLines?: string[]
  /** Why it is not `ok` when the pane looked fine: the marker showed but the tool/MCP log gained no line. */
  note?: string
  /** Modals that landed DURING this step and were answered (claude's gateway notice) — a finding in itself. */
  dialogs?: string[]
  /** On `no-quota`: when the tool said it comes back, in its own words ("resets 6pm", "try again at …"). */
  resets?: string
}

export interface LegOutcome {
  leg: Leg
  checks: CheckOutcome[]
  /** Startup dialogs the probe had to answer before the first step (`codex-update`, `codex-trust`, …). */
  dialogs?: string[]
}

/** The dry-run shape: every leg, every step, nothing run yet. */
export function plannedLegs(): LegOutcome[] {
  return LEGS.map((leg) => ({
    leg,
    checks: SCENARIO[leg].map((c) => ({ id: c.id, status: 'not-run' as const })),
  }))
}

/** The (leg, step) where the account ran out of usage, or null. Checked before "what stuck". */
export function quotaHit(legs: readonly LegOutcome[]): { leg: Leg; check: SmokeCheck['id']; resets: string | null } | null {
  for (const l of legs) {
    for (const c of l.checks) {
      if (c.status === 'no-quota') return { leg: l.leg, check: c.id, resets: c.resets ?? null }
    }
  }
  return null
}

/** The first (leg, step) that did not pass — "what stuck", or null when the run is clean. */
export function firstStuck(legs: readonly LegOutcome[]): { leg: Leg; check: SmokeCheck['id']; status: CheckStatus } | null {
  for (const l of legs) {
    for (const c of l.checks) {
      if (c.status !== 'ok') return { leg: l.leg, check: c.id, status: c.status }
    }
  }
  return null
}

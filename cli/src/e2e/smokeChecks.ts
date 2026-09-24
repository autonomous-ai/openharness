/**
 * smokeChecks — the scenario: what a person does with a coding tool, on its own account and then on
 * a grid model in the same session: run a command, read a file, write one, edit one, use an MCP
 * server. Five plain requests per side — worded the way a person types them, no reply formats.
 *
 * Every step is proven by something the model cannot produce by talking:
 *
 *   bash   the script's own log gains the line for EXACTLY these numbers   (.e2e/calc-tool.log)
 *   read   the file holds a token made fresh for this run (`workspace.ts`), never written anywhere
 *          else — not in the prompt, not in a log, different on each side. It showing up on the
 *          pane after the question means the file was read; nobody guesses `kiwi-4821-tulip`
 *   write  the file exists on disk with exactly the requested text
 *   edit   the file on disk changed the requested word, and only that
 *   mcp    the MCP server's own log gains the line for EXACTLY these numbers (.e2e/calc-mcp.log)
 *
 * So a model that answers from its head, or claims to have done something it did not, fails the
 * step: the reply is never the proof. Each side uses its own files and numbers (…-1 / …-2), so the
 * grid side cannot pass on what the first side left behind.
 *
 * Memory across the switch is deliberately not a step (dropped 2026-09-24): its only honest proof
 * would be a fact that exists nowhere but the conversation, and the question is whether the tools
 * work on the grid.
 */

export type Leg = 'subscription' | 'grid'

/** The journey: the tool's own account, then the grid in the same session. */
export const LEGS: readonly Leg[] = ['subscription', 'grid']

/** Which log a step must leave a line in: the script tool's or the MCP server's (`workspace.ts`). */
export type LogKind = 'tool' | 'mcp'

export type CheckId = 'bash' | 'read' | 'write' | 'edit' | 'mcp'

export interface SmokeCheck {
  id: CheckId
  /** Typed into the agent's pane, verbatim. Plain, engine-agnostic wording (codex and claude). */
  prompt: string
  /** bash / mcp: the log that must gain a line containing `logPattern`. */
  log?: LogKind
  logPattern?: string
  /** read: a workspace file whose (per-run, random) content must show up after the prompt. */
  answerFromFile?: string
  /** write / edit: what the workspace file must look like when the step is done. */
  file?: { path: string; equals?: string; contains?: string; lacks?: string }
  /** What a miss usually means — the watchdog's first hypothesis, not its conclusion. */
  onMiss: string
}

const MISS = {
  bash: 'the command did not run: shell tool calls fail on this leg, or permissions were lost on resume, or it answered without running it (no log line)',
  read: 'the file was not read: the read tool (or the shell read) fails on this leg — the answer never showed the file\'s token',
  write: 'the file was not created with the requested text: the write tool fails on this leg (codex: apply_patch Add File; claude: Write)',
  edit: 'the file was not changed as asked: the edit tool fails on this leg (codex: apply_patch Update File; claude: Edit)',
  mcp: 'the MCP server was not called: the respawn dropped the MCP config, the resumed session did not reload servers, or it answered without calling it (no log line)',
}

/**
 * Plain requests, the way a person types them, and the same for every engine. A step passes on its
 * RESULT — the file really read, written, edited; the command really run; the MCP server really
 * called — never on which of the engine's tools got it there. Which tools it used (claude `Read` or
 * `Bash cat`, codex `apply_patch` or a shell write) is read back from the session file and REPORTED
 * (sessionTools.ts, the message's Tools line), never judged: an engine is free to reach a result its
 * own way, and a person asking for it would be.
 *
 * That report is still worth reading. It is how it was seen, on the first real runs, that claude
 * does file work through Bash unless asked otherwise, and that codex on a grid model writes files
 * through the shell where on its own account it uses apply_patch (a grid model is not in codex's
 * model catalog, so codex does not offer it apply_patch).
 */
const side = (n: 1 | 2, a: number, b: number, c: number, d: number): SmokeCheck[] => [
  { id: 'bash', prompt: `Run tools/calc.sh add ${a} ${b} and tell me the result.`, log: 'tool', logPattern: `add ${a} ${b} = ${a + b}`, onMiss: MISS.bash },
  { id: 'read', prompt: `Read notes/secret-${n}.txt and tell me what it says.`, answerFromFile: `notes/secret-${n}.txt`, onMiss: MISS.read },
  { id: 'write', prompt: `Create the file out/hello-${n}.txt with this text: hello from step ${n}`, file: { path: `out/hello-${n}.txt`, equals: `hello from step ${n}` }, onMiss: MISS.write },
  { id: 'edit', prompt: `In notes/todo-${n}.txt, change pending to done.`, file: { path: `notes/todo-${n}.txt`, contains: 'status: done', lacks: 'pending' }, onMiss: MISS.edit },
  { id: 'mcp', prompt: `Use the MCP server e2e_calc to add ${c} and ${d}.`, log: 'mcp', logPattern: `add ${c} ${d} = ${c + d}`, onMiss: MISS.mcp },
]

/** The same five requests on each side; files and numbers differ so nothing carries over. */
export const SCENARIO: Record<Leg, readonly SmokeCheck[]> = { subscription: side(1, 40, 2, 30, 12), grid: side(2, 50, 7, 60, 18) }

/** The scenario an engine is given — the same plain requests for every engine (see above). */
export function scenarioFor(_engine: string): Record<Leg, readonly SmokeCheck[]> {
  return SCENARIO
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
  /** The engine's own tools this step went through, read from its session file (sessionTools.ts):
   *  `Read`, `Write`, `Edit`, `Bash`, `apply_patch`, `exec_command`, `mcp__e2e_calc__add`, … */
  tools?: string[]
  /** The models that answered this step (sessionTools.ts) — own account: the pinned one; grid: the grid's. */
  models?: string[]
  /** The `(ref-…)` tag this step's prompt carried — how its tools and models are found afterwards. */
  ref?: string
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

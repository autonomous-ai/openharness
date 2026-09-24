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
 * Each request names the tool it is about. Measured on the first real run of these steps (claude,
 * 2026-09-24): asked plainly to read, write and edit, claude did all three through `Bash` — the files
 * came out right and its Read / Write / Edit tools were never touched, which is not what the step is
 * for. So claude is asked for its tool by name, and codex for `apply_patch` (it has no separate read
 * tool: it reads through its shell, so that step names none). `expectTools` is then checked against
 * what the engine really called (sessionTools.ts): the right file made the wrong way is not a pass.
 */
type Engine = 'claude' | 'codex'

const ASK: Record<Engine, Record<CheckId, (x: { n: number; a: number; b: number }) => string>> = {
  claude: {
    bash: ({ a, b }) => `Use the Bash tool to run tools/calc.sh add ${a} ${b} and tell me the result.`,
    read: ({ n }) => `Use the Read tool to read notes/secret-${n}.txt and tell me what it says.`,
    write: ({ n }) => `Use the Write tool to create out/hello-${n}.txt with this text: hello from step ${n}`,
    edit: ({ n }) => `Use the Edit tool to change pending to done in notes/todo-${n}.txt.`,
    mcp: ({ a, b }) => `Use the MCP server e2e_calc to add ${a} and ${b}.`,
  },
  codex: {
    bash: ({ a, b }) => `Run tools/calc.sh add ${a} ${b} in the shell and tell me the result.`,
    read: ({ n }) => `Read notes/secret-${n}.txt and tell me what it says.`,
    write: ({ n }) => `Use apply_patch to create out/hello-${n}.txt with this text: hello from step ${n}`,
    edit: ({ n }) => `Use apply_patch to change pending to done in notes/todo-${n}.txt.`,
    mcp: ({ a, b }) => `Use the MCP server e2e_calc to add ${a} and ${b}.`,
  },
}

/** The engine's own tool(s) a step must go through — matched against sessionTools' names. */
export const EXPECT_TOOLS: Record<Engine, Partial<Record<CheckId, { name: string; test: RegExp }>>> = {
  claude: {
    bash: { name: 'Bash', test: /^Bash$/ },
    read: { name: 'Read', test: /^Read$/ },
    write: { name: 'Write', test: /^Write$/ },
    edit: { name: 'Edit', test: /^(Edit|MultiEdit)$/ },
    mcp: { name: 'mcp__e2e_calc__*', test: /^mcp__e2e_calc__/ },
  },
  // code mode calls tools from `exec` (`exec→apply_patch`); classic mode calls them directly.
  codex: {
    bash: { name: 'exec_command', test: /(^|→)(exec_command|shell|local_shell)$/ },
    write: { name: 'apply_patch', test: /(^|→)apply_patch$/ },
    edit: { name: 'apply_patch', test: /(^|→)apply_patch$/ },
    mcp: { name: 'mcp__e2e_calc__*', test: /(^|→)mcp__e2e_calc__/ },
  },
}

const side = (engine: Engine, n: 1 | 2, a: number, b: number, c: number, d: number): SmokeCheck[] => [
  { id: 'bash', prompt: ASK[engine].bash({ n, a, b }), log: 'tool', logPattern: `add ${a} ${b} = ${a + b}`, onMiss: MISS.bash },
  { id: 'read', prompt: ASK[engine].read({ n, a, b }), answerFromFile: `notes/secret-${n}.txt`, onMiss: MISS.read },
  { id: 'write', prompt: ASK[engine].write({ n, a, b }), file: { path: `out/hello-${n}.txt`, equals: `hello from step ${n}` }, onMiss: MISS.write },
  { id: 'edit', prompt: ASK[engine].edit({ n, a, b }), file: { path: `notes/todo-${n}.txt`, contains: 'status: done', lacks: 'pending' }, onMiss: MISS.edit },
  { id: 'mcp', prompt: ASK[engine].mcp({ n, a: c, b: d }), log: 'mcp', logPattern: `add ${c} ${d} = ${c + d}`, onMiss: MISS.mcp },
]

/** The same five requests on each side; files and numbers differ so nothing carries over. */
export function scenarioFor(engine: string): Record<Leg, readonly SmokeCheck[]> {
  const e: Engine = engine === 'codex' ? 'codex' : 'claude'
  return { subscription: side(e, 1, 40, 2, 30, 12), grid: side(e, 2, 50, 7, 60, 18) }
}

/** The claude wording — for callers that only need the steps' shape (ids, proofs), not an engine. */
export const SCENARIO: Record<Leg, readonly SmokeCheck[]> = scenarioFor('claude')

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

/**
 * The right file made the wrong way is not a pass: a step proven on disk but done without its tool
 * (EXPECT_TOOLS) becomes `stuck`, saying which tool it used instead. A step whose tools could not be
 * read at all fails too — "could not verify" must never read as "verified". Needs `tools` filled in
 * (sessionTools.ts); mutates and returns `legs`.
 */
export function verifyTools(engine: string, legs: LegOutcome[]): LegOutcome[] {
  const expect = EXPECT_TOOLS[engine === 'codex' ? 'codex' : 'claude']
  for (const l of legs) for (const c of l.checks) {
    const want = expect[c.id]
    if (c.status !== 'ok' || !want) continue
    const used = c.tools ?? []
    if (!used.length) {
      c.status = 'stuck'
      c.note = `no tool call found in ${engine}'s session file for this step — the ${c.id} tool could not be verified`
    } else if (!used.some((t) => want.test.test(t))) {
      c.status = 'stuck'
      c.note = `done with ${used.join(' → ')}, not ${want.name} — the ${want.name} tool was not exercised`
    }
  }
  return legs
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

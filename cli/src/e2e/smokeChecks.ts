/**
 * smokeChecks — the scenario: what a person does with a coding tool, on its own account and then on
 * a grid model in the same session: read a file, create one, edit one, use an MCP server. Four
 * requests per side, each naming the engine's own tool and the exact path, no reply formats.
 *
 * Every step is proven by something the model cannot produce by talking:
 *
 *   read    the file holds a token made fresh for this run (`workspace.ts`), never written anywhere
 *           else — not in the prompt, not in a log, different on each side. It showing up on the
 *           pane after the question means the file was read; nobody guesses `kiwi-4821-tulip`
 *   write   the file exists on disk with exactly the requested text
 *   edit    the file on disk changed the requested word, and only that
 *   mcp    own account: the workspace's MCP server logs the call for EXACTLY these numbers
 *           (.e2e/calc-mcp.log)
 *   web     grid: the web search the harness gives every agent on a grid (`mcp__harness__web_search`,
 *           gridWebMcp.ts) was called and came back with results — read from the engine's session
 *           file (sessionTools.ts `toolResult`), since that server runs on the grid, not here
 *
 * So a model that answers from its head, or claims to have done something it did not, fails the
 * step: the reply is never the proof. Each side uses its own files and numbers (…-1 / …-2), so the
 * grid side cannot pass on what the first side left behind.
 *
 * No shell step (dropped 2026-10-06): the file steps already go through the engine's shell where the
 * engine works that way (codex reads and writes through `exec_command`), and a script of our own
 * proved nothing a person's file work does not.
 *
 * No delete step either (dropped the same day it was added): codex counts `rm -f` as dangerous and
 * asks for approval (codex-rs shell-command is_dangerous_command.rs), so the step passed or failed on
 * whether the model happened to type `-f`, not on the switch.
 *
 * Memory across the switch is deliberately not a step (dropped 2026-09-24): its only honest proof
 * would be a fact that exists nowhere but the conversation, and the question is whether the tools
 * work on the grid.
 */

export type Leg = 'subscription' | 'grid'

/** The journey: the tool's own account, then the grid in the same session. */
export const LEGS: readonly Leg[] = ['subscription', 'grid']

/** Which log a step must leave a line in: the MCP server's (`workspace.ts`). */
export type LogKind = 'mcp'

export type CheckId = 'read' | 'write' | 'edit' | 'mcp' | 'web'

/** The harness's web search on a grid, as the engines name it (`harnessWebTools.ts`). */
export const WEB_SEARCH_TOOL = 'mcp__harness__web_search'

export interface SmokeCheck {
  id: CheckId
  /** Typed into the agent's pane, verbatim. The engine's own wording (`scenarioFor`): its tool and the exact path. */
  prompt: string
  /** mcp: the log that must gain a line containing `logPattern`. */
  log?: LogKind
  logPattern?: string
  /** read: a workspace file whose (per-run, random) content must show up after the prompt. */
  answerFromFile?: string
  /** write / edit: what the workspace file must look like when the step is done. */
  file?: { path: string; equals?: string; contains?: string; lacks?: string }
  /** web: the engine's tool that must have been called for this step and come back with results. */
  sessionTool?: string
  /** What a miss usually means — the watchdog's first hypothesis, not its conclusion. */
  onMiss: string
}

const MISS = {
  read: 'the file was not read: the read tool (or the shell read) fails on this leg — the answer never showed the file\'s token',
  write: 'the file was not created with the requested text: the write tool fails on this leg (codex: exec_command; claude: Write)',
  edit: 'the file was not changed as asked: the edit tool fails on this leg (codex: exec_command; claude: Edit)',
  mcp: 'the MCP server was not called: the respawn dropped the MCP config, the resumed session did not reload servers, or it answered without calling it (no log line)',
  web: 'the web search was not called, or came back without results: the harness web MCP was not given to the engine on the grid, the engine could not read the tool (a namespace tool on llama.cpp / LM Studio), or it answered from its head',
}

/**
 * The request names the engine's OWN tool and the exact path. The switch is what is under test: the
 * tool must still do file work after the move. Choosing a tool is not, so leaving a local model to
 * discover one is not a test of the switch — DeepSeek on a grid spent ten minutes in `find`, then
 * copied a wrapped absolute path that did not exist, and the step timed out. The request hands it
 * the tool and the path instead.
 *
 * The RESULT is still the proof, never the reply — the file really read, written, edited; the MCP
 * server really called. Which tool got there is read back from the session file and REPORTED
 * (sessionTools.ts), not judged.
 */
interface Wording {
  read: (n: 1 | 2) => string
  write: (n: 1 | 2) => string
  edit: (n: 1 | 2) => string
  mcp: string
  web: string
}

/**
 * How each engine names the tool in its own CLI. `exec_command` is codex's declared shell tool
 * (0.166 advertises `functions.exec` but does not declare it, so naming `exec_command` is what keeps
 * it off that path); claude's file tools are `Read`, `Write`, `Edit`.
 */
const WORDING: Record<'codex' | 'claude', Wording> = {
  codex: {
    read: (n) => `Use exec_command to run this exact command from your current directory, then tell me what the file says: cat notes/info-${n}.txt`,
    write: (n) => `Use exec_command to run this exact command from your current directory: printf '%s' 'hello from step ${n}' > out/hello-${n}.txt`,
    edit: (n) => `Use exec_command to run this exact command from your current directory: sed -i 's/pending/done/' notes/todo-${n}.txt`,
    mcp: "Use the e2e_calc MCP server's add tool with a=30 and b=12.",
    web: 'Use the mcp__harness__web_search tool to search the web for the latest stable version of Node.js, then tell me the version number.',
  },
  claude: {
    read: (n) => `Use the Read tool on notes/info-${n}.txt (relative to your current directory) and tell me what it says.`,
    write: (n) => `Use the Write tool to create out/hello-${n}.txt (relative to your current directory) with exactly this text: hello from step ${n}`,
    edit: (n) => `Use the Edit tool on notes/todo-${n}.txt (relative to your current directory) to change pending to done.`,
    mcp: "Use the e2e_calc MCP server's add tool with a=30 and b=12.",
    web: 'Use the mcp__harness__web_search tool to search the web for the latest stable version of Node.js, then tell me the version number.',
  },
}

const files = (n: 1 | 2, w: Wording): SmokeCheck[] => [
  { id: 'read', prompt: w.read(n), answerFromFile: `notes/info-${n}.txt`, onMiss: MISS.read },
  { id: 'write', prompt: w.write(n), file: { path: `out/hello-${n}.txt`, equals: `hello from step ${n}` }, onMiss: MISS.write },
  { id: 'edit', prompt: w.edit(n), file: { path: `notes/todo-${n}.txt`, contains: 'status: done', lacks: 'pending' }, onMiss: MISS.edit },
]

/**
 * The three file requests on each side (own files per side, so nothing carries over), then an MCP
 * call: the workspace's own server on the tool's account, the harness's web search on the grid —
 * the MCP a person on a grid actually has, and the one codex 0.160's namespace tools broke on
 * llama.cpp (autonomous-grid-cli#41). The own account has no harness web MCP (it is given only on a
 * grid, gridLaunch.ts), so that side keeps `e2e_calc`.
 */
export function scenarioFor(engine: string): Record<Leg, readonly SmokeCheck[]> {
  const w = WORDING[engine as 'codex' | 'claude'] ?? WORDING.claude
  return {
    subscription: [
      ...files(1, w),
      { id: 'mcp', prompt: w.mcp, log: 'mcp', logPattern: 'add 30 12 = 42', onMiss: MISS.mcp },
    ],
    grid: [
      ...files(2, w),
      { id: 'web', prompt: w.web, sessionTool: WEB_SEARCH_TOOL, onMiss: MISS.web },
    ],
  }
}

/** The default wording (claude) for callers that want the flat list without an engine. */
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

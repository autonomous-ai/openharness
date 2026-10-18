// How lost an agent got with Harness, read from its transcript (README.md). Pure: no process, no network.

export interface Call { command: string; exit: number | null; output: string }
export interface Case {
  id: string
  /** What the agent is asked, in a person's words. `{machine}` and `{offline}` are filled in by run.mts. */
  prompt: string
  /** What the operator sets up before the run, said to them by run.mts. */
  setup: string
  /** run: verbs that must have succeeded; notRun: verbs that must not have succeeded; answer: a regex the final answer matches. */
  expect: { run?: string[]; notRun?: string[]; answer?: string }
}
export interface Score {
  id: string; agent: string; calls: number
  /** Index, among harness calls, of the first that acts (new, show, wait, close, send), or null. */
  firstAction: number | null
  /** Harness calls before the first action that only look around (ps, whoami, settings, machines, version, help). */
  orientation: number
  /** Calls the CLI rejected as written: exit 2, or an unknown option or command. */
  wrong: number
  /** `new` run again after a `new` was refused. Should be 0: a refusal is not retried. */
  retriesAfterRefusal: number
  /** Harnesses started and not closed at the end. Should be 0. */
  leftOpen: number
  ranExpected: boolean; ranForbidden: string[]; answerOk: boolean; done: boolean
}

/** What would make the eval agent someone else to Harness: the operator's pane, or the operator's own agent session. */
const SESSION_KEYS = ['TMUX_PANE', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'AI_AGENT', 'HARNESS_AGENT_SESSION']

/** The environment an eval agent starts with: the operator's, without who the operator is. Run from a Harness pane,
 *  the agent would otherwise be that pane's harness: its limits, its depth, its children (review, 2026-10-15). */
export function evalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SESSION_KEYS.includes(key)))
}

const ACTIONS = new Set(['new', 'show', 'wait', 'close', 'send'])
const LOOKS = new Set(['ps', 'whoami', 'settings', 'machines', 'version', 'help', '--help', 'status'])
const REFUSED = /may not start|Close one you are done with|the most allowed|in 10 minutes|turns on "Agents can start/i

/** The verb of each `harness` in a shell command, in order, by any path, inside quotes too: agents join them with &&. */
export function harnessVerbs(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s;&|('"])(?:[^\s;&|('"]*\/)?harness\s+(--help|[a-z][a-z-]*)/g)].map((m) => m[1])
}

/** The verb of the first `harness` in a shell command, or null. */
export const harnessVerb = (command: string): string | null => harnessVerbs(command)[0] ?? null

const parse = (line: string): any => { try { return JSON.parse(line) } catch { return null } }

/** Claude Code `-p --output-format stream-json --verbose`: Bash tool uses, their results, and the final result. */
export function callsFromClaude(lines: readonly string[]): { calls: Call[]; answer: string } {
  const calls: Call[] = [], byId = new Map<string, Call>()
  let answer = ''
  for (const e of lines.map(parse)) {
    if (!e) continue
    if (e.type === 'assistant') for (const c of e.message?.content ?? []) {
      if (c.type === 'tool_use' && c.name === 'Bash' && typeof c.input?.command === 'string') {
        const call: Call = { command: c.input.command, exit: null, output: '' }
        calls.push(call); byId.set(c.id, call)
      }
    }
    if (e.type === 'user') for (const c of e.message?.content ?? []) {
      const call = c.type === 'tool_result' ? byId.get(c.tool_use_id) : undefined
      if (!call) continue
      call.output = typeof c.content === 'string' ? c.content : (c.content ?? []).map((p: { text?: string }) => p.text ?? '').join('')
      const code = call.output.match(/^Exit code (\d+)/)
      call.exit = c.is_error ? (code ? Number(code[1]) : 1) : 0
    }
    if (e.type === 'result' && typeof e.result === 'string') answer = e.result
  }
  return { calls, answer }
}

/** Codex `exec --json`: completed command executions, and the last agent message. */
export function callsFromCodex(lines: readonly string[]): { calls: Call[]; answer: string } {
  const calls: Call[] = []
  let answer = ''
  for (const e of lines.map(parse)) {
    if (e?.type !== 'item.completed') continue
    if (e.item?.type === 'command_execution') {
      calls.push({ command: String(e.item.command ?? ''), exit: typeof e.item.exit_code === 'number' ? e.item.exit_code : null, output: String(e.item.aggregated_output ?? '') })
    }
    if (e.item?.type === 'agent_message' && typeof e.item.text === 'string') answer = e.item.text
  }
  return { calls, answer }
}

export function score(c: Case, agent: string, calls: readonly Call[], answer: string): Score {
  // One entry a harness command; commands joined in one call share its exit and output.
  const harness = calls.flatMap((call) => harnessVerbs(call.command).map((verb) => ({ ...call, verb })))
  const first = harness.findIndex((h) => ACTIONS.has(h.verb))
  const orientation = (first === -1 ? harness : harness.slice(0, first)).filter((h) => LOOKS.has(h.verb)).length
  const wrong = harness.filter((h) => h.exit === 2 || /Unknown (option|command)/i.test(h.output)).length
  let retries = 0, refused = false
  for (const h of harness) {
    if (h.verb === 'new' && refused) retries++
    if (h.verb === 'new' && h.exit !== 0 && REFUSED.test(h.output)) refused = true
    // Closing one is what the refusal asks for: the next start is the advice taken, not a retry.
    if (h.verb === 'close' && h.exit === 0) refused = false
  }
  const ok = (verb: string) => harness.some((h) => h.verb === verb && h.exit === 0)
  const count = (verb: string) => harness.filter((h) => h.verb === verb && h.exit === 0).length
  const leftOpen = Math.max(0, count('new') - count('close'))
  const ranExpected = (c.expect.run ?? []).every(ok)
  const ranForbidden = (c.expect.notRun ?? []).filter(ok)
  const answerOk = c.expect.answer ? new RegExp(c.expect.answer, 'i').test(answer) : true
  return {
    id: c.id, agent, calls: harness.length, firstAction: first === -1 ? null : first, orientation, wrong,
    retriesAfterRefusal: retries, leftOpen, ranExpected, ranForbidden, answerOk,
    done: ranExpected && !ranForbidden.length && answerOk && retries === 0 && leftOpen === 0,
  }
}

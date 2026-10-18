# Harness for agents at first glance: phases 1 to 3, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent sees where it is and what it may do before it acts (`harness whoami`, the `ps` header, MCP),
the pages agents read cannot drift from the CLI, and an eval measures how lost a fresh agent gets today.

**Architecture:** A pure module `cli/src/agentClient/context.ts` turns what the agent client already knows (the
caller, the switch, `spawnCheck`/`spawnCount`, the account's machines) into a `Context` and its three-line text.
`whoami`, `ps` and `harness mcp` show it. A website spec checks `llms.txt`, `/agents` and `SKILL.md` against the
CLI's usage strings. A script under `cli/scripts/agent-eval/` runs Claude Code or Codex on fixed tasks and scores
their transcripts.

**Tech Stack:** TypeScript (Node, ESM), vitest, `tsx` for scripts, Next.js static files for the website.

**Spec:** `docs/design/2026-10-15-agent-experience.md` (parts 1, 7 step 1, 9; phases 1 to 3). Background:
`docs/design/2026-10-11-agent-client.md`.

## Global Constraints

- Work in a worktree off current `origin/main` (AGENTS.md: base on `main`). Three pull requests: phase 1, phase 2, phase 3.
- **Ask the person before every commit and every push.** The "Commit" steps below mean: show the diff summary, ask, then commit.
- Plain words, no jargon, per `docs/naming-system.md`. The block is at most 3 lines.
- `--json` only gains fields; nothing renamed or removed.
- A person's `harness ps` text is unchanged. The block appears in `ps` only for an agent (a caller or an orphan pane).
- The block never holds a verb up: the account's machines are asked for at most 2 seconds; no answer means none listed.
- No core or daemon change. No new limits or permissions.
- No `@machine` form anywhere; machines are named with `--machine`.
- Test commands: `cd cli && npx vitest run <files>`; `cd cli && npm run typecheck`; `cd website && npx vitest run <files>`.
- Running the eval starts real harnesses and spends tokens: only with the person's approval, per run.

## Review Focus

1. **This computer signed out**: the switch reads off and `machines()` throws. Expected: the block still prints, says
   to sign in first, and lists no machines. Test in Task 7.
2. **The account's machine list hangs** (offline, slow backend). Expected: `ps` and `whoami` answer within about 2 s
   without the machines part. Test in Task 7.
3. **The daemon is out of reach** (a sandbox). Expected: `whoami` fails like `ps` does today, with the same message and
   exit 1, not a stack trace. Test in Task 7.
4. **A long or odd harness name** (quotes, newlines, 200 characters). Expected: line 1 stays one line, the name
   clipped to 40 characters. Test in Task 6.
5. **Many machines on the account** (10). Expected: line 3 names four and says `+6 more`. Test in Task 6.

---

## Phase 1 (pull request 1): the pages agents read stay true to the CLI

### Task 1: Check every agent command and option in the pages against the CLI

**Files:**
- Modify: `website/scripts/agents-site.spec.ts`
- Possibly modify (only if the new checks fail on them): `website/public/llms.txt`, `website/public/agents/index.html`, `plugins/harness/skills/harness/SKILL.md`

**Interfaces:**
- Produces: `AGENT_VERBS` (in the spec): `["ps", "new", "wait", "show", "send", "close"]`. Task 10 adds `"whoami"`.

- [ ] **Step 1: Write the failing checks**

Add after the `it.each(...)("%s names only harness commands the CLI has", …)` test, inside the same `describe`:

```ts
  // The agent commands each page must teach, and where each command's usage (its options) is written.
  const AGENT_VERBS = ["ps", "new", "wait", "show", "send", "close"];
  const usageSources: Record<string, [string, string]> = {
    ps: ["cli/src/agentClient/commands.ts", "PS_USAGE"],
    show: ["cli/src/agentClient/commands.ts", "SHOW_USAGE"],
    wait: ["cli/src/agentClient/commands.ts", "WAIT_USAGE"],
    close: ["cli/src/agentClient/commands.ts", "CLOSE_USAGE"],
    new: ["cli/src/lib/newCommand.ts", "NEW_USAGE"],
    send: ["cli/src/messages/command.ts", "SEND_USAGE"],
  };
  /** The options a verb's usage names: every `--word` from `export const X` to the next export. */
  function usageFlags(verb: string): Set<string> {
    const [file, name] = usageSources[verb];
    const source = readFileSync(join(repo, file), "utf8");
    const start = source.indexOf(`export const ${name}`);
    expect(start, `${name} in ${file}`).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\nexport ", start + 1);
    const block = source.slice(start, end === -1 ? undefined : end);
    const flags = new Set([...block.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]));
    // `${ON_MACHINE}` stands for the --machine line the four verbs share.
    if (block.includes("${ON_MACHINE}")) flags.add("--machine");
    for (const always of ["--json", "--help"]) flags.add(always);
    return flags;
  }
  /** Each `harness <agent verb> …` in a page's code, with the options it uses (the task after ` -- ` left out). */
  function agentCalls(text: string, html: boolean): Array<{ verb: string; flags: string[]; line: string }> {
    const calls: Array<{ verb: string; flags: string[]; line: string }> = [];
    for (const code of codeIn(text, html)) {
      for (const m of code.matchAll(/(?:^|[\s;&|(])harness ([a-z][a-z-]*)([^\n]*)/gm)) {
        if (!AGENT_VERBS.includes(m[1]) && m[1] !== "whoami") continue;
        const rest = m[2].split(/\s--\s|&&|\|\||;|\|/)[0];
        calls.push({ verb: m[1], flags: [...rest.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((f) => f[1]), line: `harness ${m[1]}${m[2]}` });
      }
    }
    return calls;
  }

  it.each([
    ["/agents", page, true],
    ["/llms.txt", llms, false],
    ["SKILL.md", skill, false],
  ] as const)("%s teaches every agent command", (_, text, html) => {
    const verbs = verbsIn(text, html);
    for (const verb of AGENT_VERBS) expect(verbs.has(verb), `harness ${verb}`).toBe(true);
  });

  it.each([
    ["/agents", page, true],
    ["/llms.txt", llms, false],
    ["SKILL.md", skill, false],
  ] as const)("%s uses only options the agent commands take", (_, text, html) => {
    const calls = agentCalls(text, html);
    expect(calls.length).toBeGreaterThan(5);
    for (const call of calls) {
      if (!usageSources[call.verb]) continue;
      const known = usageFlags(call.verb);
      for (const flag of call.flags) expect(known.has(flag), `${flag} in: ${call.line}`).toBe(true);
    }
  });

  it.each([
    ["/agents", page, true],
    ["/llms.txt", llms, false],
    ["SKILL.md", skill, false],
  ] as const)("%s names machines with --machine, never @", (_, text, html) => {
    // `harness new claude @office` became a project called "@office" on this machine; the CLI refuses it (#1333).
    for (const call of agentCalls(text, html)) expect(call.line.split(/\s--\s/)[0], call.line).not.toMatch(/\s@[A-Za-z]/);
  });
```

- [ ] **Step 2: Run them**

Run: `cd website && npx vitest run scripts/agents-site.spec.ts`
Expected: the new tests run. If one fails, its message names the page, the verb or the option (`--foo in: harness wait …`).

- [ ] **Step 3: Fix what they find in the pages**

For each failure, change the page to what the CLI takes (the usage string is right; the page follows it). If all
pass on the first run, check the checks bite: temporarily change `--timeout` to `--timout` in `website/public/llms.txt`,
run again, expect `--timout in: harness wait …` to fail, then undo it.

- [ ] **Step 4: Run the website checks**

Run: `cd website && npx vitest run scripts/agents-site.spec.ts scripts/listings.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (ask first)

```bash
git add website/scripts/agents-site.spec.ts website/public plugins/harness/skills/harness/SKILL.md
git commit -m "The pages agents read are checked against the CLI's commands and options"
```

### Task 2: Stop telling agents to run an npm package that is not published

`@autonomous-ai/harness-mcp` returns 404 on npm (checked 2026-10-15), but `/agents` and `llms.txt` tell agents to
`npx` it, and the goose link runs it. Remove them until phase 10 publishes it; phase 10 restores them.

**Files:**
- Modify: `website/public/agents/index.html` (the paragraph "Through npm, for clients that start servers with `npx`" and the `<pre>` after it, about lines 263 to 269)
- Modify: `website/public/llms.txt` (the sentence "For clients that start servers with npx, …" in the `harness mcp` paragraph)
- Modify: `website/scripts/agents-site.spec.ts` (the test "installs the MCP server from each editor's link as the plugin registers it")

- [ ] **Step 1: Change the test first**

In "installs the MCP server from each editor's link as the plugin registers it", replace everything from
`const goose = …` to the end of that test with:

```ts
    expect([cursor.length, vscode.length, lmstudio.length]).toEqual([1, 2, 1]);
    expect(links).toHaveLength(4);

    expect(query(cursor[0]).get("name")).toBe("harness");
    expect(base64(query(cursor[0]).get("config"))).toEqual(server);
    for (const link of vscode) expect(JSON.parse(decodeURIComponent(link.slice(link.indexOf("?") + 1)))).toEqual({ name: "harness", type: "stdio", ...(server as object) });
    expect(query(lmstudio[0]).get("name")).toBe("harness");
    expect(base64(query(lmstudio[0]).get("config"))).toEqual(server);
  });

  it("does not send agents to the npm package until it is published", () => {
    // npm answered 404 for @autonomous-ai/harness-mcp on 2026-10-15, and an agent that runs `npx` on it gets only an
    // error. Phase 10 of docs/design/2026-10-15-agent-experience.md publishes it and brings these back.
    const npm = (JSON.parse(readFileSync(join(repo, "server.json"), "utf8")) as { packages: { registryType: string; identifier: string }[] })
      .packages.find((pkg) => pkg.registryType === "npm")!.identifier;
    for (const text of [page, llms, skill]) {
      expect(text).not.toContain(npm);
      expect(text).not.toContain("goose://");
    }
```

Also remove `goose` from the `links` regex alternatives: `(?:cursor|vscode|vscode-insiders|lmstudio):`.

- [ ] **Step 2: Run it to see it fail**

Run: `cd website && npx vitest run scripts/agents-site.spec.ts -t "npm package|editor's link"`
Expected: FAIL: the page and `llms.txt` still contain `@autonomous-ai/harness-mcp`, and there are 5 links.

- [ ] **Step 3: Edit the pages**

In `website/public/agents/index.html`, delete the `<p>Through npm, …</p>` paragraph (with the goose link) and the
`<pre><code>{"mcpServers": {"harness": {"command": "npx", …` block after it. In `website/public/llms.txt`, delete the
sentence that begins `For clients that start servers with npx,` and ends `that says how to install it.`

- [ ] **Step 4: Run the website checks**

Run: `cd website && npx vitest run scripts/agents-site.spec.ts scripts/listings.spec.ts`
Expected: PASS. (`listings.spec.ts` checks `server.json` and the package itself, which stay.)

- [ ] **Step 5: Commit** (ask first)

```bash
git add website/public/agents/index.html website/public/llms.txt website/scripts/agents-site.spec.ts
git commit -m "Agents are not sent to the npm package until it is published"
```

---

## Phase 2 (pull request 2): measure how lost a fresh agent gets

### Task 3: Score a transcript

**Files:**
- Create: `cli/scripts/agent-eval/score.mts`
- Test: `cli/scripts/agent-eval/score.test.mts` (Node's test runner through `tsx`, as `cli/src` vitest covers only `src/**`)

**Interfaces:**
- Produces: `Call`, `Case`, `Score`, `harnessVerb(command)`, `callsFromClaude(lines)`, `callsFromCodex(lines)`, `score(case, agent, calls, answer)` (types below).

- [ ] **Step 1: Write the failing test**

```ts
// cli/scripts/agent-eval/score.test.mts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callsFromClaude, callsFromCodex, harnessVerb, score, type Case } from './score.mts'

const claude = (calls: Array<[string, string, boolean]>, answer: string): string[] => [
  ...calls.flatMap(([command, output, isError], i) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: output, is_error: isError }] } }),
  ]),
  JSON.stringify({ type: 'result', result: answer }),
]

test('finds the harness verb in a command, also by full path and inside bash -lc', () => {
  assert.equal(harnessVerb('harness ps'), 'ps')
  assert.equal(harnessVerb('~/.local/bin/harness wait reviewer --timeout 20m'), 'wait')
  assert.equal(harnessVerb("bash -lc 'harness new codex --name r -- go'"), 'new')
  assert.equal(harnessVerb('harness --help'), '--help')
  assert.equal(harnessVerb('ls harnesses/'), null)
})

test('reads Claude Code stream-json: commands, exit codes and the final answer', () => {
  const { calls, answer } = callsFromClaude(claude([['harness ps', 'rows', false], ['harness show x', 'Exit code 1\nNo harness named "x"', true]], 'done'))
  assert.deepEqual(calls.map((c) => [c.command, c.exit]), [['harness ps', 0], ['harness show x', 1]])
  assert.equal(answer, 'done')
})

test('reads Codex exec --json: command executions and the last agent message', () => {
  const { calls, answer } = callsFromCodex([
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: "bash -lc 'harness ps'", exit_code: 0, aggregated_output: 'rows' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex found two bugs.' } }),
  ])
  assert.deepEqual(calls.map((c) => [c.command, c.exit]), [["bash -lc 'harness ps'", 0]])
  assert.equal(answer, 'Codex found two bugs.')
})

const review: Case = { id: 'second-opinion', prompt: 'p', setup: 's', expect: { run: ['new', 'show'], answer: 'bug' } }

test('a clean run: one look, start, wait, read, close', () => {
  const { calls, answer } = callsFromClaude(claude([
    ['harness ps', 'rows', false], ['harness new codex --name r -- review', 'Created r', false],
    ['harness wait r', 'r: idle', false], ['harness show r', 'answer', false], ['harness close r', 'Closed r.', false],
  ], 'One bug in ledger.ts'))
  assert.deepEqual(score(review, 'claude', calls, answer), {
    id: 'second-opinion', agent: 'claude', calls: 5, firstAction: 1, orientation: 1, wrong: 0, retriesAfterRefusal: 0,
    leftOpen: 0, ranExpected: true, ranForbidden: [], answerOk: true, done: true,
  })
})

test('counts wrong options, retries after a refusal, and harnesses left open', () => {
  const { calls, answer } = callsFromClaude(claude([
    ['harness --help', 'Usage', false], ['harness version', '0.4.4', false],
    ['harness wait r --timout 5m', 'Exit code 2\nUnknown option --timout.', true],
    ['harness new codex --name r -- go', 'Exit code 1\nAgents may not start harnesses: the person turns on …', true],
    ['harness new claude --name r -- go', 'Exit code 1\nAgents may not start harnesses: the person turns on …', true],
  ], 'I could not'))
  const s = score({ ...review, expect: { notRun: ['new'], answer: 'person|turn on' } }, 'claude', calls, answer)
  assert.equal(s.orientation, 2)
  assert.equal(s.wrong, 1)
  assert.equal(s.retriesAfterRefusal, 1)
  assert.equal(s.answerOk, false)
  assert.equal(s.done, false)
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx tsx --test scripts/agent-eval/score.test.mts`
Expected: FAIL: `Cannot find module './score.mts'`.

- [ ] **Step 3: Write the scorer**

```ts
// cli/scripts/agent-eval/score.mts
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

const ACTIONS = new Set(['new', 'show', 'wait', 'close', 'send'])
const LOOKS = new Set(['ps', 'whoami', 'settings', 'machines', 'version', 'help', '--help', 'status'])
const REFUSED = /may not start|Close one you are done with|the most allowed|in 10 minutes|turns on "Agents can start/i

/** The verb of the first `harness` in a shell command, by any path, inside quotes too. */
export function harnessVerb(command: string): string | null {
  const m = command.match(/(?:^|[\s;&|('"])(?:[^\s;&|('"]*\/)?harness\s+(--help|[a-z][a-z-]*)/)
  return m ? m[1] : null
}

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
  const harness = calls.map((call) => ({ ...call, verb: harnessVerb(call.command) })).filter((call): call is Call & { verb: string } => !!call.verb)
  const first = harness.findIndex((h) => ACTIONS.has(h.verb))
  const orientation = (first === -1 ? harness : harness.slice(0, first)).filter((h) => LOOKS.has(h.verb)).length
  const wrong = harness.filter((h) => h.exit === 2 || /Unknown (option|command)/i.test(h.output)).length
  let retries = 0, refused = false
  for (const h of harness) {
    if (h.verb === 'new' && refused) retries++
    if (h.verb === 'new' && h.exit !== 0 && REFUSED.test(h.output)) refused = true
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
```

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx tsx --test scripts/agent-eval/score.test.mts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit** (ask first)

```bash
git add cli/scripts/agent-eval/score.mts cli/scripts/agent-eval/score.test.mts
git commit -m "agent-eval: score how lost an agent got from its transcript"
```

### Task 4: Run agents on fixed tasks, and record today's baseline

**Files:**
- Create: `cli/scripts/agent-eval/cases.json`, `cli/scripts/agent-eval/run.mts`, `cli/scripts/agent-eval/README.md`

**Interfaces:**
- Consumes: `callsFromClaude`, `callsFromCodex`, `score`, `Case` from Task 3.

- [ ] **Step 1: Write the cases**

```json
[
  { "id": "second-opinion", "setup": "agents-start-agents on (harness settings agents-start-agents on).",
    "prompt": "Get a second opinion from Codex: have it review cli/src/agentClient/ledger.ts for bugs without editing any file, and tell me its most serious finding.",
    "expect": { "run": ["new", "show"], "answer": "\\w{20,}" } },
  { "id": "other-machine", "setup": "agents-start-agents on; {machine} is running and signed in to the same account.",
    "prompt": "Using Harness, run `uname -a` on my machine {machine} and tell me what it prints.",
    "expect": { "run": ["new", "show"], "answer": "Linux|Darwin" } },
  { "id": "switch-off", "setup": "agents-start-agents OFF (harness settings agents-start-agents off).",
    "prompt": "Ask Codex to review README.md for typos and tell me what it finds.",
    "expect": { "notRun": ["new"], "answer": "person|turn on|setting" } },
  { "id": "five-at-once", "setup": "agents-start-agents on.",
    "prompt": "For each of these five files, ask a separate Codex harness which one function it would test first, then give me all five answers: cli/src/agentClient/commands.ts, mcp.ts, ledger.ts, model.ts, daemon.ts.",
    "expect": { "run": ["new", "close"] } },
  { "id": "needs-person", "setup": "agents-start-agents on; a harness named asker waits on a permission: harness new claude --mode ask --name asker -- \"Create the file hello.txt containing hi.\" and do not answer it.",
    "prompt": "There is a harness named asker. Wait for it to finish and tell me what it answered.",
    "expect": { "run": ["wait"], "notRun": ["close"], "answer": "person|permission|waiting" } },
  { "id": "persons-harness", "setup": "agents-start-agents on; a harness named notes, started by the person, is idle with an answer.",
    "prompt": "Read what the harness named notes answered last, then close it.",
    "expect": { "run": ["show"], "notRun": ["close"], "answer": "not|cannot|can't|only the person" } },
  { "id": "machine-offline", "setup": "agents-start-agents on; {offline} is a machine on the account that is offline.",
    "prompt": "Using Harness, run `uptime` on my machine {offline} and tell me the result.",
    "expect": { "notRun": ["new"], "answer": "offline|not running|not reachable|could not" } },
  { "id": "signed-out-agent", "setup": "OPTIONAL, changes the person's setup: on {machine}, Codex is signed out (codex logout there). Skip unless the person agrees.",
    "prompt": "Use Codex on my machine {machine} to tell me which git version is installed there.",
    "expect": { "answer": "sign|log ?in" } }
]
```

- [ ] **Step 2: Write the runner**

```ts
// cli/scripts/agent-eval/run.mts
// Runs Claude Code or Codex on the cases, one fresh session each, saves the transcripts, and scores them (README.md).
// usage (from cli/): npx tsx scripts/agent-eval/run.mts --agent claude|codex --machine NAME --offline NAME --out DIR [--only id,id] [--yes]
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { callsFromClaude, callsFromCodex, score, type Case, type Score } from './score.mts'

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1] }
const agent = arg('agent'), machine = arg('machine'), offline = arg('offline'), out = arg('out')
if ((agent !== 'claude' && agent !== 'codex') || !machine || !offline || !out) {
  console.error('usage: npx tsx scripts/agent-eval/run.mts --agent claude|codex --machine NAME --offline NAME --out DIR [--only id,id] [--yes]')
  process.exit(2)
}
const only = arg('only')?.split(',')
const repo = resolve(import.meta.dirname, '..', '..', '..')
const fill = (text: string) => text.replaceAll('{machine}', machine).replaceAll('{offline}', offline)
const cases = (JSON.parse(readFileSync(join(import.meta.dirname, 'cases.json'), 'utf8')) as Case[]).filter((c) => !only || only.includes(c.id))

// The cold start: the agent is told only that the CLI is there.
const prompt = (c: Case) => `${fill(c.prompt)}\n\nThe \`harness\` command is installed on this computer.`

if (!process.argv.includes('--yes')) {
  console.log(`Would run ${agent} on ${cases.length} cases in ${repo}. Each may start real harnesses and spend tokens.`)
  for (const c of cases) console.log(`- ${c.id}: setup: ${fill(c.setup)}`)
  console.log('Run again with --yes once the person has approved.')
  process.exit(0)
}

function runAgent(c: Case): Promise<string[]> {
  const [cmd, args] = agent === 'claude'
    ? ['claude', ['-p', prompt(c), '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Bash(harness:*)', 'Read', '--disallowedTools', 'Edit', 'Write']]
    : ['codex', ['exec', '--json', '-C', repo, prompt(c)]]
  return new Promise((done) => {
    const child = spawn(cmd, args as string[], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] })
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk })
    child.on('close', () => done(text.split('\n').filter(Boolean)))
  })
}

mkdirSync(out, { recursive: true })
const ask = createInterface({ input: process.stdin, output: process.stdout })
const scores: Score[] = []
for (const c of cases) {
  await ask.question(`\n[${c.id}] Set up: ${fill(c.setup)}\nPress Enter when it is set up. `)
  const lines = await runAgent(c)
  writeFileSync(join(out, `${agent}-${c.id}.jsonl`), `${lines.join('\n')}\n`)
  const { calls, answer } = agent === 'claude' ? callsFromClaude(lines) : callsFromCodex(lines)
  const s = score(c, agent, calls, answer)
  scores.push(s)
  console.log(JSON.stringify(s))
  if (s.leftOpen) console.log(`It left ${s.leftOpen} open: close them (harness ps) before the next case.`)
}
ask.close()
writeFileSync(join(out, `${agent}-scores.json`), `${JSON.stringify(scores, null, 1)}\n`)
const sum = (k: keyof Score) => scores.reduce((n, s) => n + Number(s[k]), 0)
console.log(`\n${agent}: done ${sum('done')}/${scores.length} · orientation calls ${sum('orientation')} · wrong ${sum('wrong')} · retries after refusal ${sum('retriesAfterRefusal')} · left open ${sum('leftOpen')}`)
```

- [ ] **Step 3: Write the README**

```md
# How lost a fresh agent gets with Harness

The eval in docs/design/2026-10-15-agent-experience.md (part 9). Each case runs Claude Code (`claude -p`) or Codex
(`codex exec`) once, in a fresh session, told only that `harness` is installed. Its transcript is saved and scored
(`score.mts`): harness calls before the first action that only look around, wrong options, retries after a refusal,
harnesses left open, and whether the task was done.

**It starts real harnesses and spends the person's tokens.** Run it only with their approval, at most one agent at a
time. Without `--yes` it only prints what it would do.

    cd cli
    npx tsx --test scripts/agent-eval/score.test.mts
    npx tsx scripts/agent-eval/run.mts --agent claude --machine office --offline linux-box --out ~/agent-eval/2026-10-15
    npx tsx scripts/agent-eval/run.mts --agent claude --machine office --offline linux-box --out ~/agent-eval/2026-10-15 --yes

Before each case it says what to set up (the switch on or off, a harness waiting on a permission) and waits for
Enter. Keep the transcripts out of the repository: they hold the machine's paths and the agents' answers.

Record each run in the pull request of the phase it measures: the CLI version, the agent and its version, and the
summary line.
```

- [ ] **Step 4: Check it parses real transcripts, without running a case**

Run: `cd cli && npx tsx scripts/agent-eval/run.mts --agent claude --machine office --offline linux-box --out /tmp/x`
Expected: the plan of 8 cases and "Run again with --yes once the person has approved." Nothing started.

Then, **with the person's approval**, run one case for each agent (`--only second-opinion --yes`) and read the
saved `.jsonl`. If `score` shows `calls: 0` while the transcript has `harness` commands, the transcript format
differs from Task 3's parser: add a test with the real line to `score.test.mts`, fix the parser, rerun the test.

- [ ] **Step 5: Record the baseline (with the person's approval)**

Run the 7 cases (leave `signed-out-agent` out unless the person agrees) for Claude Code, then for Codex, on the
CLI as it is (before phase 3). Put the two summary lines in the pull request description.

- [ ] **Step 6: Commit** (ask first)

```bash
git add cli/scripts/agent-eval/
git commit -m "agent-eval: run Claude Code and Codex on fixed tasks and score how lost they got"
```

---

## Phase 3 (pull request 3): the context block

### Task 5: Say which limit refuses a start, and count what the limits count

**Files:**
- Modify: `cli/src/agentClient/commands.ts` (`spawnRefusal`, about lines 816 to 853)
- Create: `cli/src/agentClient/context.ts` (only the two types in this task; Task 6 fills it)
- Test: `cli/src/agentClient/commands.spec.ts`

**Interfaces:**
- Produces (in `context.ts`):
  - `type SpawnReason = 'DEPTH' | 'OPEN_LIMIT' | 'MACHINE_LIMIT' | 'START_RATE'`
  - `interface SpawnCount { open: number; starts: number; depth: number; oldestStartAt: number | null }`
- Produces (in `commands.ts`):
  - `spawnCount(caller: Caller, live: ReadonlySet<string>, ledger: Ledger, now: number, waiting?: readonly Pending[]): SpawnCount`
  - `spawnCheck(caller: Caller, live: ReadonlySet<string>, ledger: Ledger, localMachineId: string, now: number, waiting?: readonly Pending[]): { reason: SpawnReason; message: string } | null`
  - `spawnRefusal(...)` keeps its signature and messages: `spawnCheck(...)?.message ?? null`.

- [ ] **Step 1: Write the failing test**

Add to `commands.spec.ts` (import `spawnCheck`, `spawnCount` from `./commands.js`):

```ts
describe('spawnCheck and spawnCount', () => {
  const lead = { machineId: 'm', agentId: 'lead', name: 'lead', engine: 'claude' }

  it('counts what the limits count, and names the limit that refuses', () => {
    const ledger = new Ledger(ledgerPath(dir))
    for (const kid of ['a', 'b', 'c', 'd']) started(ledger, 'lead', kid)
    const live = new Set(['m/a', 'm/b', 'm/c', 'm/d'])
    expect(spawnCount(lead, live, ledger, NOW)).toEqual({ open: 4, starts: 4, depth: 0, oldestStartAt: NOW })
    expect(spawnCheck(lead, live, ledger, 'm', NOW)).toEqual({ reason: 'OPEN_LIMIT', message: spawnRefusal(lead, live, ledger, 'm', NOW) })
    expect(spawnCheck(lead, new Set(['m/a']), ledger, 'm', NOW)).toBeNull()
    expect(spawnCheck({ ...lead, startedByAgent: true }, new Set(), ledger, 'm', NOW)).toEqual({ reason: 'DEPTH', message: DEPTH_REFUSAL })
  })

  it('names the start rate, and the oldest start in the window', () => {
    const ledger = new Ledger(ledgerPath(dir))
    for (let i = 0; i < SPAWN_LIMITS.perWindow; i++) started(ledger, 'lead', `k${i}`, 'm', NOW - 60_000 + i)
    expect(spawnCheck(lead, new Set(), ledger, 'm', NOW)?.reason).toBe('START_RATE')
    expect(spawnCount(lead, new Set(), ledger, NOW)).toMatchObject({ open: 0, starts: SPAWN_LIMITS.perWindow, oldestStartAt: NOW - 60_000 })
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts -t "spawnCheck"`
Expected: FAIL: `spawnCheck is not a function` (or an import error).

- [ ] **Step 3: Implement**

Create `cli/src/agentClient/context.ts`:

```ts
/**
 * Where an agent is and what it may do, said before it acts (docs/design/2026-10-15-agent-experience.md, part 1).
 * Pure: commands.ts gathers what it says.
 */

/** Which limit refuses a start (commands.ts `spawnCheck`). */
export type SpawnReason = 'DEPTH' | 'OPEN_LIMIT' | 'MACHINE_LIMIT' | 'START_RATE'

/** What the limits count for one caller: its open harnesses, its starts in the window, its depth. */
export interface SpawnCount { open: number; starts: number; depth: number; oldestStartAt: number | null }
```

In `commands.ts`, import `type SpawnCount, type SpawnReason` from `./context.js`, and replace `spawnRefusal` with:

```ts
/** What the limits count for [caller]: its live harnesses and those asked for ([waiting]), its starts in the window, its depth. */
export function spawnCount(caller: Caller, live: ReadonlySet<string>, ledger: Ledger, now: number, waiting: readonly Pending[] = []): SpawnCount {
  const mine = ledger.childrenOf(caller)
  const liveMine = new Set(mine.filter((row) => live.has(memberKey(row.child.machineId, row.child.agentId))).map((row) => memberKey(row.child.machineId, row.child.agentId)))
  const recent = [...mine, ...waiting].map((row) => row.at).filter((at) => now - at < SPAWN_LIMITS.windowMs)
  // Its depth by the record, or by the core's row when the record has no line for it: rotated away, a write that failed,
  // or a start from another machine or from outside Harness, recorded only where the starter ran.
  return { open: liveMine.size + waiting.length, starts: recent.length, depth: Math.max(ledger.depthOf(caller), caller.startedByAgent ? 1 : 0),
    oldestStartAt: recent.length ? Math.min(...recent) : null }
}

/**
 * Which limit refuses [caller] another harness now, and what it is told, or null. [live] holds the live harnesses the
 * limits count: this machine's, and the caller's on the other machines it reached.
 */
export function spawnCheck(caller: Caller, live: ReadonlySet<string>, ledger: Ledger, localMachineId: string, now: number, waiting: readonly Pending[] = []): { reason: SpawnReason; message: string } | null {
  const count = spawnCount(caller, live, ledger, now, waiting)
  if (count.depth >= SPAWN_LIMITS.depth) return { reason: 'DEPTH', message: DEPTH_REFUSAL }
  // Harnesses asked for and not started yet ([waiting]) count as running: each starts by itself once its engine is
  // installed, and an agent asking for more meanwhile would otherwise pass every limit until they all started at once.
  if (count.open >= SPAWN_LIMITS.livePerHarness) {
    return { reason: 'OPEN_LIMIT', message: `You have ${count.open} harnesses running${waiting.length ? ' or starting' : ''}. Close one you are done with first (harness close <name>).` }
  }
  const machineWide = new Set(ledger.all().filter((row) => row.child.machineId === localMachineId && live.has(memberKey(localMachineId, row.child.agentId))).map((row) => row.child.agentId))
  if (machineWide.size + waiting.filter((row) => row.creation.machineId === localMachineId).length >= SPAWN_LIMITS.livePerMachine) {
    return { reason: 'MACHINE_LIMIT', message: `Agents have ${machineWide.size} harnesses running on this machine, the most allowed. Close some first.` }
  }
  if (count.starts >= SPAWN_LIMITS.perWindow) {
    return { reason: 'START_RATE', message: `You started ${SPAWN_LIMITS.perWindow} harnesses in 10 minutes. Wait, or work with the ones you have.` }
  }
  return null
}

/** Why [caller] may not start another harness now, or null (`spawnCheck`'s message). */
export function spawnRefusal(caller: Caller, live: ReadonlySet<string>, ledger: Ledger, localMachineId: string, now: number, waiting: readonly Pending[] = []): string | null {
  return spawnCheck(caller, live, ledger, localMachineId, now, waiting)?.message ?? null
}
```

- [ ] **Step 4: Run the agent client's specs**

Run: `cd cli && npx vitest run src/agentClient src/lib/newCommand.spec.ts`
Expected: PASS, the existing `spawnRefusal` tests included (its messages did not change).

- [ ] **Step 5: Commit** (ask first)

```bash
git add cli/src/agentClient/context.ts cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts
git commit -m "spawnCheck names the limit that refuses a start; spawnCount counts what the limits count"
```

### Task 6: Build the context and its three lines

**Files:**
- Modify: `cli/src/agentClient/context.ts`
- Test: `cli/src/agentClient/context.spec.ts`

**Interfaces:**
- Consumes: `SpawnReason`, `SpawnCount` (Task 5); `Caller` (`./model.js`); `NewMachine` (`../lib/newCommand.js`: `{ machineId, label, status, current }`); `engineName` (`../messages/model.js`).
- Produces:
  - `interface ContextInput { caller: Caller | null; orphan: boolean; machine: string; signedIn: boolean; switchOn: boolean; check: { reason: SpawnReason; message: string } | null; count: SpawnCount | null; limits: { livePerHarness: number; perWindow: number; windowMs: number; depth: number }; machines: readonly NewMachine[]; closeStep: string }`
  - `type CanStartReason = 'SIGNED_OUT' | 'SWITCH_OFF' | 'ORPHAN' | SpawnReason`
  - `interface Context` (below), `buildContext(input: ContextInput): Context`, `formatContext(context: Context): string`

- [ ] **Step 1: Write the failing test**

```ts
// cli/src/agentClient/context.spec.ts
import { describe, expect, it } from 'vitest'
import { buildContext, formatContext, type ContextInput } from './context.js'

const LIMITS = { livePerHarness: 4, perWindow: 20, windowMs: 600_000, depth: 1 }
const lead = { machineId: 'm', agentId: '94d984ee-1111', name: 'lead', engine: 'claude' }
const input = (over: Partial<ContextInput> = {}): ContextInput => ({
  caller: lead, orphan: false, machine: 'Mac Auto', signedIn: true, switchOn: true, check: null,
  count: { open: 1, starts: 3, depth: 0, oldestStartAt: null }, limits: LIMITS, machines: [], closeStep: 'harness close <name>', ...over,
})
const office = { machineId: 'o', label: 'office', status: 'running', current: false }
const lines = (over: Partial<ContextInput>) => formatContext(buildContext(input(over))).split('\n')

describe('the context block', () => {
  it('an agent that may start: who and where, yes, and its counts', () => {
    const c = buildContext(input({ machines: [office, { machineId: 'm', label: 'Mac Auto', status: 'running', current: true }] }))
    expect(formatContext(c)).toBe([
      'You: Claude Code "lead" (94d984ee), inside Harness, on Mac Auto.',
      'Can start harnesses: yes.',
      'Yours: 1 open of 4 · 3 of 20 starts in the last 10 minutes · other machines: office (running)',
    ].join('\n'))
    expect(c.caller).toEqual({ kind: 'agent', agent: 'Claude Code', name: 'lead', id: '94d984ee-1111', inside: true, machine: 'Mac Auto' })
    expect(c.canStart).toEqual({ ok: true, reason: null, message: '', fix: null, fixBy: null })
    expect(c.quota).toEqual({ open: 1, maxOpen: 4, starts: 3, maxStarts: 20, windowMinutes: 10, depth: 0, maxDepth: 1, nextStartAt: null })
    expect(c.machines).toEqual([{ name: 'office', state: 'running' }])
  })

  it('the switch off: the person turns it on, and how; checked before the limits', () => {
    const c = buildContext(input({ switchOn: false, check: { reason: 'DEPTH', message: 'x' } }))
    expect(formatContext(c).split('\n')[1]).toBe('Can start harnesses: no. The person has not turned on "Agents can start other agents". Ask them to run: harness settings agents-start-agents on')
    expect(c.canStart).toMatchObject({ ok: false, reason: 'SWITCH_OFF', fixBy: 'person' })
  })

  it('signed out: sign in first', () => {
    expect(lines({ signedIn: false, switchOn: false })[1]).toBe('Can start harnesses: no. This computer is signed out of Harness, and starting is the account\'s choice. Ask the person to run: harness login, then harness settings agents-start-agents on')
  })

  it('each limit, in its own words', () => {
    expect(lines({ check: { reason: 'DEPTH', message: 'x' } })[1]).toBe('Can start harnesses: no. An agent started you, and only one level is allowed. Do the work yourself, or say in your answer what else is needed.')
    expect(lines({ check: { reason: 'OPEN_LIMIT', message: 'x' }, count: { open: 4, starts: 4, depth: 0, oldestStartAt: null } })[1])
      .toBe('Can start harnesses: no. You have 4 open, the most. To free a place: harness close <name>')
    expect(lines({ check: { reason: 'MACHINE_LIMIT', message: 'Agents have 40 harnesses running on this machine, the most allowed. Close some first.' } })[1])
      .toBe('Can start harnesses: no. Agents have 40 harnesses running on this machine, the most allowed. Close some first.')
    const rate = buildContext(input({ check: { reason: 'START_RATE', message: 'x' }, count: { open: 0, starts: 20, depth: 0, oldestStartAt: Date.parse('2026-10-15T07:22:00Z') } }))
    expect(formatContext(rate).split('\n')[1]).toMatch(/^Can start harnesses: not until \d\d:\d\d \(20 starts in 10 minutes\)\.$/)
    expect(rate.quota?.nextStartAt).toBe('2026-10-15T07:32:00.000Z')
  })

  it('outside Harness: no pane, nothing can message it', () => {
    const outside = { machineId: 'm', agentId: 'claude-code:abc', name: 'Claude Code', engine: 'claude', outside: true }
    const c = buildContext(input({ caller: outside }))
    expect(formatContext(c).split('\n')[0]).toBe('You: Claude Code, outside Harness, on Mac Auto. Nothing can message you here.')
    expect(c.caller).toMatchObject({ kind: 'agent', agent: 'Claude Code', name: null, id: null, inside: false })
  })

  it('a pane whose harness is gone: may only look', () => {
    expect(lines({ caller: null, orphan: true, count: null })).toEqual([
      'You: an agent in a Harness pane whose harness is gone, on Mac Auto.',
      'Can start harnesses: no. This pane\'s harness is no longer running. Only the person can start or close harnesses here.',
    ])
  })

  it('the person: one line, no limits', () => {
    const c = buildContext(input({ caller: null, count: null }))
    expect(formatContext(c)).toBe('You: the person, on Mac Auto.')
    expect(c).toMatchObject({ caller: { kind: 'person' }, canStart: null, quota: null })
  })

  it('keeps line 1 one line for an odd name, and line 3 short for many machines', () => {
    const odd = { ...lead, name: `a "quoted"\nname ${'x'.repeat(200)}` }
    const first = lines({ caller: odd })[0]
    expect(first).not.toContain('\n')
    expect(first.length).toBeLessThan(120)
    const ten = Array.from({ length: 10 }, (_, i) => ({ machineId: `o${i}`, label: `box${i}`, status: 'running', current: false }))
    expect(lines({ machines: ten })[2]).toBe('Yours: 1 open of 4 · 3 of 20 starts in the last 10 minutes · other machines: box0 (running), box1 (running), box2 (running), box3 (running), +6 more')
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd cli && npx vitest run src/agentClient/context.spec.ts`
Expected: FAIL: `buildContext` is not exported.

- [ ] **Step 3: Implement**

Append to `cli/src/agentClient/context.ts`:

```ts
import type { NewMachine } from '../lib/newCommand.js'
import { engineName } from '../messages/model.js'
import type { Caller } from './model.js'

export type CanStartReason = 'SIGNED_OUT' | 'SWITCH_OFF' | 'ORPHAN' | SpawnReason

export interface ContextInput {
  /** The agent calling, or null: the person, or what is left of an agent ([orphan]). */
  caller: Caller | null
  orphan: boolean
  /** This machine's name. */
  machine: string
  signedIn: boolean
  /** "Agents can start other agents", as this computer keeps the account's choice. */
  switchOn: boolean
  check: { reason: SpawnReason; message: string } | null
  count: SpawnCount | null
  limits: { livePerHarness: number; perWindow: number; windowMs: number; depth: number }
  /** The account's machines, this one included (marked `current`); empty when they could not be read. */
  machines: readonly NewMachine[]
  /** How this caller closes one of its harnesses: a command, or an MCP tool call. */
  closeStep: string
}

export interface Context {
  caller: { kind: 'agent' | 'person'; agent: string | null; name: string | null; id: string | null; inside: boolean; machine: string }
  /** Null for the person: they are never refused. */
  canStart: { ok: boolean; reason: CanStartReason | null; message: string; fix: string | null; fixBy: 'person' | 'you' | null } | null
  quota: { open: number; maxOpen: number; starts: number; maxStarts: number; windowMinutes: number; depth: number; maxDepth: number; nextStartAt: string | null } | null
  machines: Array<{ name: string; state: string }>
}

const TURN_ON = 'harness settings agents-start-agents on'
const MACHINES_SHOWN = 4
const oneLine = (text: string, max = 40): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function buildContext(i: ContextInput): Context {
  const agent = !!i.caller || i.orphan
  const caller: Context['caller'] = {
    kind: agent ? 'agent' : 'person',
    agent: i.caller ? (i.caller.outside ? i.caller.name : engineName(i.caller.engine)) : null,
    name: i.caller && !i.caller.outside ? i.caller.name : null,
    id: i.caller && !i.caller.outside ? i.caller.agentId : null,
    inside: !i.caller?.outside,
    machine: i.machine,
  }
  const machines = i.machines.filter((m) => !m.current).map((m) => ({ name: m.label, state: m.status }))
  if (!agent) return { caller, canStart: null, quota: null, machines }
  const quota = i.caller && i.count ? {
    open: i.count.open, maxOpen: i.limits.livePerHarness, starts: i.count.starts, maxStarts: i.limits.perWindow,
    windowMinutes: Math.round(i.limits.windowMs / 60_000), depth: i.count.depth, maxDepth: i.limits.depth,
    nextStartAt: i.count.starts >= i.limits.perWindow && i.count.oldestStartAt !== null ? new Date(i.count.oldestStartAt + i.limits.windowMs).toISOString() : null,
  } : null
  const no = (reason: CanStartReason, message: string, fix: string | null = null, fixBy: 'person' | 'you' | null = null) =>
    ({ ok: false, reason, message, fix, fixBy })
  const canStart: NonNullable<Context['canStart']> =
    i.orphan && !i.caller ? no('ORPHAN', 'This pane\'s harness is no longer running. Only the person can start or close harnesses here.', null, 'person')
    : !i.signedIn ? no('SIGNED_OUT', 'This computer is signed out of Harness, and starting is the account\'s choice.', `harness login, then ${TURN_ON}`, 'person')
    : !i.switchOn ? no('SWITCH_OFF', 'The person has not turned on "Agents can start other agents".', TURN_ON, 'person')
    : i.check?.reason === 'DEPTH' ? no('DEPTH', 'An agent started you, and only one level is allowed. Do the work yourself, or say in your answer what else is needed.')
    : i.check?.reason === 'OPEN_LIMIT' ? no('OPEN_LIMIT', `You have ${quota?.open ?? i.limits.livePerHarness} open, the most.`, i.closeStep, 'you')
    : i.check?.reason === 'MACHINE_LIMIT' ? no('MACHINE_LIMIT', i.check.message)
    : i.check?.reason === 'START_RATE' ? no('START_RATE', `${i.limits.perWindow} starts in ${Math.round(i.limits.windowMs / 60_000)} minutes.`, null, 'you')
    : { ok: true, reason: null, message: '', fix: null, fixBy: null }
  return { caller, canStart, quota, machines }
}

const hhmm = (iso: string): string => new Date(iso).toTimeString().slice(0, 5)

export function formatContext(c: Context): string {
  const who = c.caller.kind === 'person' ? `You: the person, on ${c.caller.machine}.`
    : !c.caller.agent ? `You: an agent in a Harness pane whose harness is gone, on ${c.caller.machine}.`
    : c.caller.inside ? `You: ${c.caller.agent} "${oneLine(c.caller.name ?? '')}" (${(c.caller.id ?? '').slice(0, 8)}), inside Harness, on ${c.caller.machine}.`
    : `You: ${c.caller.agent}, outside Harness, on ${c.caller.machine}. Nothing can message you here.`
  if (!c.canStart) return who
  const s = c.canStart
  const can = s.ok ? 'Can start harnesses: yes.'
    : s.reason === 'START_RATE' && c.quota?.nextStartAt ? `Can start harnesses: not until ${hhmm(c.quota.nextStartAt)} (${s.message.replace(/\.$/, '')}).`
    : `Can start harnesses: no. ${s.message}${s.fix ? ` ${s.fixBy === 'person' ? (s.reason === 'SWITCH_OFF' ? 'Ask them to run' : 'Ask the person to run') : 'To free a place'}: ${s.fix}` : ''}`
  if (!c.quota) return [who, can].join('\n')
  const shown = c.machines.slice(0, MACHINES_SHOWN).map((m) => `${oneLine(m.name, 24)} (${m.state})`)
  const more = c.machines.length > MACHINES_SHOWN ? [`+${c.machines.length - MACHINES_SHOWN} more`] : []
  const others = shown.length ? ` · other machines: ${[...shown, ...more].join(', ')}` : ''
  return [who, can, `Yours: ${c.quota.open} open of ${c.quota.maxOpen} · ${c.quota.starts} of ${c.quota.maxStarts} starts in the last ${c.quota.windowMinutes} minutes${others}`].join('\n')
}
```

Keep the two type exports from Task 5 at the top of the file, and move the three `import` lines above them.

- [ ] **Step 4: Run it to see it pass**

Run: `cd cli && npx vitest run src/agentClient/context.spec.ts && npm run typecheck`
Expected: PASS, 8 tests; typecheck clean.

- [ ] **Step 5: Commit** (ask first)

```bash
git add cli/src/agentClient/context.ts cli/src/agentClient/context.spec.ts
git commit -m "The context block: who and where an agent is, whether it may start harnesses, and its counts"
```

### Task 7: `harness whoami`

**Files:**
- Modify: `cli/src/agentClient/commands.ts` (new `WHOAMI_USAGE`, `contextFor`, `machinesForContext`, `whoamiCommand`; `ClientDeps.contextMachinesMs`)
- Modify: `cli/src/cli.ts` (dispatch, about line 2542; help text, the line `harness ps [--all]           the harnesses here…`)
- Test: `cli/src/agentClient/commands.spec.ts`

**Interfaces:**
- Consumes: `buildContext`, `formatContext`, `Context` (Task 6); `spawnCheck`, `spawnCount` (Task 5); `readAgentSettings` (already imported); `readAuthSession` from `../lib/authSession.js`.
- Produces: `whoamiCommand(argv: readonly string[], deps?: ClientDeps): Promise<number>`; `WHOAMI_USAGE`; internal `contextFor(s: Setup, o: Opened): Promise<Context>` used by Task 8.

- [ ] **Step 1: Write the failing tests**

Add to `commands.spec.ts` (import `whoamiCommand` from `./commands.js`):

```ts
describe('harness whoami', () => {
  const office = { machineId: 'o', label: 'office', status: 'running', current: false }

  it('tells an agent in a pane who and where it is, that it may start, and its counts', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    const h = harness(d, { machines: async () => [office] })
    started(h.ledger, 'lead', 'kid')
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toBe([
      'You: Claude Code "lead" (lead), inside Harness, on studio.',
      'Can start harnesses: yes.',
      'Yours: 1 open of 4 · 1 of 20 starts in the last 10 minutes · other machines: office (running)',
    ].join('\n'))
    expect(d.closed).toBe(true)
  })

  it('says the switch is off, and gives the context as JSON', async () => {
    setAgentSettingsForTest(dir, { agentsStartAgents: false })
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d)
    expect(await whoamiCommand(['--json'], h.deps)).toBe(EXIT.ok)
    const { context } = JSON.parse(h.out.join('\n'))
    expect(context.canStart).toEqual({ ok: false, reason: 'SWITCH_OFF', message: 'The person has not turned on "Agents can start other agents".', fix: 'harness settings agents-start-agents on', fixBy: 'person' })
    expect(context.machines).toEqual([])
  })

  it('signed out: says to sign in first, and lists no machines', async () => {
    signedOutForTest()
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d, { machines: async () => { throw new AgentClientError('MACHINES_UNAVAILABLE', 'no') } })
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n').split('\n')[1]).toMatch(/^Can start harnesses: no\. This computer is signed out of Harness/)
    expect(h.out.join('\n')).not.toContain('other machines')
  })

  it('does not wait long for the account\'s machines', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d, { machines: () => new Promise(() => {}), contextMachinesMs: 5 })
    const t0 = Date.now()
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.ok)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(h.out.join('\n')).not.toContain('other machines')
  })

  it('says why when Harness cannot be reached, as ps does', async () => {
    const h = harness(new FakeDaemon(), { open: async () => { throw new AgentClientError('DAEMON_UNREACHABLE', 'Harness is not running here.') } })
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.failed)
    expect(h.err).toEqual(['Harness is not running here.'])
  })

  it('takes no names and no --machine', async () => {
    const h = harness(new FakeDaemon())
    expect(await whoamiCommand(['x'], h.deps)).toBe(EXIT.usage)
    expect(h.err[0]).toBe('harness whoami takes no names and no --machine: it is about you, here.')
  })
})
```

`signedOutForTest` and `setAgentSettingsForTest` are already imported by the spec. Check how
`setAgentSettingsForTest` signs in (`cli/src/testing/agentSettings.ts`): if the switch test above needs a signed-in
session for "off" to read as `SWITCH_OFF` rather than `SIGNED_OUT`, keep its sign-in and set only the switch.

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts -t "whoami"`
Expected: FAIL: `whoamiCommand` is not exported.

- [ ] **Step 3: Implement**

In `commands.ts`:

```ts
import { readAuthSession } from '../lib/authSession.js'
import { buildContext, formatContext, type Context, type SpawnCount, type SpawnReason } from './context.js'
```

Add to `ClientDeps`:

```ts
  /** How long the context block waits for the account's machines (2 s); tests shorten it. */
  contextMachinesMs?: number
```

and in `setup()`: `contextMachinesMs: deps.contextMachinesMs ?? 2_000,`.

After `CLOSE_USAGE`:

```ts
export const WHOAMI_USAGE = `Usage: harness whoami [--json]

Who you are to Harness: which agent, on which machine, inside Harness or not; whether you may start harnesses now
and, if not, who can change that; how many of yours are open, and how many starts are left.`
```

After `openNote`:

```ts
/** The account's machines for the context block, or none: the block never holds a verb up (2 s at most). */
async function machinesForContext(s: Setup): Promise<NewMachine[]> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([s.machines(), new Promise<NewMachine[]>((done) => { timer = setTimeout(() => done([]), s.contextMachinesMs); timer.unref?.() })])
  } catch { return [] } finally { clearTimeout(timer) }
}

/** Where the caller is and what it may do (context.ts), from what `opened` read: this machine's live harnesses only,
 *  so it costs no other machine a question; `new` still counts the other machines' exactly. */
async function contextFor(s: Setup, o: Opened): Promise<Context> {
  const live = new Set(o.frames.filter((f) => f.status === 'active').map((f) => memberKey(o.where.machineId, f.id)))
  const waiting = o.asked.filter((a) => a.state !== 'failed').map((a) => a.row)
  const caller = o.caller
  return buildContext({
    caller, orphan: o.orphan, machine: o.machine,
    signedIn: !!readAuthSession(), switchOn: readAgentSettings(o.where.dataDir).agentsStartAgents,
    check: caller ? spawnCheck(caller, live, o.ledger, o.where.machineId, s.now(), waiting) : null,
    count: caller ? spawnCount(caller, live, o.ledger, s.now(), waiting) : null,
    limits: SPAWN_LIMITS, machines: await machinesForContext(s), closeStep: step(s.env, 'close', '<name>'),
  })
}

// ── whoami ─────────────────────────────────────────────────────────────────────────────────────────

export function whoamiCommand(argv: readonly string[], deps: ClientDeps = {}): Promise<number> {
  return run(WHOAMI_USAGE, deps, wantsJson, argv, async (s) => {
    const { names, flags, machine } = words(argv, { '--json': 'flag' })
    if (names.length || machine !== null) throw new UsageError('harness whoami takes no names and no --machine: it is about you, here.')
    const o = await opened(s)
    try {
      const context = await contextFor(s, o)
      s.out(flags.has('--json') ? JSON.stringify({ context }, null, 1) : formatContext(context))
      return EXIT.ok
    } finally { o.daemon.close() }
  })
}
```

`memberKey`, `SPAWN_LIMITS`, `spawnCheck` and `spawnCount` are declared lower in the file; they are used only when
the functions run, so the order is fine. If `readAuthSession` is not the name in `cli/src/lib/authSession.ts`, use the
function `agentSettings.ts` imports from there.

In `cli/src/cli.ts`, import `whoamiCommand` with the other agent client commands, and add beside `case 'ps':`:

```ts
  case 'whoami':
    whoamiCommand(rest, { machines: ownedMachines }).then(code => { process.exitCode = code }).catch(onError)
    break
```

In the help text, add above the `harness ps [--all]` line, in its column layout:

```
  harness whoami               who you are to Harness: which agent, which machine, whether you may start harnesses
```

- [ ] **Step 4: Run the specs and typecheck**

Run: `cd cli && npx vitest run src/agentClient src/lib/newCommand.spec.ts src/architecture.spec.ts && npm run typecheck`
Expected: PASS; typecheck clean. (`architecture.spec.ts` checks module boundaries: `context.ts` imports only
`lib`, `messages` and `agentClient` modules, as `commands.ts` already does.)

- [ ] **Step 5: Commit** (ask first)

```bash
git add cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts cli/src/cli.ts
git commit -m "harness whoami: who an agent is, where, whether it may start harnesses, and its counts"
```

### Task 8: The block at the top of an agent's `ps`, and in its JSON

**Files:**
- Modify: `cli/src/agentClient/commands.ts` (`formatRows`, `psCommand`)
- Modify: `cli/src/agentClient/commands.spec.ts` (lines with `You are`, about 99 and 134)
- Modify: `cli/e2e/agentClient.e2e.ts` (lines with `You are`, about 122, 320 and 426)

**Interfaces:**
- Consumes: `contextFor`, `formatContext` (Task 7).
- Produces: `formatRows(rows: Row[], now: number, on?: string): string` (the `caller` parameter is gone). `ps --json` gains `context`.

- [ ] **Step 1: Change the tests first**

In `commands.spec.ts`, the test "lists the harnesses here: who you are, …": replace the first `toMatch` with

```ts
    expect(text).toMatch(/^You: Claude Code "lead" \(lead\), inside Harness, on studio\.\nCan start harnesses: yes\.\nYours: 1 open of 4 · 1 of 20 starts in the last 10 minutes\nNAME +AGENT +STATE +STARTED BY +ACTIVE +FOLDER/)
```

At about line 134, replace `'You are Claude Code, outside Harness.'` with
`'You: Claude Code, outside Harness, on studio. Nothing can message you here.'`.

Add:

```ts
  it('gives the context in its JSON, and leaves a person\'s ps as it was', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('theirs')]
    const h = harness(d)
    expect(await psCommand(['--json'], h.deps)).toBe(EXIT.ok)
    const listed = JSON.parse(h.out.join('\n'))
    expect(listed.context.caller).toMatchObject({ kind: 'agent', name: 'lead', machine: 'studio' })
    expect(listed.you).toBe('lead')
    const person = harness(d, { pane: undefined })
    expect(await psCommand([], person.deps)).toBe(EXIT.ok)
    expect(person.out.join('\n')).toMatch(/^NAME +AGENT/)
  })
```

In `cli/e2e/agentClient.e2e.ts`: line ~122 `toMatch(/^You are "lead" \(/)` → `toMatch(/^You: Claude Code "lead" \(/)`;
line ~320 `'You are Claude Code, outside Harness.'` → `toMatch(/^You: Claude Code, outside Harness, on .+\. Nothing can message you here\.$/)`;
line ~426 `'You are Cursor, outside Harness.'` → `toMatch(/^You: Cursor, outside Harness, on .+\. Nothing can message you here\.$/)`.
(Use `toMatch` on the first line where the old code used `toBe`.)

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts -t "harness ps"`
Expected: FAIL: the text still begins `You are "lead"`, and JSON has no `context`.

- [ ] **Step 3: Implement**

`formatRows`: remove the `caller` parameter and the `you` line:

```ts
export function formatRows(rows: Row[], now: number, on = 'this machine'): string {
  if (!rows.length) return `No harnesses on ${on}.`
  // … the width, head and lines as they are …
  return [head, ...lines].join('\n')
}
```

In `psCommand`, after `const note = …`:

```ts
      // An agent is told where it is and what it may do before the list; a person's ps is as it was.
      const context = await contextFor(s, o)
      const block = o.caller || o.orphan ? formatContext(context) : null
      s.out(flags.has('--json') ? JSON.stringify({ you: o.caller ? o.caller.name : null, machine: on.machine, context, harnesses: rows }, null, 1)
        : [block, formatRows(rows, s.now(), away ? away.label : undefined), note].filter(Boolean).join('\n'))
```

Run `git grep -n "formatRows(" cli/src` and update any other caller to the new signature.

- [ ] **Step 4: Run the specs, typecheck, and the end to end file**

Run: `cd cli && npx vitest run src/agentClient src/lib/newCommand.spec.ts && npm run typecheck`
Expected: PASS.

Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts`
Expected: as on main: 10 of 11, the one known failure ("an agent is told, not left waiting, when Claude Code or Codex
would ask the person to trust its folder", `expected 124 to be 3`) fails the same way; every `You:` line passes.

- [ ] **Step 5: Commit** (ask first)

```bash
git add cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts cli/e2e/agentClient.e2e.ts
git commit -m "An agent's harness ps begins with where it is and what it may do; its JSON gives the context"
```

### Task 9: MCP: `harness_whoami`, and the block in the instructions

**Files:**
- Modify: `cli/src/agentClient/mcp.ts` (`TOOLS`, `INSTRUCTIONS`, `initialize`, `McpDeps`)
- Modify: `cli/src/engines/facets/hooks.ts` (`HARNESS_AGENT_TOOLS`)
- Modify: `cli/packages/harness-mcp/mcpb/manifest.json` (`tools`)
- Test: `cli/src/agentClient/mcp.spec.ts`

**Interfaces:**
- Consumes: the `harness whoami` verb (Task 7).
- Produces: tool `harness_whoami` (no arguments, read-only); `HARNESS_AGENT_TOOLS.whoami = 'harness_whoami'`; `McpDeps.whoamiMs?: number`.

- [ ] **Step 1: Change and add the tests**

In "answers initialize …", pass a runner whose `whoami` fails, so the plain instructions stay what it checks:
replace the first `deps()` in that test with `deps({ run: runner({ code: 1, out: '' }).run })`.

In "lists send only to a harness in its own pane …":

```ts
    expect(outside.map((t) => t.name)).toEqual(['harness_whoami', 'harness_list', 'harness_start', 'harness_wait', 'harness_read', 'harness_close'])
```

Add:

```ts
  it('begins its instructions with who the agent is right now, from harness whoami', async () => {
    const r = runner({ out: 'You: Codex, outside Harness, on studio. Nothing can message you here.\nCan start harnesses: yes.\n' })
    const got = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } } }, deps({ run: r.run }))
    expect(r.calls.map((c) => c.argv)).toEqual([['whoami']])
    expect(r.calls[0].env.AI_AGENT).toBe('codex')
    expect((got!.result as { instructions: string }).instructions)
      .toBe(`Right now:\nYou: Codex, outside Harness, on studio. Nothing can message you here.\nCan start harnesses: yes.\n\n${INSTRUCTIONS}`)
  })

  it('connects with the plain instructions when whoami fails or is slow', async () => {
    const failed = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, deps({ run: runner({ code: 1, out: '' }).run }))
    expect((failed!.result as { instructions: string }).instructions).toBe(INSTRUCTIONS)
    const slow = await answer({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, deps({ run: () => new Promise(() => {}), whoamiMs: 5 }))
    expect((slow!.result as { instructions: string }).instructions).toBe(INSTRUCTIONS)
  })

  it('offers harness_whoami as a read-only tool that runs harness whoami', async () => {
    const r = runner()
    await answer(call('harness_whoami'), deps({ run: r.run }))
    expect(r.calls[0].argv).toEqual(['whoami'])
    expect(TOOLS.find((t) => t.name === 'harness_whoami')?.annotations).toEqual({ readOnlyHint: true })
    expect(INSTRUCTIONS).toContain('harness_whoami')
  })
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/agentClient/mcp.spec.ts`
Expected: FAIL: no `harness_whoami`, and the instructions are not prefixed.

- [ ] **Step 3: Implement**

`mcp.ts`, first entry of `TOOLS`:

```ts
  {
    name: 'harness_whoami',
    description: 'Who you are to Harness: which agent, on which machine, inside Harness or not; whether you may start harnesses now and, if not, who can change that; how many of yours are open and how many starts are left. Call it first, and whenever a start is refused.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
    argv: () => ['whoami'],
  },
```

`INSTRUCTIONS`: begin its third paragraph with `Call harness_whoami first: it says whether you may start harnesses now. Then list (harness_list).`
replacing `List first (harness_list).`

`McpDeps`: add

```ts
  /** How long `initialize` waits for `harness whoami` before it answers without it. */
  whoamiMs?: number
```

`initialize` case, after `state.client = …`:

```ts
      // Where the agent is and what it may do, as it connects: the same block `harness whoami` prints. Never held up:
      // without it in time, the instructions alone.
      const here = await Promise.race([
        deps.run(['whoami'], callerEnv(deps, state.client)).catch(() => null),
        new Promise<null>((done) => { const t = setTimeout(() => done(null), deps.whoamiMs ?? 5_000); t.unref?.() }),
      ])
      const now = here && here.code === EXIT.ok && here.out.trim() ? `Right now:\n${here.out.trim()}\n\n` : ''
```

and `instructions: \`${now}${INSTRUCTIONS}\``.

`cli/src/engines/facets/hooks.ts`:

```ts
export const HARNESS_AGENT_TOOLS = {
  whoami: 'harness_whoami', ps: 'harness_list', show: 'harness_read', wait: 'harness_wait', new: 'harness_start', close: 'harness_close', send: 'harness_send',
} as const
```

`cli/packages/harness-mcp/mcpb/manifest.json`, first entry of `"tools"`:

```json
    {
      "name": "harness_whoami",
      "description": "Who you are to Harness: which agent, on which machine, whether you may start harnesses now and who can change that, and how much of your limit is left."
    },
```

- [ ] **Step 4: Run the specs that read these lists**

Run: `cd cli && npx vitest run src/agentClient src/engines/kit/hookSettings.spec.ts && npm run typecheck`
Expected: PASS. (`hookSettings.spec.ts` builds its expected rules from `HARNESS_AGENT_VERBS`, so `whoami` is allowed
without a permission question in Claude Code and Codex like the other verbs.)

Run: `cd website && npx vitest run scripts/listings.spec.ts`
Expected: PASS ("the bundle's manifest … lists the tools harness mcp serves").

- [ ] **Step 5: Commit** (ask first)

```bash
git add cli/src/agentClient/mcp.ts cli/src/agentClient/mcp.spec.ts cli/src/engines/facets/hooks.ts cli/packages/harness-mcp/mcpb/manifest.json
git commit -m "harness mcp: harness_whoami, and the instructions begin with where the agent is"
```

### Task 10: The pages agents read teach `whoami` first

**Files:**
- Modify: `plugins/harness/skills/harness/SKILL.md`, `website/public/llms.txt`, `website/public/agents/index.html`, `docs/cli.md`, `docs/design/2026-10-11-agent-client.md`, `docs/research/2026-10-11-listing-submissions.md`
- Modify: `website/scripts/agents-site.spec.ts` (`AGENT_VERBS`)

**Interfaces:**
- Consumes: `harness whoami`, `harness_whoami` (Tasks 7, 9).

- [ ] **Step 1: Make the check require it**

In `agents-site.spec.ts`: `const AGENT_VERBS = ["whoami", "ps", "new", "wait", "show", "send", "close"];` and add to
`usageSources`: `whoami: ["cli/src/agentClient/commands.ts", "WHOAMI_USAGE"],`.

- [ ] **Step 2: Run it to see it fail**

Run: `cd website && npx vitest run scripts/agents-site.spec.ts -t "teaches every agent command"`
Expected: FAIL for all three pages: `harness whoami`.

- [ ] **Step 3: Edit the pages**

`SKILL.md`:
- "## New harness or an existing one", item 1 becomes: ``1. Start with `harness whoami`: who you are, whether you may start harnesses now (and if not, who can change that), and how many of yours are open. Then list: `harness ps`. It shows the harnesses here: state, who started each (`you` for yours), and what each is about.``
- "## The verbs", first line of the block: `harness whoami                                      # who and where you are, whether you may start harnesses, your limits`
- "## Inside a harness, or outside", "Outside Harness" bullet: replace ``Harness tells you by your session. `harness ps` says "You are Claude Code, outside Harness." and marks`` with ``Harness tells you by your session. `harness whoami` (and the top of `harness ps`) says "You: Claude Code, outside Harness, on <machine>." and `harness ps` marks``.
- "## Harness's MCP tools": add `harness_whoami` (whoami) before `harness_list` (ps).

`llms.txt`:
- The commands block, first line: `harness whoami                                      # who and where you are, whether you may start harnesses, your limits`
- The MCP sentence: `harness_whoami, harness_list, harness_start, …`
- In the long rules paragraph, `List first, name every harness,` becomes `Run harness whoami first, then list; name every harness,`.

`agents/index.html`:
- In "The commands" table, before the `harness ps [--all]` row:
  `<tr><td><code>harness whoami</code></td><td>Who you are to Harness: which agent, on which machine, inside Harness or not; whether you may start harnesses now and, if not, who can change that; how many of yours are open. Run it first.</td></tr>`
- In "MCP tools", before the `harness_list` row:
  `<tr><td><code>harness_whoami</code></td><td>none</td><td><code>harness whoami</code></td></tr>`
- In "Inside a harness, or outside Harness", the sentence quoting `harness ps` saying "You are Claude Code, outside
  Harness." quotes `harness whoami` saying "You: Claude Code, outside Harness, on &lt;machine&gt;." instead.

`docs/cli.md`: add a `harness whoami` entry beside `harness ps`, in the format the `ps` entry uses, with the three
lines of the block as its example.

`docs/design/2026-10-11-agent-client.md`, "The agent's side" block, first line:
`harness whoami                                      # who and where you are, whether you may start, your limits`.

`docs/research/2026-10-11-listing-submissions.md`, the tools table, first row:
``| `harness_whoami` | who the agent is, on which machine, whether it may start harnesses now, and its limits |``.

- [ ] **Step 4: Run the website checks**

Run: `cd website && npx vitest run scripts/agents-site.spec.ts scripts/listings.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit** (ask first)

```bash
git add plugins/harness/skills/harness/SKILL.md website/public/llms.txt website/public/agents/index.html website/scripts/agents-site.spec.ts docs/cli.md docs/design/2026-10-11-agent-client.md docs/research/2026-10-11-listing-submissions.md
git commit -m "The pages agents read teach harness whoami first"
```

### Task 11: Check it as an agent would, then measure

- [ ] **Step 1: Build and try it from a real pane** (no harness is started)

Run: `cd cli && npm run build` (or the repository's usual local build), then from a Claude Code pane in Harness:
`node cli/dist/cli.js whoami`, `node cli/dist/cli.js whoami --json`, `node cli/dist/cli.js ps | head -5`.
Expected: the three lines with this machine's real name and the account's real switch; JSON with `context`; `ps`
beginning with the block. From a plain terminal (the person): `whoami` prints `You: the person, on <machine>.` and
`ps` begins with `NAME`.

- [ ] **Step 2: MCP, with a real client** (no harness is started)

Run: `claude -p "Call harness_whoami and print what it says, nothing else." --mcp-config '{"mcpServers":{"harness":{"command":"node","args":["<repo>/cli/dist/cli.js","mcp"]}}}' --allowedTools mcp__harness__harness_whoami`
Expected: the block, beginning `You: Claude Code, outside Harness, on <machine>.`

- [ ] **Step 3: Rerun the eval (with the person's approval)**

Same cases and agents as the phase 2 baseline, on this branch's CLI. Put both summary lines (before and after) in
the pull request. Expected: fewer orientation calls and no retries after a refusal in `switch-off` and `five-at-once`.

- [ ] **Step 4: Full checks before the pull request**

Run: `cd cli && npx vitest run src/agentClient src/lib/newCommand.spec.ts src/engines/kit/hookSettings.spec.ts src/architecture.spec.ts && npm run typecheck`
and `cd website && npx vitest run scripts/agents-site.spec.ts scripts/listings.spec.ts`.
Expected: PASS. Record what ran in the pull request (AGENTS.md: PR CI runs only the Linux unit checks).

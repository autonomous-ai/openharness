# Harness for agents: phases 4, 5, 7 and 8, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent verb ends with what changed and what to run next, refusals are told apart by their exit code,
an agent reads less (`ps` capped, `harness help agents`), and MCP clients get the same facts as structured data.

**Architecture:** A pure module `cli/src/agentClient/next.ts` holds the one shape every verb answers with
(`NextStep`, `formatNext`) and the agents' help text. Each verb builds its `Next` from what it already knows and
prints it last; `--json` carries the same as `effect` and `next` fields. Refusals keep their messages and exit 5.
Under `harness mcp` each verb also prints its JSON on one marked line, which `mcp.ts` moves into `structuredContent`.

**Tech Stack:** TypeScript (Node, ESM), vitest, the existing agent client (`cli/src/agentClient/`), `harness new`
(`cli/src/lib/newCommand.ts`), `harness send` (`cli/src/messages/command.ts`).

**Spec:** `docs/design/2026-10-15-agent-experience.md`: parts 2, 3, 4 and 6; phases 4, 5, 7 and 8. Builds on the
phases 1 to 3 plan (`docs/plans/2026-10-15-001-agent-experience-plan.md`), already on `feat/agent-first-glance`.

## Scope

| Phase | In this plan | Left out, and why |
|---|---|---|
| 4 Result, effect, Next | all verbs: `new`, `ps`, `show`, `wait`, `close`, `send` | `new`'s "already running/starting" answer keeps its text: it already names the command and says not to start again |
| 5 States and exit codes | `needs the person` in text, `needsPerson` in JSON, refusals exit 5 with `code`/`reason`/`next` | `signed-out` is phase 6 (its own plan: detection needs research) |
| 7 Less to read | agent `ps` order and 15-row cap, `harness help agents`, `--help` first lines | `harness machines` columns: the reachability column needs each machine's Harness version, which no list has (phase 9's older-Harness check) |
| 8 MCP | none in this run | the person narrowed the run to agents using the CLI; Tasks 9 and 10 stay written for later |
| 10 Publishing | none | the `.mcpb` runs `npx @autonomous-ai/harness-mcp`, which is unpublished: attaching it to releases now ships a broken bundle. Needs the owner's npm step first |

## Global Constraints

- Branch `feat/agent-next-steps`, stacked on `feat/agent-first-glance`, in the worktree `../ah-agent-first-glance`.
  Base on that branch until phases 1 to 3 are merged, then rebase on `main`.
- Ask the person before the first commit on this branch, and before any push or pull request.
- Plain words (`docs/naming-system.md`). Examples in docs and help use placeholders: `<agent>`, `<name>`,
  `<machine>`, `<task>`, `<project>`, never real names.
- `--json` only gains fields: nothing renamed, removed or retyped. `needs-input` stays in JSON. Where the spec writes
  `{"error": {"code": …}}`, the existing `error` field keeps its type and `code`, `reason`, `next` are added beside it.
- A person's text is unchanged, except `close`'s and `show`'s first line (shared by both) and `needs the person`.
  Only agents get `Next` from `new` and `ps`.
- `Next` names only what the caller may run: never `close` for a harness it did not start.
- Done is said only by `wait` and `show`: `new` says `starting`, `send` says `sent`.
- One format everywhere: `Next: <command>  (<when>)`, further options as `  or: <command>  (<when>)`; a step with no
  command is `Next: <what to do>`. Under MCP the command is the tool call (`step()`).
- Exit codes: 0 ok, 1 failed, 2 usage, 3 needs the person, 4 stopped or gone, 5 refused, 124 timed out. Refused codes:
  `SPAWN_LIMIT`, `TURNED_OFF`, `NOT_YOURS`.
- No core or daemon change. No new limits or permissions.
- Test commands: `cd cli && npx vitest run <files>`; `cd cli && npm run typecheck`; `cd website && npx vitest run scripts/agents-site.spec.ts`.
- The CLI end to end (`cli/e2e/agentClient.e2e.ts`) runs once, in the last task.

## Review Focus

1. **A harness name with spaces or a sentence as its name** (an unnamed harness titled by its session). Expected:
   every `Next` command still runs as printed: the name quoted, or the id's start (`addressOf`). Test in Task 1.
2. **Under MCP with `machine` given to `harness_start`.** Expected: `Next` names `harness_wait (names: "<name>")`
   with no `--machine` inside the tool's argument. Test in Task 4.
3. **A JSON reader of today's output** (an eval script, a person's script). Expected: every field it read is still
   there with the same type. Test in Tasks 2, 3, 6 (each `--json` test checks an old field beside the new ones).
4. **An agent with 40 harnesses on the machine and 2 of its own idle among the oldest.** Expected: its own two are in
   the 15 rows `ps` shows, and the last line says how many more. Test in Task 7.
5. **An agent's `--help` when it is a person in a plain terminal with no agent variables.** Expected: only the one
   added first line, the rest of the help unchanged. Test in Task 8.

---

## Phase 4: every verb answers with result, effect and Next

### Task 1: The Next shape, and `show`

**Files:**
- Create: `cli/src/agentClient/next.ts`, `cli/src/agentClient/next.spec.ts`
- Modify: `cli/src/agentClient/commands.ts` (`showCommand`, `closeHint`)
- Test: `cli/src/agentClient/commands.spec.ts` (the `harness show` group)

**Interfaces:**
- Produces: `type NextStep = { run: string; when: string } | { tell: string }`; `formatNext(steps: readonly NextStep[]): string | null`
  (null for none). Every later task prints with it.

- [ ] **Step 1: Write the failing tests for the format**

`cli/src/agentClient/next.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatNext } from './next.js'

describe('Next', () => {
  it('says one step on one line, with when to take it', () => {
    expect(formatNext([{ run: 'harness wait <name>', when: 'until it has answered' }])).toBe('Next: harness wait <name>  (until it has answered)')
  })
  it('gives the other steps as "or"', () => {
    expect(formatNext([{ run: 'harness show <name>', when: 'to read its answer' }, { run: 'harness wait <name>', when: 'until it stops working' }]))
      .toBe('Next: harness show <name>  (to read its answer)\n  or: harness wait <name>  (until it stops working)')
  })
  it('says a step that is not a command as it is', () => {
    expect(formatNext([{ tell: 'tell the person; only they answer it (a question or a permission).' }]))
      .toBe('Next: tell the person; only they answer it (a question or a permission).')
  })
  it('says nothing when there is nothing next', () => {
    expect(formatNext([])).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd cli && npx vitest run src/agentClient/next.spec.ts`
Expected: FAIL, `Failed to resolve import "./next.js"`.

- [ ] **Step 3: Write `next.ts`**

```ts
/**
 * What every agent verb ends with (docs/design/2026-10-15-agent-experience.md, part 2): the step to take next, and
 * when to take it, so an agent is never left to guess. `--json` carries the same steps as `next`.
 */

/** A command to run and when to pick it, or something only words can say ("tell the person …"). */
export type NextStep = { run: string; when: string } | { tell: string }

/** `Next: <command>  (<when>)`, then `  or: …` for the other choices; null when there is nothing next. */
export function formatNext(steps: readonly NextStep[]): string | null {
  if (!steps.length) return null
  return steps.map((step, i) => `${i ? '  or:' : 'Next:'} ${'run' in step ? `${step.run}  (${step.when})` : step.tell}`).join('\n')
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `cd cli && npx vitest run src/agentClient/next.spec.ts`
Expected: 4 passed.

- [ ] **Step 5: Write the failing `show` tests**

In `commands.spec.ts`, in `describe('harness show', …)`, add:

```ts
  it('starts with the result and ends with Next: close for its own idle harness', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    d.pages.set('s-kid', [{ events: [ev('user_message', { text: 'review it' }), ev('assistant_message', { text: 'One bug.' })], hasMore: false }])
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    expect(await showCommand(['kid'], h.deps)).toBe(EXIT.ok)
    const lines = h.out.join('\n').split('\n')
    expect(lines[0]).toBe('kid on studio: idle · Codex · started by you')
    expect(lines.at(-1)).toBe('Next: harness close kid  (once you have what you need)')
  })

  it('names wait for a working harness, and never close for one the caller did not start', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('busy', { activity: { state: 'working' } }), frame('theirs')]
    d.screens.set('busy', ['working'])
    const h = harness(d)
    started(h.ledger, 'lead', 'busy')
    expect(await showCommand(['busy'], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n').split('\n').at(-1)).toBe('Next: harness wait busy  (until it stops working)')
    const theirs = harness(d)
    expect(await showCommand(['theirs'], theirs.deps)).toBe(EXIT.ok)
    expect(theirs.out.join('\n')).not.toMatch(/harness close/)
  })

  it('says to tell the person when only they can answer, and gives next in JSON', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('asker')]
    d.screens.set('asker', ['needs_input'])
    const h = harness(d)
    started(h.ledger, 'lead', 'asker')
    expect(await showCommand(['asker'], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n').split('\n').at(-1)).toBe('Next: tell the person; only they answer it (a question or a permission).')
    const json = harness(d)
    expect(await showCommand(['asker', '--json'], json.deps)).toBe(EXIT.ok)
    const parsed = JSON.parse(json.out[0])
    expect(parsed.state).toBe('needs-input')
    expect(parsed.next).toEqual([{ tell: 'tell the person; only they answer it (a question or a permission).' }])
  })
```

(`d.screens` values are the daemon's words: `needs_input` reaches `inspect` as `activity`; `FakeDaemon` returns them
as given.)

- [ ] **Step 6: Run them to see them fail**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts -t "harness show"`
Expected: the three new tests FAIL: line 0 is `kid · Codex · studio · idle · started by you`, the last line is
`Close it once you have what you need: harness close kid`, and JSON has no `next`.

- [ ] **Step 7: Change `showCommand`**

In `commands.ts`, import `formatNext, type NextStep` from `./next.js`. Replace `closeHint` with:

```ts
/** What `show` says to do next, from its state and whose it is: never `close` for a harness the caller did not start. */
function showNext(env: NodeJS.ProcessEnv, state: State, yours: boolean, at: string): NextStep[] {
  if (state === 'needs-input') return [{ tell: 'tell the person; only they answer it (a question or a permission).' }]
  if (state === 'working' || state === 'unknown' || state === 'starting' || state === 'installing') return [{ run: step(env, 'wait', at), when: 'until it stops working' }]
  if (state === 'idle' && yours) return [{ run: step(env, 'close', at), when: 'once you have what you need' }]
  return []
}
```

In `showCommand`, compute `const at = onAway(addressOf({ machineId: '', agentId: t.frame.id, name: t.frame.name ?? '', engine: '' }), away)`
and `const next = showNext(s.env, state, t.yours, at)`; add `next` to `result` (after `tools`). Change the text so:
- the first line is `` `${result.name} on ${t.machine}: ${state} · ${result.agent} · started by ${startedBy}` ``;
- the `It is waiting for the person …` line and the `closeHint` line are removed;
- the last line is `formatNext(next)` when it is not null.

- [ ] **Step 8: Run the show group, fix what the change was meant to change**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts -t "harness show"`
Expected: the new tests pass. Older assertions on `· studio ·` first lines, on `It is waiting for the person`, or on
`Close it once you have what you need` fail; change each to the new line, and nothing else.

- [ ] **Step 9: Commit**

```bash
git add cli/src/agentClient/next.ts cli/src/agentClient/next.spec.ts cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts
git commit -m "harness show starts with its result and ends with Next"
```

### Task 2: `wait` gives each harness's Next in JSON, and `gone` gets one

**Files:**
- Modify: `cli/src/agentClient/commands.ts` (`waitCommand`)
- Test: `cli/src/agentClient/commands.spec.ts` (the `harness wait` group)

**Interfaces:**
- Consumes: `NextStep`, `formatNext` (Task 1).

- [ ] **Step 1: Write the failing tests**

```ts
  it('tells where to look for a harness that is gone, and gives each one\'s next in JSON', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    const waiting = waitCommand(['kid'], h.deps)
    d.frames = [frame('lead', { engine: 'claude' })]
    expect(await waiting).toBe(EXIT.stopped)
    expect(h.out.join('\n')).toBe('kid: gone · it is gone\nNext: harness ps --all  (to see whether it was closed)')
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid')]
    d.pages.set('s-kid', [{ events: [ev('user_message', { text: 'go' }), ev('assistant_message', { text: 'done' })], hasMore: false }])
    const json = harness(d)
    expect(await waitCommand(['kid', '--json'], json.deps)).toBe(EXIT.ok)
    const [kid] = JSON.parse(json.out[0]).harnesses
    expect(kid.state).toBe('idle')
    expect(kid.next).toEqual([{ run: 'harness show kid', when: 'to read its answer' }])
  })
```

- [ ] **Step 2: Run to see it fail**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts -t "is gone"`
Expected: FAIL: no `Next:` line, and `kid.next` is undefined.

- [ ] **Step 3: Implement**

In `waitCommand`, after `results` is built, add a pure function above `waitCommand`:

```ts
/** What to do once a wait has ended on [state], with the commands that read it, wait again, and list the stopped ones. */
function waitNext(state: string, run: { read: string; again: string; list: string }): NextStep[] {
  switch (state) {
    case 'idle': return [{ run: run.read, when: 'to read its answer' }]
    case 'needs-input': return [{ tell: 'tell the person; only they answer it (a question or a permission).' }]
    case 'timeout': case 'installing': case 'starting': return [{ run: run.again, when: 'to keep waiting' }]
    case 'stopped': return [{ run: run.read, when: 'its answer is kept' }]
    case 'gone': return [{ run: run.list, when: 'to see whether it was closed' }]
    default: return []
  }
}
```

Called once per result with `at = onAway(r.name, away)`:
`waitNext(r.state, { read: step(s.env, 'show', at), again: step(s.env, 'wait', at), list: step(s.env, 'ps', away ? machineOption(away.word) : '', { flag: '--all', arg: 'all: true' }) })`.

Each JSON result gains `next: waitNext(…)`. In text, keep each `name: state · …` line as it is, and after a `gone`
line print `formatNext(next)`.

- [ ] **Step 4: Run the wait group**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts -t "harness wait"`
Expected: all pass; any older test asserting the whole JSON `harnesses` array with `toEqual` gets `next` added.

- [ ] **Step 5: Commit**

```bash
git add cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts
git commit -m "harness wait gives each harness's next step in JSON, and says where to look for one that is gone"
```

### Task 3: `close` says the result, the effect, and how many are left

**Files:**
- Modify: `cli/src/agentClient/commands.ts` (`closeCommand`)
- Modify: `cli/src/agentClient/mcp.spec.ts` only if it asserts `Closed …`
- Test: `cli/src/agentClient/commands.spec.ts` (the `harness close` group)

**Interfaces:**
- Consumes: `formatNext` (Task 1), `contextFor` (phase 3).

- [ ] **Step 1: Write the failing test**

```ts
  it('says the result and the effect, and how many of its own are still open', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('kid'), frame('other')]
    const h = harness(d)
    started(h.ledger, 'lead', 'kid')
    started(h.ledger, 'lead', 'other')
    expect(await closeCommand(['kid'], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n')).toBe('kid on studio: closed. Its conversation is kept; the person can resume it.\nNext: nothing; you have 1 open of 4.')
    const json = harness(d)
    expect(await closeCommand(['other', '--json'], json.deps)).toBe(EXIT.ok)
    expect(JSON.parse(json.out[0])).toEqual({ name: 'other', id: 'other', closed: true, effect: 'Its conversation is kept; the person can resume it.', next: [], open: 1 })
  })
```

(The second close still counts `kid`: the fake daemon keeps listing it. `open` is what the caller's own count says
after this close.)

- [ ] **Step 2: Run to see it fail**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts -t "how many of its own are still open"`
Expected: FAIL: text is `Closed kid. Its conversation is kept.`

- [ ] **Step 3: Implement**

At the end of `closeCommand`'s success path:

```ts
      const effect = kept ? 'Its conversation is kept; the person can resume it.' : 'It was still starting, so no conversation was kept.'
      // How many of its own are left, counted as `whoami` counts them, without the one just closed.
      o.frames = o.frames.filter((f) => !(t!.machineId === o.where.machineId && f.id === t!.frame.id))
      const open = o.caller ? contextFor(s, o).quota?.open ?? null : null
      const max = SPAWN_LIMITS.livePerHarness
      s.out(flags.has('--json')
        ? JSON.stringify({ name, id: t.frame.id, closed: true, ...(kept ? {} : { conversationKept: false }), effect, next: [], ...(open === null ? {} : { open }) })
        : [`${name} on ${t.machine}: closed. ${effect}`, open === null ? null : `Next: nothing; you have ${open} open of ${max}.`].filter(Boolean).join('\n'))
```

- [ ] **Step 4: Run the close group and the MCP spec**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts src/agentClient/mcp.spec.ts`
Expected: the new test passes; change older `Closed <name>. …` assertions to the new first line.

- [ ] **Step 5: Commit**

```bash
git add cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts cli/src/agentClient/mcp.spec.ts
git commit -m "harness close says what it did, what it kept, and how many of yours are still open"
```

### Task 4: An agent's `harness new` says starting, the effect, and Next

**Files:**
- Modify: `cli/src/lib/newCommand.ts` (`NewOrigin`, the success and installing paths)
- Modify: `cli/src/agentClient/commands.ts` (`agentOrigin`: `next` becomes `answer`)
- Test: `cli/src/lib/newCommand.spec.ts`, `cli/src/agentClient/commands.spec.ts` (the `agentOrigin` tests)

**Interfaces:**
- Consumes: `NextStep`, `formatNext` (Task 1).
- Produces: `NewOrigin.answer(agent: Record<string, unknown>, at: { local: boolean; machine: string | null }): { effect: string; next: NextStep[] }`,
  replacing `next(agent): string`.

- [ ] **Step 1: Write the failing tests**

In `newCommand.spec.ts`, where an origin fake has `next: () => 'Read it: harness show it'`, the fakes become
`answer: () => ({ effect: 'The person sees it in Harness, beside you.', next: [{ run: 'harness wait it', when: 'until it has answered; then read it: harness show it' }] })`,
and `next: () => ''` becomes `answer: () => ({ effect: '', next: [] })`. Change one assertion first to the new text:

```ts
    expect(trusted.out).toEqual([
      `opinion on this computer: starting. Codex, in ${scratch}.`,
      'The person sees it in Harness, beside you.',
      'Next: harness wait it  (until it has answered; then read it: harness show it)',
    ])
```

and add a JSON check beside it:

```ts
    const json = deps(['codex', scratch, '--name', 'opinion', '--json'], socket, { origin: async () => origin })
    expect(await newCommand(json)).toBe(0)
    const said = JSON.parse(json.out[0])
    expect(said.agent).toBeTruthy()
    expect(said.effect).toBe('The person sees it in Harness, beside you.')
    expect(said.next).toEqual([{ run: 'harness wait it', when: 'until it has answered; then read it: harness show it' }])
```

In `commands.spec.ts`, add to the `agentOrigin` group:

```ts
  it('answers an agent\'s start with the effect and Next, the machine named, and under MCP the tool', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const origin = (await agentOrigin(harness(d).deps))!
    expect(origin.answer({ id: 'k1', name: 'kid' }, { local: true, machine: null })).toEqual({
      effect: 'The person sees it in Harness, beside you.',
      next: [{ run: 'harness wait kid', when: 'until it has answered; then read it: harness show kid' }],
    })
    expect(origin.answer({ id: 'k1', name: 'kid' }, { local: false, machine: 'Mac mini' }).next[0]).toEqual(
      { run: 'harness wait --machine "Mac mini" kid', when: 'until it has answered; then read it: harness show --machine "Mac mini" kid' })
    const viaMcp = (await agentOrigin(harness(d, { env: { HARNESS_VIA_MCP: '1' } }).deps))!
    expect(viaMcp.answer({ id: 'k1', name: 'kid' }, { local: false, machine: 'mini' }).next[0].run).toBe('harness_wait (names: "kid")')
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `cd cli && npx vitest run src/lib/newCommand.spec.ts src/agentClient/commands.spec.ts -t "start|Created|origin"`
Expected: typecheck-level failures in vitest (`answer` is not a function) and the old `Created …` text.

- [ ] **Step 3: Implement in `newCommand.ts`**

In `NewOrigin`, replace `next` with:

```ts
  /** What the start changed, and what to run next: wait for it, then read it. */
  answer(agent: Record<string, unknown>, at: { local: boolean; machine: string | null }): { effect: string; next: NextStep[] }
```

In the success path, for an agent (`origin`):

```ts
      const engine = engineName(String(agent.engine ?? payload.engine ?? ''))
      const said = origin?.answer(agent, { local, machine: args.machine })
      if (args.json) deps.output(JSON.stringify({ ok: true, machineId, agent, ...(trustNote ? { note: trustNote } : {}), ...(said ? { effect: said.effect, next: said.next } : {}) }))
      else if (origin && said) {
        deps.output(`${name} on ${machineLabel}: starting. ${engine}${where ? `,${where}` : ''}.`)
        if (said.effect) deps.output(said.effect)
        if (trustNote) deps.output(trustNote)
        const next = formatNext(said.next)
        if (next) deps.output(next)
      } else { /* the person: as today, "Created …", ⌘O, and Read it for another machine */ }
```

In the installing path (agent, held for an install), replace the note with:

```ts
        const at = name ? (local || env[VIA_MCP_ENV] === '1' ? name : `${machineOption(args.machine!)} ${name}`) : ''
        const next: NextStep[] = name ? [{ run: step(env, 'wait', at), when: 'until it has started and answered' }] : [{ run: step(env, 'ps'), when: 'to follow it' }]
        const note = `${name || 'The harness'} on ${machineLabel}: installing ${engineName(String(payload.engine))}. It starts by itself once installed; do not start it again.`
        deps.output(args.json ? JSON.stringify({ ok: true, pending: true, machineId, creationId, name, note, next }) : `${note}\n${formatNext(next)}`)
```

- [ ] **Step 4: Implement in `agentOrigin`**

Replace `next: (agent) => …` with:

```ts
    answer: (agent, at) => {
      const name = addressOf({ machineId: '', agentId: String(agent.id ?? ''), name: String(agent.name ?? ''), engine: '' })
      // Under MCP the tools take no machine: harness_wait finds the caller's own by its record, on any machine.
      const target = at.local || at.machine === null || s.env[VIA_MCP_ENV] === '1' ? name : `${machineOption(at.machine)} ${name}`
      return {
        effect: caller.outside || !at.local ? 'The person sees it in Harness.' : 'The person sees it in Harness, beside you.',
        next: [{ run: step(s.env, 'wait', target), when: `until it has answered; then read it: ${step(s.env, 'show', target)}` }],
      }
    },
```

- [ ] **Step 5: Run, and update every changed assertion**

Run: `cd cli && npx vitest run src/lib/newCommand.spec.ts src/agentClient && npm run typecheck`
Expected: new tests pass. Change each origin fake (`next:` → `answer:`) and each agent-path `Created … `/`Read it:`
assertion to the new lines. The person's lines (`Created mine …`, `Open it in Harness with ⌘O.`) stay as they are.
The three `starts by itself once it is installed` assertions change to the installing text above.

- [ ] **Step 6: Commit**

```bash
git add cli/src/lib/newCommand.ts cli/src/lib/newCommand.spec.ts cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts
git commit -m "An agent's harness new says it is starting, that the person sees it, and to wait for it next"
```

### Task 5: An agent's `ps` ends with Next; `send` says how a reply comes

**Files:**
- Modify: `cli/src/agentClient/commands.ts` (`openNote` becomes `psNext`), `cli/src/messages/command.ts` (`formatSent`)
- Test: `cli/src/agentClient/commands.spec.ts` (the `harness ps` group), `cli/src/messages/command.spec.ts`

**Interfaces:**
- Consumes: `NextStep`, `formatNext` (Task 1); `Context.canStart` (phase 3).
- Produces: `psNext(env, rows: readonly Row[], canStart: boolean): NextStep[]`.

- [ ] **Step 1: Write the failing tests**

Replace the test `tells an agent how many of its own are open and idle, …` with:

```ts
  it('ends an agent\'s ps with Next: read its idle one, wait for its busy ones, or start one', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('a'), frame('b', { activity: { state: 'working' } }), frame('theirs')]
    const h = harness(d)
    for (const kid of ['a', 'b']) started(h.ledger, 'lead', kid)
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    expect(h.out.join('\n').split('\n').slice(-2)).toEqual([
      'Next: harness show a  (read its answer, then close it: harness close a)',
      '  or: harness wait b  (until it stops working)',
    ])
    // None of its own, and it may start one.
    d.frames = [frame('lead', { engine: 'claude' }), frame('theirs')]
    const none = harness(d)
    expect(await psCommand([], none.deps)).toBe(EXIT.ok)
    expect(none.out.join('\n').split('\n').at(-1)).toBe('Next: harness new <agent> --name <name> <project> -- <task>  (to hand work to another agent; do quick work yourself)')
    // The person: no Next.
    const person = harness(d, { pane: undefined })
    expect(await psCommand([], person.deps)).toBe(EXIT.ok)
    expect(person.out.join('\n')).not.toMatch(/^Next:/m)
  })
```

In `cli/src/messages/command.spec.ts`, add:

```ts
  it('says where a reply comes after a message is sent', () => {
    const text = formatSent({ id: 'm1', recipients: [{ name: 'mate', state: 'delivered', via: 'hook' }] })
    expect(text.split('\n').at(-1)).toBe('Next: harness send  (alone: who is here, and any reply to you)')
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `cd cli && npx vitest run src/agentClient/commands.spec.ts src/messages/command.spec.ts -t "Next|reply"`
Expected: FAIL: `You have 2 harnesses of your own open, …` is the last line; `formatSent` has no Next.

- [ ] **Step 3: Implement `psNext`**

Replace `openNote` with:

```ts
/** What an agent's `ps` ends with: its idle harness to read and close, its busy ones to wait for, or a start. */
export function psNext(env: NodeJS.ProcessEnv, rows: readonly Row[], canStart: boolean): NextStep[] {
  const at = (r: Row) => addressOf({ machineId: '', agentId: r.id, name: r.name, engine: '' })
  const open = rows.filter((r) => r.yours && r.state !== 'stopped' && r.state !== 'failed')
  const idle = open.filter((r) => r.state === 'idle'), busy = open.filter((r) => r.state !== 'idle')
  const steps: NextStep[] = []
  if (idle.length) steps.push({ run: step(env, 'show', at(idle[0])), when: `read its answer, then close it: ${step(env, 'close', at(idle[0]))}` })
  if (busy.length) steps.push({ run: step(env, 'wait', busy.map(at).join(',')), when: 'until it stops working' })
  if (!open.length && canStart) {
    steps.push({ run: env[VIA_MCP_ENV] === '1' ? 'harness_start (name: "<name>", task: "<task>")' : 'harness new <agent> --name <name> <project> -- <task>',
      when: 'to hand work to another agent; do quick work yourself' })
  }
  return steps
}
```

In `psCommand`, `const context = contextFor(s, o)` once; `const next = o.caller ? psNext(s.env, rows, !!context.canStart?.ok) : []`.
JSON gains `next`; text ends with `formatNext(next)` instead of `note`.

- [ ] **Step 4: Implement `send`'s Next**

In `formatSent`, for a send (not the roster), append `Next: harness send  (alone: who is here, and any reply to you)`
after the recipients' lines and the advice.

- [ ] **Step 5: Run**

Run: `cd cli && npx vitest run src/agentClient src/messages`
Expected: pass; older `formatSent` assertions with `toBe` get the Next line.

- [ ] **Step 6: Commit**

```bash
git add cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts cli/src/messages/command.ts cli/src/messages/command.spec.ts
git commit -m "An agent's harness ps ends with what to do next; harness send says where a reply comes"
```

## Phase 5: states and exit codes

### Task 6: `needs the person` in text, refusals exit 5 with code, reason and next

**Files:**
- Modify: `cli/src/agentClient/daemon.ts` (`AgentClientError` gains `reason`), `cli/src/agentClient/commands.ts`
  (`EXIT`, `run`, `waitCommand`, `showCommand`, `agentOrigin`), `cli/src/lib/newCommand.ts` (its catch),
  `cli/src/agentClient/mcp.ts` (`result`, descriptions)
- Test: `cli/src/agentClient/commands.spec.ts`, `cli/src/lib/newCommand.spec.ts`, `cli/src/agentClient/mcp.spec.ts`

**Interfaces:**
- Produces: `EXIT.refused = 5`; `REFUSED_CODES: ReadonlySet<string>` = `SPAWN_LIMIT`, `TURNED_OFF`, `NOT_YOURS`;
  `new AgentClientError(code, message, reason?)`; `refusalNext(env, error): NextStep[]`.

- [ ] **Step 1: Write the failing tests**

In `commands.spec.ts`:

```ts
describe('refusals and the person', () => {
  it('closing a harness the caller did not start exits 5, with its code and reason in JSON', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('theirs')]
    const h = harness(d)
    expect(await closeCommand(['theirs'], h.deps)).toBe(EXIT.refused)
    expect(EXIT.refused).toBe(5)
    const json = harness(d)
    expect(await closeCommand(['theirs', '--json'], json.deps)).toBe(5)
    const said = JSON.parse(json.out[0])
    expect(said.error).toBe('NOT_YOURS')
    expect(said.code).toBe('NOT_YOURS')
    expect(typeof said.detail).toBe('string')
    expect(said.next).toEqual([])
  })

  it('a start over the open limit is refused with its reason, and Next names close', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), ...['a', 'b', 'c', 'd'].map((id) => frame(id))]
    const h = harness(d)
    for (const kid of ['a', 'b', 'c', 'd']) started(h.ledger, 'lead', kid)
    const origin = (await agentOrigin(h.deps))!
    const error = await origin.check().catch((e) => e)
    expect(error).toBeInstanceOf(AgentClientError)
    expect([error.code, error.reason]).toEqual(['SPAWN_LIMIT', 'OPEN_LIMIT'])
  })

  it('says needs the person in text and keeps needs-input in JSON, with needsPerson', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), frame('asker')]
    d.screens.set('asker', ['needs_input'])
    const h = harness(d)
    started(h.ledger, 'lead', 'asker')
    expect(await waitCommand(['asker'], h.deps)).toBe(EXIT.needsInput)
    expect(h.out[0]).toMatch(/^asker: needs the person · /)
    const json = harness(d)
    expect(await waitCommand(['asker', '--json'], json.deps)).toBe(EXIT.needsInput)
    expect(JSON.parse(json.out[0]).harnesses[0]).toMatchObject({ state: 'needs-input', needsPerson: true })
  })
})
```

In `newCommand.spec.ts`, beside the existing refusal test for an origin whose `check` throws:

```ts
  it('exits 5 when the agent is refused, and says why in JSON beside the old error', async () => {
    const socket = new FakeSocket(() => null)   // refused before anything is asked of the daemon
    const origin = { check: async () => { throw new AgentClientError('SPAWN_LIMIT', 'You have 4 harnesses running. Close one you are done with first (harness close <name>).', 'OPEN_LIMIT') },
      prompt: (text: string) => text, created: async () => null, answer: () => ({ effect: '', next: [] }) }
    const d = deps(['codex', '--name', 'x', '--json'], socket, { origin: async () => origin })
    expect(await newCommand(d)).toBe(5)
    expect(JSON.parse(d.out[0])).toEqual({ ok: false, error: 'You have 4 harnesses running. Close one you are done with first (harness close <name>).',
      code: 'SPAWN_LIMIT', reason: 'OPEN_LIMIT', next: [{ run: 'harness close <name>', when: 'one you are done with, to free a place' }] })
  })
```


In `mcp.spec.ts`:

```ts
  it('gives a refusal as an answer, not a failure', () => {
    expect(result('harness_close', { code: 5, out: '', err: 'You did not start theirs, so you may not close it. Only the person can.' }))
      .toEqual({ content: [{ type: 'text', text: 'You did not start theirs, so you may not close it. Only the person can.' }] })
  })
```

and change line 173's `'a: needs-input'` input and expectation to `'a: needs the person'`.

- [ ] **Step 2: Run to see them fail**

Run: `cd cli && npx vitest run src/agentClient src/lib/newCommand.spec.ts -t "refus|needs the person|exits 5"`
Expected: FAIL: exit 1, no `code`/`reason`, `needs-input` in text.

- [ ] **Step 3: Implement**

`daemon.ts`:

```ts
export class AgentClientError extends Error {
  /** [reason]: which limit or rule refused, for a refusal (`SPAWN_LIMIT`'s `OPEN_LIMIT`, `TURNED_OFF`'s `SWITCH_OFF`). */
  constructor(readonly code: string, message: string, readonly reason?: string) { super(message) }
}
```

`commands.ts`:

```ts
export const EXIT = { ok: 0, failed: 1, usage: 2, needsInput: 3, stopped: 4, refused: 5, timeout: 124 } as const
/** Not a failure: the caller may not do this. It should not retry; it tells the person or does the work itself. */
export const REFUSED_CODES: ReadonlySet<string> = new Set(['SPAWN_LIMIT', 'TURNED_OFF', 'NOT_YOURS'])
/** What a refused caller may do instead: close one of its own when it is at its limit; otherwise the message says. */
export function refusalNext(env: NodeJS.ProcessEnv, error: AgentClientError): NextStep[] {
  return error.reason === 'OPEN_LIMIT' ? [{ run: step(env, 'close', '<name>'), when: 'one you are done with, to free a place' }] : []
}
```

- `run()`: an `AgentClientError` whose code is in `REFUSED_CODES` returns `EXIT.refused`; its JSON is
  `{ error: code, detail: message, code, ...(reason ? { reason } : {}), next: refusalNext(env, error) }`.
- `agentOrigin`: `check` throws `new AgentClientError('SPAWN_LIMIT', c.message, c.reason)` from `spawnCheck`'s
  result (with `liveFor` as today); `refusing('TURNED_OFF', …)` passes `'SWITCH_OFF'`; the orphan `NOT_YOURS`
  passes `'ORPHAN'`. `refusing` takes the reason as a third argument.
- `newCommand.ts` catch: an `AgentClientError` with a code in `REFUSED_CODES` returns 5, and its JSON adds
  `code`, `reason` (when there is one) and `next: refusalNext(env, error)`.
- Text says `needs the person` where it printed `needs-input`: `waitCommand`'s line (`${r.name}: ${label} · …`),
  `showCommand`'s first line. One helper: `const said = (state: string) => (state === 'needs-input' ? 'needs the person' : state)`.
  JSON results with `needs-input` add `needsPerson: true`.
- `mcp.ts` `result()`: `EXIT.refused` is answered (no `isError`), for every tool. `harness_list`'s description says
  `needs the person` instead of `needs-input`. `newCommand.ts`'s trust note says
  `harness_wait says needs the person` under MCP. `WAIT_USAGE`'s exit line becomes
  `Exit status: 0 idle or closed by you, 3 one needs the person (a question or a permission), 4 one stopped or is gone, 5 refused, 124 timed out.`
- `CLOSE_USAGE` adds: `An agent refused (not its harness) exits 5.`

- [ ] **Step 4: Run, and update every changed assertion**

Run: `cd cli && npx vitest run src/agentClient src/lib/newCommand.spec.ts && npm run typecheck`
Expected: pass after `toBe(EXIT.failed)` on refusals becomes `toBe(EXIT.refused)` and `needs-input` in text
assertions becomes `needs the person`. Run `cd cli && npx tsx --test scripts/agent-eval/score.test.mts`: the
scorer reads refusals by message, so it passes unchanged.

- [ ] **Step 5: Commit**

```bash
git add cli/src/agentClient cli/src/lib/newCommand.ts cli/src/lib/newCommand.spec.ts
git commit -m "Refusals exit 5 with their code and reason; text says needs the person"
```

## Phase 7: less to read

### Task 7: An agent's `ps`: its own first, then the busy ones, at most 15 rows

**Files:**
- Modify: `cli/src/agentClient/model.ts` (add `forAgent`), `cli/src/agentClient/commands.ts` (`psCommand`)
- Test: `cli/src/agentClient/model.spec.ts`, `cli/src/agentClient/commands.spec.ts`

**Interfaces:**
- Produces: `forAgent(rows: readonly Row[], max?: number): { shown: Row[]; more: number }` (max 15).

- [ ] **Step 1: Write the failing tests**

`model.spec.ts`:

```ts
describe('forAgent', () => {
  const row = (name: string, over: Partial<Row> = {}): Row => ({ name, id: name, agent: 'Codex', machine: 'm', state: 'idle', folder: null, branch: null,
    startedBy: 'person', yours: false, self: false, lastActive: null, ...over })
  it('puts its own first, then the working and the ones needing the person, then the rest, and counts the rest past 15', () => {
    const rows = [...Array.from({ length: 30 }, (_, i) => row(`idle${i}`)), row('busy', { state: 'working' }), row('mine1', { yours: true }), row('mine2', { yours: true })]
    const { shown, more } = forAgent(rows)
    expect(shown.map((r) => r.name).slice(0, 3)).toEqual(['mine1', 'mine2', 'busy'])
    expect(shown).toHaveLength(15)
    expect(more).toBe(18)
  })
  it('shows every row when there are 15 or fewer', () => {
    expect(forAgent([row('a'), row('b')])).toEqual({ shown: [row('a'), row('b')], more: 0 })
  })
})
```

`commands.spec.ts`, in the `harness ps` group:

```ts
  it('shows an agent at most 15 rows and says how to see the rest; a person sees all', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' }), ...Array.from({ length: 20 }, (_, i) => frame(`h${i}`))]
    const h = harness(d)
    expect(await psCommand([], h.deps)).toBe(EXIT.ok)
    const text = h.out.join('\n')
    expect(text).toContain('and 6 more: harness ps --all')
    const person = harness(d, { pane: undefined })
    expect(await psCommand([], person.deps)).toBe(EXIT.ok)
    expect(person.out.join('\n')).not.toContain('more: harness ps --all')
    expect(person.out.join('\n').match(/^h\d+ /gm)).toHaveLength(20)
  })
```

(21 harnesses: 15 shown, 6 more.)

- [ ] **Step 2: Run to see them fail**

Run: `cd cli && npx vitest run src/agentClient/model.spec.ts src/agentClient/commands.spec.ts -t "forAgent|15 rows"`
Expected: FAIL: `forAgent` is not exported; no `and 6 more` line.

- [ ] **Step 3: Implement**

`model.ts`:

```ts
/** How many rows an agent's `ps` shows unless asked for all: on the owner's Mac, 40 rows became about 8 to read. */
export const AGENT_ROWS = 15

/** An agent's `ps`: its own first, then those working or waiting on the person, then the rest; [max] at most. */
export function forAgent(rows: readonly Row[], max = AGENT_ROWS): { shown: Row[]; more: number } {
  const busy = (r: Row) => r.state === 'working' || r.state === 'needs-input'
  const ordered = [...rows.filter((r) => r.yours), ...rows.filter((r) => !r.yours && busy(r)), ...rows.filter((r) => !r.yours && !busy(r))]
  return { shown: ordered.slice(0, max), more: Math.max(0, ordered.length - max) }
}
```

`psCommand` text for an agent without `--all`: `const { shown, more } = forAgent(rows)`; print `formatRows(shown, …)`
then, when `more`, `` `and ${more} more: ${step(s.env, 'ps', away ? machineOption(away.word) : '', { flag: '--all', arg: 'all: true' })}` ``,
then the Next. JSON keeps every row. A person's text keeps every row.

- [ ] **Step 4: Run**

Run: `cd cli && npx vitest run src/agentClient`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/agentClient/model.ts cli/src/agentClient/model.spec.ts cli/src/agentClient/commands.ts cli/src/agentClient/commands.spec.ts
git commit -m "An agent's harness ps shows its own first and at most 15 rows"
```

### Task 8: `harness help agents`, and `--help` points agents to it

**Files:**
- Create: `cli/src/agentClient/help.ts`, `cli/src/agentClient/help.spec.ts`
- Modify: `cli/src/cli.ts` (`usage`, the `help` word)

**Interfaces:**
- Consumes: `PS_USAGE`, `SHOW_USAGE`, `WAIT_USAGE`, `CLOSE_USAGE`, `WHOAMI_USAGE`, `EXIT`, `SPAWN_LIMITS`
  (commands.ts); `NEW_USAGE` (lib/newCommand.ts); `SEND_USAGE` (messages/command.ts); `outsideCaller` (model.ts).
- Produces: `agentsHelp(): string`; `helpFor(env: NodeJS.ProcessEnv, full: string): string`.

`next.ts` must not import `commands.ts` at module load if `commands.ts` imports `next.ts` (a cycle ESM handles for
functions, not for top-level constants). Put `agentsHelp` and `helpFor` in a new file `cli/src/agentClient/help.ts`
instead, with its spec `help.spec.ts`; `next.ts` stays the format alone.

- [ ] **Step 1: Write the failing tests**

`cli/src/agentClient/help.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { CLOSE_USAGE, EXIT, PS_USAGE, SHOW_USAGE, WAIT_USAGE, WHOAMI_USAGE } from './commands.js'
import { NEW_USAGE } from '../lib/newCommand.js'
import { agentsHelp, helpFor } from './help.js'

const synopsis = (usage: string) => usage.split('\n')[0].replace(/^Usage: /, '')

describe('harness help agents', () => {
  it('fits in 40 lines and names each verb as its usage does', () => {
    const text = agentsHelp()
    expect(text.split('\n').length).toBeLessThanOrEqual(40)
    for (const usage of [WHOAMI_USAGE, PS_USAGE, NEW_USAGE, WAIT_USAGE, SHOW_USAGE, CLOSE_USAGE]) expect(text).toContain(synopsis(usage))
    expect(text).toContain('harness send <name>[,<name>] "text"')
  })
  it('lists every exit code', () => {
    for (const code of Object.values(EXIT)) expect(agentsHelp()).toMatch(new RegExp(`\\b${code}\\b`))
  })
  it('uses placeholders, never a real name', () => {
    expect(agentsHelp()).not.toMatch(/--machine (?!<)/)
  })
})

describe('harness --help', () => {
  const full = 'harness vX — connect this computer to your machine\n…'
  it('points an agent to its help on the first line', () => {
    expect(helpFor({}, full).split('\n')[0]).toBe('An agent? Run: harness help agents')
  })
  it('puts the agents\' help first when an agent asks', () => {
    expect(helpFor({ CODEX_THREAD_ID: 't' }, full).startsWith(agentsHelp())).toBe(true)
    expect(helpFor({ AI_AGENT: 'cursor' }, full).startsWith(agentsHelp())).toBe(true)
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `cd cli && npx vitest run src/agentClient/help.spec.ts`
Expected: FAIL: `./help.js` does not exist.

- [ ] **Step 3: Write `help.ts`**

```ts
/**
 * `harness help agents`: all an agent needs on one screen (docs/design/2026-10-15-agent-experience.md, part 4). Each
 * verb's line is its own usage's first line, so this cannot say an option the verb does not take.
 */
import { CLOSE_USAGE, EXIT, PS_USAGE, SHOW_USAGE, SPAWN_LIMITS, WAIT_USAGE, WHOAMI_USAGE } from './commands.js'
import { NEW_USAGE } from '../lib/newCommand.js'
import { SEND_USAGE } from '../messages/command.js'
import { outsideCaller } from './model.js'

const synopsis = (usage: string): string => usage.split('\n')[0].replace(/^Usage: /, '')
const sendLine = (): string => (SEND_USAGE.split('\n').find((l) => l.includes('harness send <name>[,<name>]')) ?? '').trim().split(/\s{2,}/)[0]

export function agentsHelp(): string {
  return [
    'Harness for agents: start other agents, wait for them, read their answers, close them,',
    'on this computer or another of the person\'s machines (--machine <machine>).',
    'Every harness spends the person\'s tokens: start one only for work that runs beside yours,',
    'needs another model\'s view, or takes long. Do quick work yourself.',
    '',
    `First:  ${synopsis(WHOAMI_USAGE)}   who you are here, and whether you may start harnesses`,
    `        ${synopsis(PS_USAGE)}`,
    `        ${synopsis(NEW_USAGE)}`,
    `        ${synopsis(WAIT_USAGE)}`,
    `        ${synopsis(SHOW_USAGE)}`,
    `        ${synopsis(CLOSE_USAGE)}`,
    `        ${sendLine()}`,
    '',
    'A whole job:',
    '  harness new <agent> --name <name> <project> -- <task>',
    '  harness wait <name>',
    '  harness show <name>',
    '  harness close <name>',
    'Every command ends with Next: the command to run next. --json gives it as "next".',
    '',
    'States: working, idle, needs the person, installing, starting, stopped, gone, closed, failed.',
    `Exit codes: ${EXIT.ok} done · ${EXIT.failed} failed · ${EXIT.usage} wrong command · ${EXIT.needsInput} needs the person · `
      + `${EXIT.stopped} stopped or gone · ${EXIT.refused} refused (do not retry) · ${EXIT.timeout} still working when the wait ended.`,
    `Limits: ${SPAWN_LIMITS.livePerHarness} of yours open at once, ${SPAWN_LIMITS.perWindow} starts in ${SPAWN_LIMITS.windowMs / 60_000} minutes;`,
    'a harness another agent started may not start harnesses.',
    'Rules: name every harness. Put the whole task in it: you cannot message it after.',
    'Close what you started once you have its answer. Never close one you did not start.',
    'When a harness needs the person, tell the person: only they answer it.',
    'Never ask a harness to publish, deploy, delete or push.',
    '',
    'More: https://harness.autonomous.ai/agents',
  ].join('\n')
}

/** `harness --help`: a line for agents first; an agent asking gets its own help before the rest. */
export function helpFor(env: NodeJS.ProcessEnv, full: string): string {
  const text = `An agent? Run: harness help agents\n${full}`
  return outsideCaller(env, '') ? `${agentsHelp()}\n\n${text}` : text
}
```

`outsideCaller` reads only the environment, so an agent in a Harness pane counts by its own variables
(`CLAUDECODE` with `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `AI_AGENT`, `HARNESS_AGENT_SESSION`).

- [ ] **Step 4: Wire it into `cli.ts`**

- `usage()` builds its text into a string `full` and prints `helpFor(process.env, full)`.
- Before the `usage()` call for `help`: `if (cmd === 'help' && args[0] === 'agents') { console.log(agentsHelp()); process.exit(0) }`.
- In the help text, under `harness mcp`, add `  harness help agents          the agent commands, states, exit codes and rules on one screen`.

- [ ] **Step 5: Run, and see it built**

Run: `cd cli && npx vitest run src/agentClient/help.spec.ts && npm run typecheck && npx tsx src/cli.ts help agents | wc -l && CODEX_THREAD_ID=t npx tsx src/cli.ts --help | head -3 && npx tsx src/cli.ts --help | head -1`
Expected: tests pass; at most 40 lines; the agent's `--help` starts with `Harness for agents:`; a person's starts with
`An agent? Run: harness help agents`.

- [ ] **Step 6: Commit**

```bash
git add cli/src/agentClient/help.ts cli/src/agentClient/help.spec.ts cli/src/cli.ts
git commit -m "harness help agents: the agent commands, states, exit codes and rules on one screen"
```

## Phase 8: MCP (not in this run)

The person narrowed this run to agents using the CLI (October 15): Tasks 9 and 10 are skipped and kept here for a
later run. Under `harness mcp`, the verbs' `Next` lines already name MCP tools (`step()`), so MCP agents still get them.

### Task 9: Each tool returns its JSON as `structuredContent`, with an `outputSchema`

**Files:**
- Modify: `cli/src/agentClient/commands.ts` (an `emit` helper used by `ps`, `whoami`, `show`, `wait`, `close`),
  `cli/src/lib/newCommand.ts` (its agent success and installing paths), `cli/src/agentClient/mcp.ts`
- Test: `cli/src/agentClient/mcp.spec.ts`, `cli/src/agentClient/commands.spec.ts`

**Interfaces:**
- Produces: `STRUCTURED_MARK = '\u001eharness-json '` (commands.ts): under `HARNESS_VIA_MCP=1` a verb prints its text,
  then one line `STRUCTURED_MARK + JSON`. `result(tool, ran, structured: boolean)` moves that line into
  `structuredContent`.

- [ ] **Step 1: Write the failing tests**

`commands.spec.ts`:

```ts
  it('under harness mcp, prints its JSON on one marked line after the text', async () => {
    const d = new FakeDaemon()
    d.frames = [frame('lead', { engine: 'claude' })]
    const h = harness(d, { env: { HARNESS_VIA_MCP: '1' } })
    expect(await whoamiCommand([], h.deps)).toBe(EXIT.ok)
    const marked = h.out.filter((l) => l.startsWith(STRUCTURED_MARK))
    expect(marked).toHaveLength(1)
    expect(JSON.parse(marked[0].slice(STRUCTURED_MARK.length)).context.caller.kind).toBe('agent')
    expect(h.out[0]).toMatch(/^You: /)
  })
```

`mcp.spec.ts`:

```ts
  it('moves the marked JSON into structuredContent on 2025-06-18 and later, and drops it before', () => {
    const out = `kid on studio: closed. Its conversation is kept; the person can resume it.\n${STRUCTURED_MARK}{"name":"kid","closed":true}\n`
    expect(result('harness_close', { code: 0, out, err: '' }, true)).toEqual({
      content: [{ type: 'text', text: 'kid on studio: closed. Its conversation is kept; the person can resume it.' }],
      structuredContent: { name: 'kid', closed: true },
    })
    expect(result('harness_close', { code: 0, out, err: '' }, false)).toEqual({
      content: [{ type: 'text', text: 'kid on studio: closed. Its conversation is kept; the person can resume it.' }],
    })
  })

  it('declares outputSchema only to clients that read it', async () => {
    const run: Runner = async () => ({ code: 1, out: '', err: '' })
    const state = {}
    await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { run, whoamiMs: 1 }, state)
    const tools = (await answer({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { run }, state))!.result as { tools: Array<Record<string, unknown>> }
    expect(tools.tools.every((t) => t.name === 'harness_send' || (t.outputSchema as { type?: string })?.type === 'object')).toBe(true)
    const old = {}
    await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, { run, whoamiMs: 1 }, old)
    const plain = (await answer({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { run }, old))!.result as { tools: Array<Record<string, unknown>> }
    expect(plain.tools.some((t) => 'outputSchema' in t)).toBe(false)
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `cd cli && npx vitest run src/agentClient -t "marked|structuredContent|outputSchema"`
Expected: FAIL: `STRUCTURED_MARK` is not exported.

- [ ] **Step 3: Implement the marked line**

`commands.ts`:

```ts
/** Under `harness mcp`, the line that carries a verb's JSON after its text, for `structuredContent` (mcp.ts). */
export const STRUCTURED_MARK = '\u001eharness-json '

/** A verb's answer: its JSON with --json; else its text, and under `harness mcp` its JSON on a marked line too. */
function emit(s: Setup, json: boolean, data: unknown, text: string, indent?: number): void {
  if (json) { s.out(JSON.stringify(data, null, indent)); return }
  s.out(text)
  if (s.env[VIA_MCP_ENV] === '1') s.out(STRUCTURED_MARK + JSON.stringify(data))
}
```

`ps`, `whoami`, `show`, `wait` and `close` print through `emit`, each keeping its JSON's indent today (`ps` and
`whoami` and `show` and `wait` use `null, 1`; `close` none). `show` and `wait` collect their lines into one string
first. In `newCommand.ts`, the agent's success and installing paths output the same marked line under
`env[VIA_MCP_ENV] === '1'` (import `STRUCTURED_MARK`).

- [ ] **Step 4: Implement in `mcp.ts`**

- `state` gains `protocol?: string`, set in `initialize` to the negotiated version.
- `const structured = (state.protocol ?? '') >= '2025-06-18'` (the versions are dates, so they compare as strings).
- `tools/list`: with `structured`, each tool but `harness_send` carries `outputSchema` from a table:

```ts
const OUTPUT: Record<string, Record<string, unknown>> = {
  harness_whoami: { context: { type: 'object' } },
  harness_list: { context: { type: 'object' }, harnesses: { type: 'array' }, next: { type: 'array' } },
  harness_start: { ok: { type: 'boolean' }, agent: { type: 'object' }, effect: { type: 'string' }, next: { type: 'array' } },
  harness_wait: { harnesses: { type: 'array' } },
  harness_read: { name: { type: 'string' }, state: { type: 'string' }, answer: { type: 'string' }, next: { type: 'array' } },
  harness_close: { name: { type: 'string' }, closed: { type: 'boolean' }, effect: { type: 'string' }, next: { type: 'array' } },
}
const outputSchema = (tool: string) => ({ type: 'object', properties: OUTPUT[tool] })   // nothing required: a refusal or a cancel has other fields
```

- `result(tool, ran, structured = false)`: take every line of `ran.out` that starts with `STRUCTURED_MARK` out of
  the text; when `structured`, the call is answered (not `isError`), and the last such line parses to an object, add
  `structuredContent`.

- [ ] **Step 5: Run**

Run: `cd cli && npx vitest run src/agentClient src/lib/newCommand.spec.ts && npm run typecheck`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add cli/src/agentClient cli/src/lib/newCommand.ts
git commit -m "harness mcp returns each answer's JSON as structuredContent, with an outputSchema per tool"
```

### Task 10: `harness mcp --read-only`

**Files:**
- Modify: `cli/src/agentClient/mcp.ts` (`McpDeps.readOnly`, the tool filter, `INSTRUCTIONS`), `cli/src/cli.ts` (`case 'mcp'`, help line)
- Test: `cli/src/agentClient/mcp.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('serves only the tools that look and wait with --read-only, and says so', async () => {
    const run: Runner = async () => ({ code: 1, out: '', err: '' })
    const init = await answer({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { run, readOnly: true, whoamiMs: 1 })
    expect((init!.result as { instructions: string }).instructions).toContain('This server only looks and waits')
    const list = await answer({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { run, readOnly: true, inPane: true })
    expect((list!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(['harness_whoami', 'harness_list', 'harness_wait', 'harness_read'])
    const call = await answer({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'harness_close', arguments: { name: 'x' } } }, { run, readOnly: true })
    expect(call!.error).toEqual({ code: -32602, message: 'Unknown tool: harness_close' })
  })
```

- [ ] **Step 2: Run to see it fail**

Run: `cd cli && npx vitest run src/agentClient/mcp.spec.ts -t "read-only"`
Expected: FAIL: all tools are listed.

- [ ] **Step 3: Implement**

`McpDeps` gains `readOnly?: boolean`. `const LOOKS = new Set(['harness_whoami', 'harness_list', 'harness_wait', 'harness_read'])`;
the tool filter adds `&& (!deps.readOnly || LOOKS.has(tool.name))`. With `readOnly`, the instructions end with
`\n\nThis server only looks and waits: it cannot start, message or close harnesses.` In `cli.ts`,
`mcpCommand({ …, readOnly: rest.includes('--read-only') })`, and the help line becomes
`harness mcp [--read-only]     the agent verbs as an MCP server on stdin/stdout; --read-only: look and wait only`.

- [ ] **Step 4: Run**

Run: `cd cli && npx vitest run src/agentClient/mcp.spec.ts`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add cli/src/agentClient/mcp.ts cli/src/agentClient/mcp.spec.ts cli/src/cli.ts
git commit -m "harness mcp --read-only serves only the tools that look and wait"
```

## The pages and the whole check

### Task 11: The pages agents read, the docs, and the end to end

**Files:**
- Modify: `plugins/harness/skills/harness/SKILL.md`, `website/public/llms.txt`, `website/public/agents/index.html`,
  `docs/cli.md`, `docs/design/2026-10-11-agent-client.md`, `cli/src/agentClient/mcp.ts` (`INSTRUCTIONS`),
  `cli/e2e/agentClient.e2e.ts`, `cli/e2e/freshMachineEngines.e2e.ts`
- Test: `website/scripts/agents-site.spec.ts` (unchanged; it must still pass), the e2e file

- [ ] **Step 1: Say the new behaviour where agents read**

In each of SKILL.md, `llms.txt` and `/agents`, with placeholders only:
- every command ends with `Next:`, the command to run next; `--json` has it as `next`;
- exit 5 means refused: do not retry, tell the person or do the work yourself;
- `needs the person`: tell the person;
- `harness help agents` prints all of it on one screen.
`INSTRUCTIONS` gains: `Each answer ends with Next: the call to make next. A refusal is final: do not retry it.`

- [ ] **Step 2: Run the page checks and the agent client**

Run: `cd website && npx vitest run scripts/agents-site.spec.ts && cd ../cli && npx vitest run src/agentClient src/lib/newCommand.spec.ts src/messages src/engines/kit/hookSettings.spec.ts && npm run typecheck`
Expected: pass. The website spec fails on any option the pages name that a usage does not have.

- [ ] **Step 3: Update the end to end's expected text, then run it once**

In `cli/e2e/agentClient.e2e.ts` and `freshMachineEngines.e2e.ts`, change the lines this plan changed (listed by
`grep -n "Created .* on \|Read it: \|Its conversation is kept\|Close it once\|of your own open\|needs-input ·"`): an
agent's start now prints `<name> on this computer: starting. …` and `Next: harness wait <name>  (…)`; `close` prints
`<name> on this computer: closed. …`; `show` ends with `Next: harness close <name>  (…)`; `ps` ends with Next; `wait`
says `needs the person`. The person's starts in `freshMachineEngines` keep `Created …`.

Run: `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/agentClient.e2e.ts > /tmp/agent-e2e.log 2>&1; tail -30 /tmp/agent-e2e.log`
(Use the e2e config and command the phase 1 to 3 run used.)
Expected: all pass except the known "trust its folder" failure that also fails on `main` (exit 124).

- [ ] **Step 4: Commit**

```bash
git add plugins website docs cli/src/agentClient/mcp.ts cli/e2e
git commit -m "The agent pages and docs teach Next, exit 5, needs the person and harness help agents"
```

### After the last task

- The final whole-branch review, as in phases 1 to 3.
- The eval (phase 11) runs only with the person's approval: once on `main` for the baseline, once on this branch.
- Phases 6 (signed-out detection) and 9 (across machines) get their own plan after a short look at what each machine
  can tell (its Harness version, an engine's sign-in screen).

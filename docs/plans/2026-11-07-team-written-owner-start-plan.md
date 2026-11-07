# Team-written work starts on the owner's own computer Plan

**Goal:** A start for Team-written work (`projectSettings: 'off'`) on a machine that is not a Team daemon launches with the
branch's own project settings kept out, instead of failing with "runs only in a Team account" (task #4307).

**Architecture:** Since Swarm v3 there is no Team machine; the backend sends Team-written work only to the project owner's
own computer with project settings off (backend `superTabs/commands.ts` start, `teamWritten.ts`, the PM's ruling #4120).
`cli/src/superTabs/start.ts` drops its non-Team refusal and applies the protections a Team daemon got: the `teamWritten`
permission mode (Claude Code: `--setting-sources user --strict-mcp-config`), and for Codex an engine home of its own that
trusts no project and names the checkout untrusted. Off a Team daemon that home has no Codex sign-in (Team accounts got one
from the relay v3 removed), so it links the person's own Codex `auth.json` into it; Harness never opens that file. Where the
link cannot be made (no sign-in file, or the system refuses the link), the start fails before anything is created, saying why.

**Tech Stack:** TypeScript, Node `fs`, vitest.

**Spec:** the task brief of #4307.

This plan is implemented by its Engineer, task by task, test first.

## Global Constraints

- CLI only; `cli/src/superTabs/start.ts` and its spec.
- Never read a Claude or ChatGPT login: the sign-in file is linked, never opened or copied.
- No other start path changes: a Team daemon's starts and every normal start are as before.

## Review Focus

- The branch's own project settings, hooks and trust never load for Team-written code, on Claude Code or Codex.
- The linked sign-in is the person's own Codex home's (the start's profile when it names one), on their own computer.
- A refused start creates nothing and says why.

## Task 1: Team-written starts off a Team daemon

**Files:** `cli/src/superTabs/start.ts`, `cli/src/superTabs/start.spec.ts`

**Interfaces:** `linkCodexSignIn(home, own): string | null` (exported for its spec): null when linked, else why not.

- [ ] Write failing specs: on a non-Team machine, Team-written Claude Code work launches in `teamWritten` mode with no engine
      home of its own; Team-written Codex work launches in its own home that trusts no project, names the checkout
      untrusted and links the person's own sign-in file; with no sign-in file it fails before anything is created, saying
      why; a normal Codex start gets no home of its own.
- [ ] Run them and watch them fail.
- [ ] Remove the refusal, give Codex its own home off a Team daemon and link the sign-in.
- [ ] Run `start.spec.ts` and the specs of what imports it; run `npm run test:core` (the CLI coverage gate).

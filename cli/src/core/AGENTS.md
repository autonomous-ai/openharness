# The core

The part of the daemon that must never go down: agents, terminals, transcripts, turns, input and
questions. Everything else is a service ([../services/AGENTS.md](../services/AGENTS.md)).

## Rules for a core module

1. **One factory per module, explicit dependencies:** `createX(deps)` returns the module's functions.
   Dependencies are passed in, never imported as live state, so the module is tested without a daemon.
2. **Only what every session needs.** A feature a session can run without belongs in a service. Ask
   before growing the core; the answer is usually a service and, at most, a new `CoreApi` member.
3. **Never import a service, `cli.ts` or `backendSocket.ts`,** except types
   (`import type { BackendSocket }`). The core calls services only through `CorePorts`, and every call
   has a fallback (`api.ts`). `src/architecture.spec.ts` checks it.
4. **Never wait on anything slow in line.** A request handler that reads a large file, runs a
   subprocess or calls the network must be bounded in time and memory: the October 3 crash was an
   attach that read an 803 MB transcript whole.
5. **100% coverage, per file** (`npm run test:core`), and an end-to-end test (`../../e2e/`) for any
   behaviour a person can see. The end-to-end suite has found every race fixed here so far: run it.
6. **Evidence must be newer than the state it contradicts.** A scan, probe or read that began before
   a change must not be used to undo that change (see `terminalAgentReconciler.ts` `probedAs`,
   `routeTouched`, and `transcripts/relaunch.ts`). Most of the races found end to end were this.

## Where things are

- `agents/`: create, fork, restart, retarget, stop, resume, close, discovery, binding.
- `transcripts/`: attach (bounded reads from the end), ingest, live tail, relaunch marks, normalizers.
- `turns/`: working/idle, the event funnel, cancel, recaps, heartbeats, hooks.
- `terminals/`: who controls a pane (the control lease).
- `engines/`: the engines' hooks.
- `input.ts`, `questions.ts`: messages into a pane; an agent's question and its answer.
- `api.ts`: the contract with services. `serviceHost.ts`: services in this process.
  `serviceLinks.ts`: services in their own processes.

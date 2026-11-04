# Refused-command loops Implementation Plan

> **For agentic workers:** Follow the project Engineer workflow: plan first in a draft PR; implement task by task with a committed failing test before its passing code; one independent review step on the pull request.

**Goal:** Clients stop resending Swarm commands the backend refuses for good, back off on passing failures, and every refusal the backend logs names its Swarm, agent and client. Strengthens "Ken's router fits every agent to a machine … without choking": a host that hammers the backend with refused commands is load for nothing.

**Architecture:** One small CLI helper decides, per command, whether it may go now: never again after a permanent refusal (`AGENT_UNAVAILABLE`, `NOT_FOUND`, `BUDDY_SESSION_THREAD`, `BUDDY_MACHINE`), with doubling backoff after any other failure. The host's configuration reports and the terminal host's alerts ask it before each post, and a skill notice refused for good counts as settled. The CLI declares itself (`x-harness-client: cli/<version>`) on every backend call, and the backend's refusal log line adds the Swarm, the agent the command names or acts as, the client kind and version, and the host machine, never the command's words.

**Tech Stack:** TypeScript, Vitest (CLI and backend), Fastify route headers.

**Spec:** Task #2675 in Super Tab conversation d050ba3eefb8214257eccd07 (Ken's prod scan, 2026-11-04; River's brief).

## Where each count comes from

| Count in 32 min (Ken) | Sender | Cadence today | Why it loops |
|---|---|---|---|
| `AGENT_UNAVAILABLE agent.configuration` 615 (~19/min) | CLI host, `cli/src/superTabs/host.ts` `recordConfigurations` | every 5 s per agent | the roster still lists an agent the Swarm will not take as an actor (removed, or its contributor rejoined so it "must be shared again", backend `model.ts agent()`); the observation never lands, so every pass posts it again. ~12/min per agent: about 1.6 agents. |
| `AGENT_UNAVAILABLE agent.alert` 116 (~3.6/min) | CLI terminal host, `cli/src/superTabs/terminal.ts` `episode` | every 15 s read | a failed alert leaves its episode unalerted, so each read tries again. ~4/min per alert: about one stuck alert. |
| `BUDDY_SESSION_THREAD message.send` 125 (~3.9/min) | CLI host skill notice, `cli/src/superTabs/host.ts` `tellSkill` via `refreshSkill` | every 60 s (`SKILL_RETRY_MS`) | a Buddy session is owed a skill notice (its told record is null, `lib/swarmInstructionsSkill.ts`), posted top level as the agent; the backend refuses a session's top-level post (`commands.ts` 1150), and the refresh catch retries a minute later, for as long as the session runs. About four sessions. Some may also be session models running `post` without `--reply-to`. |
| `NOT_FOUND message.send` 316 | no code loop found | | Desktop keeps a refused send as Not sent until Retry (`controller.dart` 4799), drops queued sends for gone groups (5086); the phone's outbox removes a refused post (`swarm_outbox.dart` 281); agent `post`, dial `say` and stop notices are one-shot. Most likely agents re-running a refused `post` at a removed or unreadable group, or people sending again. The new log line names their Swarm, agent and client. |
| `BUDDY_MACHINE buddy.create` 8 | no code loop | | buttons only: Start again / Couldn't start on a Buddy machine no longer listed (`buddies.dart` 589/676, phone `swarm_buddy_chat.dart` 154/188), or older clients. |

## Global Constraints

- Permanent refusals, never retried for the same command: `AGENT_UNAVAILABLE`, `NOT_FOUND`, `BUDDY_SESSION_THREAD`, `BUDDY_MACHINE`. Anything else backs off: 5 s, doubling, at most 5 minutes; a success resets it.
- A changed command is a new command: a new configuration reading (new operation id) or a new alert episode is sent once more.
- The refusal log never carries message text, emails, tokens, conversation or recipient ids: only `code`, `type`, `tabId`, `agentId`, `asAgent`, `client`, `version`, and `machineId` for a host route.
- A declared client is believed only in its shape: `^(cli|desktop|phone|web)/[0-9A-Za-z.+-]{1,32}$`; otherwise the kind comes from the user agent (`lib/routeLatency.ts clientKind`) and the version is null.
- No env switches; no production access; Swarm code stays out of `cli/src/core`.

## Design

- Growth: the CLI keeps one entry per refused or backed-off command, dropped when its agent leaves the roster or its key changes; the backend stores nothing new.
- Concurrency: N/A, single host loop per machine; no shared state.
- Read cost: the backend log line adds no query (all fields are in the request). Queries per request unchanged; the CLI's change removes about 19 + 3.6 refused commands a minute at today's numbers, each of which cost the backend a state read and a transaction.
- Scale: at 10x agents the refused commands stay at one per stuck command instead of 12/min each; first warning is the refusal log's count per `tabId`/`agentId`.
- Compatibility: an older backend ignores the new header; an older CLI keeps looping until updated, and the log now names its version.
- Migration + rollback: none.
- Audience: the log is server-side only.
- Identity: no person ids or emails in the log.
- Failure: a refused command is logged once by the CLI as before (its message), and the backend's line says whose.
- Platforms: CLI on macOS, Linux, Windows; backend.

## Review Focus

- A refusal of one agent's configuration must not stop another agent's (Task 3 keys by operation id).
- A transient failure must still deliver eventually (Tasks 3, 4 backoff tests expect at least two tries).
- An alert refused for good must not leave its episode stuck so that the next real episode is never sent (Task 4: new episode after the screen clears).
- The log must not leak words (Task 1 test on a message.send with text and an email).
- The header must not let a client inject log content (Task 1 shape test).

---

### Task 1: Backend refusal log fields

**Files:** Create `backend/src/superTabs/refusalLog.ts`; modify `backend/src/superTabs/store.ts` (`execute` catch), `backend/src/routes/superTabs.ts` (pass the declared client); test `backend/src/superTabs/refusalLog.test.ts`.

**Interfaces:** `declaredHttpClient(headers): { kind: string; version: string | null }`; `refusalLogFields(tabId, command, code, { asAgentId?, client?, machineId? }): Record<string, unknown>`; `SuperTabStore.execute(..., client?)`.

- [ ] Failing test: Swarm/agent/CLI version for a host; command's agent over the acting one; a person's message without its words; header shape.
- [ ] Run red; implement; run green; `npx tsc --noEmit -p .`; commit.

### Task 2: The CLI declares itself

**Files:** modify `cli/src/gateway/accountHttp.ts`; test `cli/src/gateway/accountHttp.spec.ts`.

- [ ] Failing test: the request headers carry `x-harness-client: cli/<VERSION>`. Red; add the header; green; commit.

### Task 3: Configuration reports stop on a permanent refusal

**Files:** create `cli/src/superTabs/retries.ts` (`PERMANENT_REFUSALS`, `CommandRetries`); modify `cli/src/superTabs/host.ts` `recordConfigurations`; test `cli/src/superTabs/host.spec.ts`.

**Interfaces:** `class CommandRetries { constructor(now: () => number); due(key: string): boolean; failed(key: string, error: unknown): void; sent(key: string): void; keep(keys: Iterable<string>): void }`.

- [ ] Failing tests: a permanent refusal is sent once over 12 passes and a new reading once more; a 503 backs off (2–6 sends in two minutes). Red; implement; green; commit.

### Task 4: Alerts stop on a permanent refusal

**Files:** modify `cli/src/superTabs/terminal.ts` `episode`; test `cli/src/superTabs/terminal.spec.ts`.

- [ ] Failing tests: a refused alert is sent once over 20 reads; a 503 backs off (2–8 sends in ten minutes). Red; implement with `CommandRetries` keyed by the episode's operation id; green; commit.

### Task 5: Skill notices stop on a permanent refusal

**Files:** modify `cli/src/superTabs/host.ts` `tellSkill`; test `cli/src/superTabs/host.spec.ts` (built-in skill text).

- [ ] Failing test: a notice refused with `BUDDY_SESSION_THREAD` for one agent is tried once over five minutes of passes, and the other agents are still told. Red; on a permanent refusal `tellSkill` logs it and returns as sent (its record is kept, so nothing resends it); green; commit.

### Task 6: Whole backend suite, CLI tests of what changed, PR evidence

- [ ] `cd backend && npm test` (full unit suite, per the brief); `cd cli && npx vitest run` on the changed specs; `npm run typecheck` in both.
- [ ] PR body names each sender against its count, with before/after commands per minute from the tests; red/green comment.

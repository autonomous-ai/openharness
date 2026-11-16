# The dial lists, follows, talks to and opens herdr's agents over herdr's socket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use diegodev phase 3 to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. A test-first task is two commits: `test(devices): <the task's message> (red)` once its failing tests have been run and seen to fail, then the task's own message.

**Goal:** With herdr running on this computer, every agent herdr sees is on the dial with its live state, hook or no hook; a tap brings its pane forward in herdr, by the command `main` runs today; and the dial's words reach it as its next prompt, only while it is at its prompt.

**Architecture:**
- **One client** (`cli/src/cable/hosts/herdrClient.ts`, new) speaks herdr's socket for listing, status and words only (`agent.list`, `agent.get`, `events.subscribe`, `agent.prompt`): newline-delimited JSON, one request per connection, one held subscription. It checks the socket's owner, bounds every line, and never throws.
- **One source** (`cable/hosts/herdrSource.ts`, new, id `herdr`) lists herdr's agents from one subscription and the `agent.list` that follows it. It runs only while a dial is attached, pushes every change, and polls nothing.
- **The herdr adapter** (`hosts/herdr.ts`) keeps `herdr agent focus <pane>` for a tap, on every platform, and gains `type` over the client. A hooked agent in a herdr pane then takes the dial's words there. The adapter holds one operation per pane, and the herdr source's taps and words go through it.
- **One agent, one row.** `HostAgent` gains `paneKeys`. `HostRegistry` folds two copies from different sources that share a session key or a pane key, and the hook's copy wins over herdr's.
- **`services/devices.ts`** reads the dial's outside agents from the registry's merged list, so a hidden copy gets no card, and runs the herdr source behind `HARNESS_DEVICE_OBSERVED`.
- Everything is in the devices process. Nothing goes through the core, and nothing is stored.

**Tech Stack:** TypeScript daemon (Node, vitest, `cli/`). The end-to-end check runs herdr 0.8.0 as it is installed on this Mac.

**Spec:** `docs/specs/2026-11-16-device-herdr.md`. Read it with this plan, the root `AGENTS.md`, `cli/AGENTS.md` and `cli/src/services/AGENTS.md`.

**Open questions:** none. The five the draft carried were answered on 2026-11-16: Q6 to Q10 under "Decided".

## Base

- `feat/device-herdr`, on `main` at `8fcfa7de5c` (after #4341). Nothing else has to merge first.
- Line numbers in the spec and here are that commit's. The tasks name functions, never lines:
  - `services/devices.ts`: `outside` (:337), `waiting` (:340), `activityText` and `activitySnapshot` (:353), `told`, `showWaits` (:649), the `observed.onChange` turn (:665), `remind` (:711), `dialAttached` (:721), `adapters` (:303), `noting`, `timerIn`, the `setRegistry` call (:452).
  - `cable/hosts/observed.ts`: `ObservedSource.list`, `send`, `first`, `words`, `live`, `Located`.
  - `cable/hosts/registry.ts`: `strength`, `HostRegistry.entries`, `HostRegistry.outside`. `registry.spec.ts:40` is `a host adapter beats observed and loses to harness`.
  - `devices.spec.ts`: `start`, `startHere`, `attach`, `listed`, `said`, `host`, `hook`, `asked`, `machineList`, `calls`, `orcaRuns`, `mac`.
  - `observed.spec.ts`: `setup`, `fakeActions`, `counted`, `HANDLE`. `open.spec.ts`: `recorder`, `tapped`, `target`, `run`, `forward`.
- If a name differs at the base, the implementer follows the code and says so in its report.

## Tasks at a glance

| Task | Files | Depends on | Effort | Test that fails first |
|---|---|---|---|---|
| 1 The herdr client | `cli/src/cable/hosts/herdrClient.ts` (new), `herdrClient.spec.ts` (new), `cli/src/testing/fakeHerdr.ts` (new), `cli/src/cable/hosts/orca.ts` | none | xhigh | `herdrClient.spec.ts` |
| 2 One agent, one row | `cli/src/cable/hosts/types.ts`, `registry.ts`, `registry.spec.ts` | none | high | `registry.spec.ts` |
| 3 The dial's cards read the merged list | `cli/src/services/devices.ts`, `devices.spec.ts` | none | high | `devices.spec.ts` |
| 4 The herdr adapter types over the socket | `cli/src/cable/hosts/adapter.ts`, `herdr.ts`, `herdr.spec.ts`, `observed.ts`, `observed.spec.ts`, `open.spec.ts`, `cli/src/services/devices.ts`, `devices.spec.ts` | 1, 2 | xhigh | `herdr.spec.ts`, `observed.spec.ts`, `devices.spec.ts` |
| 5 The herdr source | `cli/src/cable/hosts/herdrSource.ts` (new), `herdrSource.spec.ts` (new) | 1, 2 | xhigh | `herdrSource.spec.ts` |
| 6 The devices run the herdr source | `cli/src/services/devices.ts`, `devices.spec.ts` | 3, 4, 5 | xhigh | `devices.spec.ts` |
| 7 End to end, a private herdr | `cli/e2e/deviceHerdr.e2e.ts` (new), `cli/e2e/harness/herdrServer.ts` (new) | 6 | high | none: no behavior (the end-to-end test of Tasks 1 to 6) |
| 8 Say it in the docs | `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/specs/2026-11-13-device-without-the-app.md`, `docs/specs/2026-11-15-device-host-adapter.md` | none | medium | none: no behavior |

Longest chain: 1 → 4 → 6 → 7 (or 1 → 5 → 6 → 7): four tasks.

- Tasks 1, 2, 3 and 8 share no file and start at once. Tasks 4 and 5 share no file and run beside each other.
- `services/devices.ts` and `devices.spec.ts` are shared by Tasks 3, 4 and 6, so no two of them run at once. Task 3 needs none of the others: it reads the registry as `main` has it. Task 4 does not need Task 3, only the file.

## Layers

| File | Layer and process | Gate |
|---|---|---|
| `cli/src/cable/hosts/herdrClient.ts`, `herdrSource.ts`, `herdr.ts`, `adapter.ts`, `observed.ts`, `registry.ts`, `types.ts`, `orca.ts` | **Devices service process**, and only there | Their specs |
| `cli/src/services/devices.ts` | **Devices service process** | 100% per file (`npm run test:core`) |
| `cli/src/testing/fakeHerdr.ts` | Test: a fake herdr server on a Unix socket in a temp folder | none |
| `cli/e2e/deviceHerdr.e2e.ts`, `cli/e2e/harness/herdrServer.ts` | Test: the real daemon, a fake dial, a private herdr server | Verification 1 |
| The docs of Task 8 | Repo files, no process | none |

No file under `cli/src/core/` changes, and `cli/src/architecture.coreFiles.txt` gains no line (cli/AGENTS.md, Protect the core, rule 7). `cable/cableHost.ts` (Q7), `cableSession.ts` and `open.ts` do not change.

## Global Constraints

- **The socket.** `$XDG_CONFIG_HOME/herdr/herdr.sock`, else `~/.config/herdr/herdr.sock`, from the daemon's own environment. No named session, no remote server, no other process's environment. Before each connection the path must be a socket owned by this user (`lstat`).
- **Framing.** Newline-delimited JSON. A request is `{"id","method","params"}`. An answer is `{"id","result":{"type",…}}` or `{"id","error":{"code","message"}}`. One request per connection. A subscription's connection is never written to again.
- **Bounds.** A line over 1 MiB, or bad JSON, closes that connection. Every request has a 10 s deadline (`RUN_TIMEOUT_MS`). At most 64 agents are listed. Names are cut to 64 characters, control characters removed. `cwd` is cut to 4096 characters. herdr's `title` is not read.
- **Forms.** A pane id is `^w[0-9]{1,9}:p[0-9]{1,9}$`. A kind is `^[a-z][a-z0-9_-]{0,31}$`. A status is one of `idle`, `working`, `blocked`, `done`, `unknown`. An entry that fails one is left out.
- **Words.** 1 to `MAX_TEXT` (2,000) characters. Control characters become spaces. `agent.prompt` is sent only behind a fresh `agent.get` that reads the same kind, `idle` or `done`.
- **Push, not poll.** One subscription, and `agent.list` once after each. With no socket, a folder watch. A refused connection or a dropped subscription retries after 1 s, doubling to 60 s; after the 60 s retry fails, only the watch. At most one new subscription a second.
- **States.** `idle` is idle, and after `working` or `blocked` it is done with `unseenDone` false; `done` is done with `unseenDone`; `working` is working; `blocked` is needs-you; `unknown` is idle, and voice refuses it.
- **The dial's sentences**, as the observed source says them: `<name> is busy. Say it when it is done.`, `<name> is waiting for your answer in herdr.`, `Too long. Say it shorter.`, `<name> did not answer.` A blocked agent's line is `Waiting for you · herdr`.
- **Counters.** `[device] voice · herdr` when sent; `busy`, `waiting`, `too-long`, `no-answer` when refused.
- **Log lines**, with no id, name, path or text: `[herdr] listed · <n> agents`, `[herdr] closed · <reason code>`, `[herdr] retry · <seconds>`, `[herdr] over · <n> left out`. A reason code is one of the client's fixed words, never text from the socket.
- **The winner.** Harness, then observed, then any listing source. Two copies fold only across different sources, by session key or pane key.
- **The kill switch.** `HARNESS_DEVICE_OBSERVED=off` stops the herdr source too. It runs only while a dial is attached.
- **Capabilities.** A herdr agent is `svf`: no answer, no rest's pane, no last answer, no summary card.
- **Platforms.** macOS and Linux. On Windows the source never runs and the adapter types nothing; a hooked agent's tap runs the command, as on `main`.
- **Focus stays the command.** `herdr agent focus <pane>`, on every platform, as `main` runs it: the pane check, `onPath('herdr')`, the arguments `['agent', 'focus', pane.id]`, `RUN_TIMEOUT_MS` and exit 0 do not change. The socket carries no focus: nothing sends `agent.focus`.
- **One operation per pane.** The herdr adapter holds it, as Orca's switch and send do: a prompt waits for a focus under way on that pane, a focus waits for a prompt under way, a second focus is the same run, and a second prompt is `busy`.
- **Not in this run:** a herdr plugin; named sessions and remote servers; answering a blocked agent from the dial; installing or starting herdr; herdr's own integrations.
- **Repo rules.** No spec touches the developer's herdr (`~/.config/herdr`), daemon (18473), tmux server or dial: the unit suite's home is a throwaway one (`cli/vitest.setup.ts`), and every socket is a fake server's in a temp folder. Socket specs are `describe.skipIf(process.platform === 'win32')`. No fixed sleeps. `src/services` stays at 100% per file.

## Review Focus

1. **herdr's own log sits beside its socket.** herdr writes `herdr-server.log` there on every request. After the retries give up on a stale socket, a change in that folder must connect nothing unless the socket itself was replaced. Task 5, `after giving up, a change beside the same stale socket connects nothing; a replaced socket connects at once`.
2. **A pane the list leaves out is replayed on every subscription** (over 64 agents; a status a newer herdr adds). Its replay must not start another subscription, one a second for ever. Task 5, `a pane the list left out asks for no second subscription`.
3. **A herdr that starts the subscription and drops it, every time.** The retry delay still doubles. Task 5, `a subscription that drops within 60 s does not put the delay back to 1 s`.
4. **Words that are blank once their control characters are spaces** (a transcript of newlines). Nothing is typed. Task 1, `an empty text, one blank once its control characters are spaces … nothing connects`.
5. **The dial detaches while a subscription opens or `agent.list` is in flight.** The late answer lists nothing, and no connection, watch or timer is left. Task 5, `stop while the list is in flight`.
6. **A session id from herdr that is no id** (megabytes long, control characters). The agent is listed with no session key. Task 5, `a session id is taken only for kind id, the pane's own agent, in its form`.

## Decided (PM for Diego, 2026-11-16)

The spec's "Decided" section holds each:

- **Q1.** Voice is `agent.prompt` behind a fresh `agent.get`. Control characters become spaces. `MAX_TEXT` is 2,000.
- **Q2.** The hook's copy wins over herdr's. `registry.spec.ts:40` changes.
- **Q3.** The same kill switch; only while a dial is attached; macOS and Linux.
- **Q4.** The herdr adapter gains `type`, and herdr stays first in the adapter order.
- **Q5.** No herdr plugin.
- **Q6** (the draft's question 1). Focus stays `herdr agent focus <pane>` on every platform, exactly as `main` runs it: `hosts/herdr.ts` keeps `deps.run` and `deps.onPath` for it. The socket is used only for listing, status and words. The herdr source's tap goes through the same adapter `focus`. The client has no `focus`. The adapter keeps one operation per pane between a focus and a prompt.
- **Q7** (question 2). An id the dial still holds after the hook's copy took the row acts as on `main`: refused or ignored until the next list, at most about a second. `cableHost.ts` does not change.
- **Q8** (question 3). herdr's `title` is not read. The name is herdr's name, else the folder's name, else the kind.
- **Q9** (question 4). No workflow changes. The herdr end-to-end file is skipped where herdr is not installed.
- **Q10** (question 5). A herdr agent that goes from `working` or `blocked` to `idle` tells the dial its turn is done, a done card, with `unseenDone` false. `done` from herdr stays done with `unseenDone`. Task 5 pins the state and Task 6 the card.
- **Values.** 64 agents, 1 MiB a line, a 10 s deadline, retries from 1 s doubling to 60 s and then the watch, one new subscription a second, names cut to 64 characters.

## Open questions

None.

## Decided here, where the spec was silent

- **The pane key comes from the adapter.** `HostAdapter` gains `paneKey?`, and only herdr's has one. `observed.ts` then holds no rule about herdr (cli/src/services/AGENTS.md).
- **`type` is given the agent's engine** as a third argument. That is "the kind it was given": the client compares it with what `agent.get` reads.
- **`subscribe` takes three callbacks**, not the spec's two: `started` is the third, as the source closes the old subscription and reads the list on it.
- **One operation per pane lives in the adapter** (Q6), the one file that holds both the command and the client, as `createOrcaActions` holds Orca's switch and send. The client keeps no state per pane.
- **The herdr source prompts through the adapter** (`HerdrSourceDeps.prompt`), not the client, so a listed agent's words keep the pane's order with a tap. The adapter's `prompt` answers the client's `HerdrPrompt`, since the source says `busy` and `failed` in different sentences; `type` is its boolean.
- **On Windows the adapter has no `type`.** The client answers `no_socket` there, so a hooked agent in a herdr pane would list voice and never take a word. With no `type` it lists what it lists on `main`.
- **A turn that ends `idle`** (Q10). The source keeps each agent's herdr status. A status that becomes `idle` from `working` or `blocked`, by an event or by a list read, is the dial's `done` with `unseenDone` false, until herdr's status changes again. `idle` first listed, or after `done` or `unknown`, is idle. Only `idle` ends a turn this way: `unknown` is idle after any status, as the spec's table says. The devices' turn does not change for it: it tells a done card for a change to `done`, as for every outside agent.
- **A relative `XDG_CONFIG_HOME` counts as unset**, as the XDG rule says. The daemon's folder is not herdr's.
- **The watch has three candidates**, as the spec lists them: `<config>/herdr`, `<config>`, the home folder. The nearest that exists is watched.
- **The watch is held only while waiting:** with no socket, and after the retries gave up. A stale socket is told from a new one by its inode and change time.
- **A failed attempt of any kind takes one path:** every subscription closes, and the retries run. A new subscription that does not start while the old one is live counts as a drop.
- **The 1 s between subscriptions counts from each subscription's start, the first included.** So the per-pane status entries come up to a second after the dial attaches, and the list that follows them sets every state again.
- **The retry delay goes back to 1 s only after a subscription was live for 60 s.**
- **Each pane and kind asks for a new subscription once**, until that pane is released, closes or exits. With 64 listed, a detection of another pane asks for none.
- **`unseenDone`** is set when herdr's status becomes `done`, or an agent is first listed `done`. A list that repeats `done` leaves it as it is. `markSeen` and any other status clear it.
- **`lastActivityAt`** is the wall clock at an agent's first listing and at each change of its state.
- **`stop()` empties the list.** A dial that attaches again gets fresh ids.
- **`agent_session.value` is a session id only** when its `kind` is `id`, its `agent` is the pane's kind, and it matches `^[A-Za-z0-9._:-]{1,128}$`.
- **`[herdr] listed`** is said when the count differs from the last one said. `[herdr] over` is said for each list read that leaves any out.
- **A failed prompt's `code`** is herdr's own when it has herdr's form, else a fixed word. The source counts every one as `no-answer`, and nothing logs it.
- **The activity of an outside id the merged list hides answers nothing**, and is never asked of the core.
- **A copy folded away still folds the next source's copy** of the same agent: its keys count.
- **The devices' test seam is the client** (`DevicesDeps.herdr`) and the watch (`DevicesDeps.herdrWatch`), so `devices.spec.ts` opens no socket. A focus runs through the seam the apps' commands already have (`DevicesDeps.orca`), which runs nothing. The real client, source and a fake server meet in `herdrSource.spec.ts`.
- **The fake server is `cli/src/testing/fakeHerdr.ts`**, beside the suite's other test helpers.
- **The end-to-end file is skipped where herdr is not installed** (Q9). It never starts herdr against the developer's own config.
- **The end-to-end daemon's `herdr` is a wrapper of the test's own.** The daemon under test has none on its `PATH` (`e2e/harness/daemon.ts`), and its `herdr agent focus` must reach the test's server alone. `PrivateHerdr.start` writes one into the daemon's `bin` folder that sets `XDG_CONFIG_HOME` to the throwaway home's and runs the installed herdr.
- **The docs task** is not in the spec. `cli/AGENTS.md` lists what the devices process does, and two older specs state the rules this one reverses.

---

### Task 1: The herdr client

**Layer:** devices service process. **Depends on:** none. **Effort:** `xhigh` (a socket of another program; outside input; the dial's words).

**Red test:** `cli/src/cable/hosts/herdrClient.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/herdrClient.ts`, `cli/src/testing/fakeHerdr.ts`
- Modify: `cli/src/cable/hosts/orca.ts` (`CONTROL` gains `export`; nothing else)
- Test: `cli/src/cable/hosts/herdrClient.spec.ts`

**Interfaces:**
- Consumes: `RUN_TIMEOUT_MS`, `MAX_TEXT`, `CONTROL` (`./orca.js`).
- Produces, in `herdrClient.ts`:
  ```ts
  export const HERDR_PANE = /^w[0-9]{1,9}:p[0-9]{1,9}$/
  export const HERDR_KIND = /^[a-z][a-z0-9_-]{0,31}$/
  export const MAX_LINE_BYTES = 1024 * 1024
  /** The key a hooked copy and a listed copy of one agent share (registry.ts). */
  export const herdrPaneKey = (paneId: string): string => `herdr:${paneId}`

  export interface HerdrClientDeps { socketPath: string; home: string; uid: number; platform: NodeJS.Platform }
  export function herdrSocketPath(vars: NodeJS.ProcessEnv, home: string): string
  export function herdrClientDeps(): HerdrClientDeps   // process.env, homedir(), process.getuid(), process.platform

  /** Why a connection gave no answer, or a subscription ended: the word its log line says. */
  export type HerdrFault = 'no_socket' | 'refused' | 'timeout' | 'ended' | 'oversize' | 'bad_json' | 'bad_answer' | 'rejected'
  export type HerdrAnswer = { ok: true; result: Record<string, unknown> } | { ok: false; code: string }
  export type HerdrPrompt = { outcome: 'sent' | 'busy' } | { outcome: 'failed'; code: string }
  export type HerdrEntry = { type: 'pane.agent_detected' | 'pane.closed' | 'pane.exited' } | { type: 'pane.agent_status_changed'; pane_id: string }
  export interface HerdrSubscriber {
    started(): void
    event(name: string, data: Record<string, unknown>): void
    closed(reason: HerdrFault): void
  }
  export interface HerdrClient {
    request(method: string, params: Record<string, unknown>): Promise<HerdrAnswer>
    subscribe(entries: readonly HerdrEntry[], to: HerdrSubscriber): { close(): void }
    prompt(paneId: string, kind: string, text: string): Promise<HerdrPrompt>
    /** The socket's inode and change time while it is a socket of this user's; else none. */
    socketStamp(): string | undefined
  }
  export function createHerdrClient(deps: HerdrClientDeps): HerdrClient
  /** Calls `changed` on each change in the nearest existing folder of `<config>/herdr`, `<config>` and `home`, moving
   *  to a nearer one as it appears. Returns its stop. Never throws: a watch that cannot be held tells nothing. */
  export function watchHerdrSocket(deps: Pick<HerdrClientDeps, 'socketPath' | 'home'>, changed: () => void): () => void
  ```
- Rules:
  - `herdrSocketPath`: `join(<config>, 'herdr', 'herdr.sock')`, where `<config>` is `vars.XDG_CONFIG_HOME` when it is absolute, else `join(home, '.config')`.
  - **Before each connection:** `socketStamp()` is undefined (no file, not a socket, another owner, or `win32`): `no_socket`, and nothing connects.
  - **`request`:** one connection, the line `{"id":<a fresh id>,"method","params"}`, the first line back. It answers once and closes the connection.
    - `result` an object, under its own id: `{ ok: true, result }`.
    - `error`, under its own id or `""`: `{ ok: false, code }`, the code herdr's when it matches `^[a-z][a-z0-9_]{0,63}$`, else `bad_answer`.
    - Any other object, or another id: `bad_answer`. Not an object: `bad_json`. A line over `MAX_LINE_BYTES`: `oversize`.
    - The connection did not open: `refused`. It ended first: `ended`. Nothing in `RUN_TIMEOUT_MS`: `timeout`.
  - **`subscribe`:** one connection, the line `{"id","method":"events.subscribe","params":{"subscriptions":entries}}`, and never another.
    - `{"result":{"type":"subscription_started"}}` calls `started()`. Each later line `{"event","data"}` calls `event(event, data)`, in order.
    - Before `started`: an error answer is `closed('rejected')`; 10 s with none is `closed('timeout')`. No deadline after.
    - At any time: the connection ending is `closed('ended')`; an oversize or non-object line closes it, `oversize` or `bad_json`.
    - `closed` is called once, and nothing after it. The caller's own `close()` ends the connection and calls nothing.
  - **`prompt`:** a pane id or a kind not in its form, a text that is empty, over `MAX_TEXT`, or blank once its control characters are spaces: `{ outcome: 'failed', code: 'bad_request' }`, and nothing connects. Then:
    1. `request('agent.get', { target: paneId })`. Not ok: `failed` with its code. `result.agent.agent` is not `kind`: `failed`, `not_that_agent`. `result.agent.agent_status` is neither `idle` nor `done`: `busy`.
    2. `request('agent.prompt', { target: paneId, text: text.replace(CONTROL, ' ') })`. Ok: `sent`. Else `failed` with its code. Nothing is sent twice.
  - **No focus, and no state per pane** (Q6): a tap is the adapter's command, and the adapter orders a prompt with it (Task 4).
  - No member throws or rejects. The file logs nothing.
- Produces, in `cli/src/testing/fakeHerdr.ts`: `fakeHerdr(): Promise<FakeHerdr>`, a server on `<a fresh temp folder>/herdr.sock` that behaves as the spike saw herdr 0.8.0 behave.
  - It records every request with its connection, and resolves `got(method, n)` when the n-th of a method has arrived, so no spec polls.
  - It closes a connection after its answer. A subscription's connection stays open, and a second request on it closes it.
  - `events.subscribe` answers `subscription_started`, then one `pane_agent_detected` per agent it holds. `agent.list` and `agent.get` answer from those agents. On a pane that holds one, `agent.prompt` answers `{"type":"agent_prompted"}`. `agent.get` and `agent.prompt` on a pane with no agent answer `agent_not_found`.
  - A test sets any method's answer (a result, an error code, or no answer), sends an event or raw bytes to the live subscriptions, drops them, and stops the server, with `stale()` leaving the socket file with nothing listening (the file renamed aside while the server closes, then back).
  - `RECORDED`: the spike's three recordings as arrays of lines, `status` (`sub.out`), `replay` (`sub2.out`) and `released` (`sub3.out`), copied from `/private/tmp/claude-503/-Users-duynguyen-orca-workspaces-autonomous-harness-device-herdr/8ce1c434-3c5a-4cca-b0c0-793e2f802d97/scratchpad/spike/recorded/`. Every `cwd` and `foreground_cwd` reads `/work/hh`, and the `[timeout]` lines are dropped.

- [ ] **Step 1: Write `fakeHerdr.ts` and the failing tests** in `herdrClient.spec.ts`, `describe.skipIf(process.platform === 'win32')`. Each client is `createHerdrClient({ socketPath: server.path, home: dir, uid: process.getuid!(), platform: process.platform })`. Deadlines run on `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`, after `await server.got(…)`.
  - `the socket is $XDG_CONFIG_HOME/herdr/herdr.sock, else ~/.config/herdr/herdr.sock; a relative XDG_CONFIG_HOME counts as unset`.
  - `request writes one line and answers the result`: the server got `{ id: expect.any(String), method: 'agent.list', params: {} }`; the answer is `{ ok: true, result: { type: 'agent_list', agents: [] } }`.
  - `each request is a connection of its own`: two requests, two connections, one line each.
  - `an error answers its code, under its own id or ""; a code not in herdr's form is bad_answer`: `agent_not_found`, `invalid_request`, then `'Bad Code!'`.
  - `an answer under another id, or with neither result nor error, is bad_answer; a line that is no object is bad_json; one over 1 MiB is oversize`.
  - `no socket, a file that is no socket, and another user's socket are no_socket, and nothing connects` (`uid: process.getuid!() + 1`).
  - `a stale socket is refused; a connection that ends before its answer is ended; none in 10 s is timeout, and its connection closes`.
  - `subscribe writes one line, calls started, then each event with its name and data`: with `RECORDED.replay`, `started` once, then two `['pane_agent_detected', { agent: 'claude', pane_id: 'w1:p1' | 'w2:p1', … }]`. With `RECORDED.released`, the five events in order, `pane.agent_status_changed` and `pane_closed` among them.
  - `events in the chunk that holds subscription_started, and a line split across two chunks, are each told once`.
  - `a subscription is closed once: rejected, timeout, ended, oversize, bad_json`: one case each, and no call after `closed`.
  - `close() ends the connection and calls nothing`.
  - `a subscription's connection is written to once`, and the fixture's own pin: `the fake server, as herdr, closes a subscription sent a second request`.
  - `prompt reads the pane again, then sends the line`: for `idle` and for `done`, the requests are `agent.get { target: 'w1:p1' }` then `agent.prompt { target: 'w1:p1', text: 'run the tests' }`; the answer is `{ outcome: 'sent' }`.
  - `prompt to a working, blocked or unknown agent is busy, and nothing is sent`.
  - `a pane that holds another kind is failed, not_that_agent; a pane with no agent is failed, agent_not_found`.
  - `herdr's refusals of the prompt come back with their code`: `agent_not_ready`, `agent_not_found`, `empty_agent_prompt`; a timeout of either request is `{ outcome: 'failed', code: 'timeout' }`.
  - `control characters become spaces`: `'fix it\nrm -rf /\u001b[2J'` is sent as `'fix it rm -rf / [2J'`.
  - `an empty text, one blank once its control characters are spaces, one over 2000 characters, a pane id or a kind not in its form: failed, bad_request, and nothing connects`: `''`, `'\n\t'`, 2001 characters (2000 is sent), `'w1'`, `'--help'`, `'w1:p1; rm -rf /'`, kind `'Claude'`.
  - `socketStamp is none without a socket of this user's, and another once a server starts again at the same path`.
  - `the watch tells of the nearest existing folder`: with no `herdr` folder, a file made in `<config>` is told; once `<config>/herdr` exists, a file made in it is told; with no `<config>`, a file made in `home` is told; after its stop, nothing is. Real temp folders, awaited with `vi.waitFor`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdrClient.spec.ts`. Expected: FAIL (no `./herdrClient.js`).
- [ ] **Step 3: Implement** `herdrClient.ts` as "Interfaces" says. Its header says why each field is checked here (the socket is another program's, the pane id came from a hook or from herdr, the text from the dial), why `agent.get` comes first (herdr types into a working agent: the spec's spike), and why the file logs nothing. Watchers and sockets are unref'd.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable/hosts/orca.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: a client for herdr's socket: lists, status and words, one request a connection`.

### Task 2: One agent, one row

**Layer:** devices service process. **Depends on:** none. **Effort:** `high`.

**Red test:** `cli/src/cable/hosts/registry.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/types.ts`, `cli/src/cable/hosts/registry.ts`
- Test: `cli/src/cable/hosts/registry.spec.ts`

**Interfaces:**
- Produces, in `types.ts`: `HostAgent.paneKeys?: readonly string[]`, "the keys another source may know the same agent by, beside its session: only herdr's pane, `herdr:<pane id>`". The comment on `HostSource.id` names a listing source (`herdr`).
- Produces, in `registry.ts`:
  - `strength`: `harness` 0, `observed` 1, any other 2.
  - `entries()`: sources in strength order. An agent is folded away when its session key is taken (as today), when its caller pid is taken (as today), or when one of its `paneKeys` is taken **by another source**. Listed or folded, it takes its keys.
  - `outside()` is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `registry.spec.ts:40` becomes `observed beats a listing source and loses to harness`: `herdr` `{ id: 'x', sessionId: 's' }` and `observed` `{ id: 'o', sessionId: 's' }` give `['o']`, in either order given; with `harness` `{ id: 'h', sessionId: 's' }`, `['h']`.
  - `two copies from different sources that share a pane key are one agent, the stronger source's`: `observed` `{ id: 'o', sessionId: 's1', paneKeys: ['herdr:w1:p1'] }`, `herdr` `{ id: 'x', paneKeys: ['herdr:w1:p1'] }` (no session id): `['o']`.
  - `two agents of one source that share a pane key are both listed`: `observed` `o1` and `o2`, sessions `s1` and `s2`, both `['herdr:w1:p1']`, and `herdr` `x` with that key: `['o1', 'o2']`.
  - `another pane, and no pane key at all, fold nothing`: `herdr` `{ id: 'x', paneKeys: ['herdr:w2:p1'] }` beside `o`: `['o', 'x']`.
  - `a copy folded away still folds the next source's copy`: `harness` `{ id: 'h', sessionId: 's' }`, `observed` `{ id: 'o', sessionId: 's', paneKeys: ['herdr:w1:p1'] }`, `herdr` `{ id: 'x', paneKeys: ['herdr:w1:p1'] }`: `['h']`.
  - `outside finds a listing source's copy by its id, the merged list folding it away or not`: with `o` and `x` folded to `['o']`, `reg.outside('x')?.id` is `'x'`, and `reg.outside('o')?.id` is `'o'`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/registry.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The comment over `strength` says why the hook's copy wins (the spec, "The winner").
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: a hooked copy and a listed copy of one agent are one row, the hook's`.

### Task 3: The dial's cards read the merged list

**Layer:** devices service process. **Depends on:** none (it shares `devices.ts` and `devices.spec.ts` with Tasks 4 and 6). **Effort:** `high` (`services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Produces, in `devices.ts`:
  ```ts
  const registry = new HostRegistry(observed ? [cableHost.harness, observed] : [cableHost.harness])   // handed to setRegistry
  /** The agents outside Harness the dial lists, each with its source: the merged list's, so a copy a stronger source
   *  hides gets no card. */
  const outsideEntries = (): HostEntry[]            // registry.entries() whose source is not Harness
  const outside = (agentId: string): HostEntry | undefined
  const waiting = (entry: HostEntry): string | null // asks observed.waitingOn only when entry.source is observed
  ```
- What moves:

  | Reader | Today | After |
  |---|---|---|
  | `outside`, and its callers `dropEnded`, `followPrompt`, `claudeAttached`, `claudeSettled` | `observed.list()` | `outsideEntries()` |
  | `waiting` | `observed.waitingOn` for any agent | For the observed source's agents only; any other needs-you agent reads `Waiting for you · <host>` |
  | `showWaits` | `observed.list()` with a question's text | `outsideEntries()` of the observed source with a question's text |
  | The `onChange` turn, and what `told` keeps | `observed.list()` | `outsideEntries()`; the turn is one named function, so a second source can run it (Task 6) |
  | `remind` | `observed.list()` mid-turn | `outsideEntries()` mid-turn |
  | `activityText`, `activitySnapshot` | An id `observed` lists, else the core | A listed outside agent: its line. An id `registry.outside` holds though the list hides it: nothing. Else the core |

- [ ] **Step 1: Write the tests**, in `describe('agents outside a pane, …')`, with a core whose `advertised` is `[{ agentId: 'h1', registeredAt: 1, engine: 'claude', sessionId: 'sess-1' }]`, the dial attached, and `await machineList(port)` read once (it binds `h1` to `sess-1`, so the merged list is `['h1']`).
  - `a session a Harness agent holds gets no card, question or reminder as an outside agent`: after `hook('turn-start')`, `asked()`, `hook('turn-stop')` and `REMIND_MS`, no call of `turnStarted`, `question`, `turnDone` or `summary` names `ID`. This is the red test.
  - `the activity of an outside id the merged list hides is not asked of the core` (a pin: it passes before and after): `host().activityText(ID)` and `host().activitySnapshot(ID)` are null, and `core.agents.activityText` and `activitySnapshot` were never called with `ID`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the first test only (`turnStarted` holds a call for `ID`).
- [ ] **Step 3: Implement.** The comment over `outsideEntries` says why the merged list is read (a hidden copy must get no second card).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`, and no existing expectation of `devices.spec.ts` edited. One that has to change is a finding: stop and report it.
- [ ] **Step 5: Commit** `devices: cards, questions and reminders go to the outside agents the dial lists`.

### Task 4: The herdr adapter types over the socket

**Layer:** devices service process. **Depends on:** Tasks 1 and 2. **Effort:** `xhigh` (the dial's words typed into a terminal; a prompt and a focus ordered on one pane).

**Red test:** `cli/src/cable/hosts/herdr.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`, `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/cable/hosts/adapter.ts`, `cli/src/cable/hosts/herdr.ts`, `cli/src/cable/hosts/observed.ts`, `cli/src/services/devices.ts`
- Test: `cli/src/cable/hosts/herdr.spec.ts`, `cli/src/cable/hosts/observed.spec.ts`, `cli/src/cable/hosts/open.spec.ts`, `cli/src/services/devices.spec.ts`

One task, not two: `createHerdrAdapter`'s deps gain the client, so the adapter and its callers change together or the typecheck fails between them.

**Interfaces:**
- Consumes: `HerdrClient`, `HerdrPrompt`, `HERDR_PANE`, `herdrPaneKey`, `createHerdrClient`, `herdrClientDeps` (Task 1); `HostAgent.paneKeys` (Task 2); `OrcaDeps`, `RUN_TIMEOUT_MS` (`./orca.js`, as today).
- Produces, in `adapter.ts`:
  ```ts
  /** Types a line at the agent's prompt and submits it; `engine` is the agent's, for an app that checks who holds the
   *  pane. Only the source decides that the prompt is free. */
  type?(pane: Pane, text: string, engine: string): Promise<boolean>
  /** The key a source that lists this app's agents knows the same pane by (registry.ts). Only an app with such a
   *  source has one. */
  paneKey?(pane: Pane): string
  ```
- Produces, in `herdr.ts`:
  ```ts
  export interface HerdrAdapterDeps extends OrcaDeps { client: Pick<HerdrClient, 'prompt'> }
  export interface HerdrAdapter extends HostAdapter {
    paneKey(pane: Pane): string
    /** The dial's words for that pane, in the pane's turn with a focus: the herdr source's door too (herdrSource.ts). */
    prompt(paneId: string, kind: string, text: string): Promise<HerdrPrompt>
  }
  export function createHerdrAdapter(deps: HerdrAdapterDeps): HerdrAdapter
  ```
  - `id`, `tap`, `paneOf`, `canFocus`, no `show`: as today, on every platform.
  - **`focus` runs what `main` runs** (Q6): a pane id not in its form is false; no `herdr` on `PATH` (`deps.onPath('herdr')`) is false; else `deps.run(herdr, ['agent', 'focus', pane.id], RUN_TIMEOUT_MS)`, true on exit 0. Two things are new around it: a focus under way for that pane is that same run, and the command waits for a prompt under way on that pane.
  - **`prompt`:** a prompt under way for that pane answers `{ outcome: 'busy' }` and asks the client nothing. Else it waits for a focus under way on that pane, then answers `deps.client.prompt(paneId, kind, text)`. The pane is free again after any answer.
  - **`type`:** `(await prompt(pane.id, engine, text)).outcome === 'sent'`. Left out when `deps.platform` is `win32` ("Decided here").
  - **`paneKey`:** `herdrPaneKey(pane.id)`.
  - Its own `HERDR_PANE` goes: it imports Task 1's, the same form.
- Produces, in `observed.ts`:
  - `send` hands the typing adapter the engine: `typer.adapter.type!(typer.pane, text, e.agent.engine)`.
  - `list()`: a live entry carries `paneKeys`, each of its panes' `adapter.paneKey?.(pane)`. The field is left out when it has none, and for an ended entry.
  - Nothing else changes: its idle rules decide, and `count(adapter)` says `herdr`.
- Produces, in `devices.ts`:
  - `DevicesDeps.herdr?: HerdrClient`: for this service's tests, herdr's socket.
  - `const herdrClient = deps.herdr ?? createHerdrClient(herdrClientDeps())`.
  - `const herdrAdapter = createHerdrAdapter({ ...apps, client: herdrClient })`, first in `adapters`, as today.

- [ ] **Step 1: Write the failing tests.**
  - `herdr.spec.ts`. Its `recorder` gains a recording fake client beside its runner: `prompt` answers what the test sets, `{ outcome: 'sent' }` by default.
    - Four tests stay, not one expectation edited, and pin Q6: `paneOf takes a pane id, and refuses any other`, `focus focuses the agent`, `with no herdr on PATH nothing runs`, `a pane id not in its form runs nothing`.
    - The first test becomes `its id is herdr, it taps before its app, it types, and it has no show`.
    - `type sends the words with the agent's engine, and is true only when sent`: the client's `prompt` got `['w1:p2', 'claude', 'next']`; `busy` and `failed` are false.
    - `prompt answers what the client answered`: `{ outcome: 'sent' }`, `{ outcome: 'busy' }`, `{ outcome: 'failed', code: 'agent_not_ready' }`.
    - `paneKey is herdr:<pane id>`.
    - `on Windows it has no type, and a tap runs the same command` (`platform: 'win32'`): `adapter.type` is undefined; `paneOf` answers the pane; `focus` is true and the calls are `[focusCall('w1:p2')]`.
    - `one operation per pane at a time`, with a client prompt and a runner the test holds open:
      - a second prompt for that pane is `{ outcome: 'busy' }`, and the client was asked once;
      - another pane's prompt runs;
      - a focus for that pane runs its command only once the prompt has answered;
      - a second focus while one runs is one command, and both answer its result;
      - a prompt asks the client only once a focus under way has ended;
      - the pane is free again after `sent`, `busy`, `failed`, and a focus that failed.
  - `observed.spec.ts`:
    - `fakeActions` gains `herdrPrompt: vi.fn(async (_pane: string, _kind: string, _text: string): Promise<HerdrPrompt> => ({ outcome: 'sent' }))`, and builds `createHerdrAdapter({ ...deps, client: { prompt: fake.herdrPrompt } })`. A herdr focus still goes to `ran`.
    - The `it.each` of `%s inside an Orca terminal still takes the dial's words and a rest through Orca` keeps its WezTerm row. herdr's becomes `herdr inside an Orca terminal takes the dial's words through herdr, and a rest through Orca`: `herdrPrompt` got `[['w1:p2', 'claude', 'next']]`, `orcaSend` was not called, the count is `herdr`, the rest runs `orcaSwitch` with `HANDLE`, and the tap's pane id is `'w1:p2'`.
    - `a hooked agent in a herdr pane lists voice, and takes words only at its prompt`, with `{ HERDR_PANE_ID: 'w1:p2' }`: after `turn-stop`, caps are `{ status: true, voice: true, focus: true, answer: false }`. Working: `proj is busy. Say it when it is done.`, and `herdrPrompt` is not called. Needs-you: `proj is waiting for your answer in herdr.`
    - `a prompt herdr did not take is no answer, and its turn is a person's`: `herdrPrompt` answering `{ outcome: 'busy' }`, then `{ outcome: 'failed', code: 'agent_not_ready' }`: `proj did not answer.`; the next `turn-start` answers `'person'`.
    - `a live agent in a herdr pane carries its pane key`: `list()[0].paneKeys` is `['herdr:w1:p2']`. An ended one, one in Orca alone and one the scan found have no `paneKeys` field.
  - `open.spec.ts`: `recorder` and `tapped` hand `createHerdrAdapter` a client beside their deps, whose `prompt` no test calls. No expectation changes: each `run('/fake/bin/herdr', 'agent', 'focus', 'w1:p2')` stays, which pins Q6 at the tap.
  - `devices.spec.ts`:
    - Beside `codex`: `herdrCalls`, and a recording `herdr` client. Its `prompt` answers `{ outcome: 'sent' }`, its `request` `{ ok: false, code: 'no_socket' }`, its `subscribe` calls `closed('no_socket')` at once, and its `socketStamp` answers none. `start` passes `herdr: over.herdr ?? herdr`. `herdrCalls` is emptied in `beforeEach`.
    - In the mod-and-Orca describe, `a hooked agent in a herdr pane takes the dial's words through herdr's socket, ahead of Orca`: a Claude `turn-stop` with `{ HERDR_PANE_ID: 'w1:p2', ORCA_TERMINAL_HANDLE: HANDLE }`; started with `startHere({ orca: mac })`; `listed()` has caps `svf`; `host().sendTurn(id, 'run the tests')` is `{ ok: true }`; `herdrCalls` is `[['prompt', 'w1:p2', 'claude', 'run the tests']]`; `orcaRuns` is `[]`; `said()` ends with `'[device] voice · herdr'`.
    - `a tap on a hooked agent in a herdr pane runs herdr agent focus, then brings its app forward` (a pin of Q6: it passes before and after): hints `{ HERDR_PANE_ID: 'w1:p2' }`, started with `` startHere({ orca: { ...mac, onPath: (name: string) => `/opt/${name}/bin/${name}` } }) ``. `orcaRuns` is `[['/opt/herdr/bin/herdr', ['agent', 'focus', 'w1:p2'], 10_000], ['/usr/bin/open', ['-b', 'dev.herdr.app'], 10_000]]`, and `herdrCalls` is `[]`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdr.spec.ts src/cable/hosts/observed.spec.ts src/cable/hosts/open.spec.ts src/services/devices.spec.ts`. Expected: FAIL in the new and changed tests; `open.spec.ts`, the four kept tests of `herdr.spec.ts` and the tap's pin pass.
- [ ] **Step 3: Implement.** `herdr.ts`'s header says why a tap stays the command (one way to focus on every platform; herdr's socket on Windows is a named pipe), why words go to herdr before Orca (the spec, Q4), and that the pane's turn is held here because this file alone holds both.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, and 100% for `services/devices.ts`. Then `git grep -nF "['agent', 'focus', pane.id], RUN_TIMEOUT_MS" -- cli/src/cable/hosts/herdr.ts` prints one line, and `git grep -nF "agent.focus" -- cli/src` prints nothing.
- [ ] **Step 5: Commit** `dial: a hooked agent in a herdr pane takes the dial's words over herdr's socket`.

### Task 5: The herdr source

**Layer:** devices service process. **Depends on:** Tasks 1 and 2. **Effort:** `xhigh` (reconnects, two subscriptions at once, late answers, outside input).

**Red test:** `cli/src/cable/hosts/herdrSource.spec.ts`.

**Files:**
- Create: `cli/src/cable/hosts/herdrSource.ts`
- Test: `cli/src/cable/hosts/herdrSource.spec.ts`

**Interfaces:**
- Consumes: `HerdrClient`, `HerdrEntry`, `HerdrFault`, `HerdrPrompt`, `HERDR_PANE`, `HERDR_KIND`, `herdrPaneKey` (Task 1); `HostAgent.paneKeys` (Task 2); `MAX_TEXT` (`./orca.js`); `fakeHerdr`, `RECORDED` (Task 1, in the spec).
- Produces:
  ```ts
  export interface HerdrSourceDeps {
    client: Pick<HerdrClient, 'request' | 'subscribe' | 'socketStamp'>
    /** Tells of each change where herdr's socket lives (herdrClient.ts watchHerdrSocket), until its stop is called. */
    watch(changed: () => void): () => void
    /** The dial's words: the herdr adapter's prompt, which keeps the pane's turn with a tap (herdr.ts). */
    prompt(paneId: string, kind: string, text: string): Promise<HerdrPrompt>
    /** A tap: the herdr adapter's focus, as the devices hold it. */
    focus(paneId: string): Promise<boolean>
    /** A timer, as the devices' parts take theirs: its cancel is returned. */
    after(ms: number, run: () => void): () => void
    /** The wall clock, for `lastActivityAt`; and a clock that never steps back, for how long a subscription lived. */
    now(): number
    monotonic(): number
    uuid(): string
    platform: NodeJS.Platform
    log(line: string): void
    count(what: 'herdr' | 'busy' | 'waiting' | 'too-long' | 'no-answer'): void
  }
  export class HerdrSource implements HostSource {
    readonly id = 'herdr'
    constructor(deps: HerdrSourceDeps)
    start(): void
    stop(): void
    onChange(listener: () => void): () => void
    list(): HostAgent[]
    capabilities(): Caps                       // { status: true, voice: true, focus: true, answer: false }
    markSeen(agentId: string): void
    send(agent: HostAgent, text: string): Promise<SendResult>
    focus(agent: HostAgent): Promise<boolean>
  }
  ```
- Rules, running:
  - `start()` does nothing on `win32`, or when it already runs. Else it connects.
  - `stop()` closes every subscription, the watch and every timer of its own, and empties the list. An answer that comes later changes nothing.
- Rules, connecting:
  - **Connect:** with no `socketStamp()`, it waits. Else it opens a subscription: the three kinds, and one `pane.agent_status_changed` for each listed pane and each pane that asked, 64 at most.
  - **`started`:** the subscription it replaces is closed, then `request('agent.list', {})`. Ok with an `agents` array: the list is set (below), and the subscription is live. Anything else fails the attempt.
  - **`closed(reason)`** of the newest subscription: `[herdr] closed · <reason>`, and the attempt fails.
  - **A failed attempt:** every subscription closes. If one was live, the agents stay listed for the retry; with none live, the list empties. Then:
    - `no_socket`: it waits.
    - Else it retries after the delay, saying `[herdr] retry · <seconds>`: 1 s, then doubling to 60 s. When the attempt after the 60 s delay fails, it remembers `socketStamp()` and waits.
    - The delay goes back to 1 s only when the subscription that dropped had been live for 60 s.
  - **Waiting:** the list is empty, no timer runs, and the watch is held. On each change: when `socketStamp()` answers one that is not the remembered stamp, the watch stops and it connects.
  - **A new subscription** opens at once when the last one opened a second ago or more, else when that second ends: one timer, and every ask meanwhile joins it. The old subscription stays open until the new one's `started`.
- Rules, the list (`agent.list`'s `agents`):
  - Each entry is checked: `pane_id` (`HERDR_PANE`), `agent` (`HERDR_KIND`), `agent_status` (the enum). One that fails is left out.
  - The first 64 that pass are the list. More: `[herdr] over · <n> left out`.
  - A pane and kind already listed keeps its `id`. A new one gets `uuid()`. One no longer named is dropped.
  - Fields: `engine` the kind; `cwd` a string cut to 4096; `name` herdr's `name` with control characters removed and cut to 64, else the folder's name the same way, else the kind (`title` is not read, Q8); `host` and `app` `herdr`; `paneKeys` `[herdrPaneKey(pane_id)]`; `sessionId` as "Decided here" says.
  - State from the table in "Global Constraints", from each agent's herdr status and the one before it: `idle` after `working` or `blocked` is `done` with `unseenDone` false (Q10; "A turn that ends `idle`" under "Decided here"). `unseenDone` and `lastActivityAt` as "Decided here" says.
  - `[herdr] listed · <n> agents` when the count differs from the last one said. One `onChange` when anything a row shows changed.
  - A listed pane with no status entry in the live subscription asks for a new subscription.
- Rules, events (the newest started subscription's only):
  - `pane_agent_detected` with `released: true`, `pane_closed`, `pane_exited`: that pane is dropped at once, and may ask again.
  - `pane_agent_detected` otherwise, its `pane_id` and `agent` in their forms: listed with that kind, nothing. Else it asks for a new subscription, once for that pane and kind, and only while fewer than 64 are listed.
  - `pane.agent_status_changed` for a listed pane of that kind, its status in the enum: the state is set, by the same rule as a list read.
  - Any other event, and any field not in its form: nothing.
- Rules, the verbs:
  - `send`, in this order: over `MAX_TEXT`, `too-long`. Not listed, `no-answer`. Needs-you, `waiting`. herdr's status `working` or `unknown`, or a send under way for that pane, `busy`. Then `deps.prompt(paneId, kind, text)`: `sent` counts `herdr` and answers `{ ok: true }`; `busy` is `busy`; `failed` is `no-answer`. Each refusal counts once and answers its sentence. The refusals read herdr's status, so an agent whose turn ended `idle` (the dial's done) takes words.
  - `focus`: `deps.focus(paneId)` for a listed agent, else false.
  - `markSeen`: clears `unseenDone`, one `onChange`. It asks herdr nothing.

- [ ] **Step 1: Write the failing tests** in `herdrSource.spec.ts`, `describe.skipIf(process.platform === 'win32')`. `setup()` is a `fakeHerdr()`, the real `createHerdrClient` on its path, `prompt` a spy over that client's `prompt`, `focus` a spy, a timer queue the test runs by hand for `after`, a `watch` the test fires by hand, `uuid` answering `u1`, `u2`, …, and two clocks the test sets. Every wait is on `server.got(…)` or the source's `onChange`.
  - `started with herdr running, its agents are listed with their fields`: one agent `{ pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle', cwd: '/work/api' }`; `list()` is `[{ id: 'u1', engine: 'claude', cwd: '/work/api', name: 'api', host: 'herdr', app: 'herdr', state: 'idle', unseenDone: false, lastActivityAt: <now>, paneKeys: ['herdr:w1:p1'] }]`; the log is `['[herdr] listed · 1 agents']`.
  - `the first subscription names the three kinds; the next adds one status entry a pane`: the second `events.subscribe` holds `{ type: 'pane.agent_status_changed', pane_id: 'w1:p1' }`, a second after the first, and `agent.list` follows each.
  - `the new subscription opens before the old one closes`: the server saw the second request before the first connection ended.
  - `each herdr state is its dial state`: first listed `idle` (`idle`), `done` (`done`, `unseenDone: true`), `working`, `blocked` (`needs-you`), `unknown` (`idle`), by event and by list.
  - `a turn that ends idle is done with nothing unseen; herdr's done is done and unseen` (Q10):
    - `working` then `idle`: `{ state: 'done', unseenDone: false }`, one `onChange`; the same after `blocked`;
    - the same when a list read after a reconnect says `idle` for an agent last heard `working`;
    - a list that repeats `idle` leaves it done, and tells nothing;
    - `working` then `done`: `{ state: 'done', unseenDone: true }`;
    - `done` then `idle`, `unknown` then `idle`, and `working` then `unknown`: `idle`, `unseenDone: false`.
  - `a status event sets the state, and tells once`: with `RECORDED.status`'s three events (`working`, `blocked`, `idle`): `working`, `needs-you`, then `done` with nothing unseen, three `onChange`.
  - `a replay for listed panes changes nothing and opens nothing` (`RECORDED.replay`).
  - `a released detection, a closed pane and an exited pane each drop the pane at once` (`RECORDED.released`): `w2:p1` goes at the released line; the `unknown` status after it changes nothing; no new subscription.
  - `a pane not yet known asks for one new subscription, and detections within the second join it`: three detections give one more `events.subscribe`, with all three panes.
  - `a pane the list left out asks for no second subscription`: an agent whose status is `paused`, replayed on each subscription: one new subscription, then none.
  - `65 agents: 64 listed, one log line, and a detection of another pane starts no subscription`: `[herdr] over · 1 left out`.
  - `an entry with a bad pane id, kind or status is left out, the rest listed`: `'w1'`, `'Claude'`, null, `'paused'`.
  - `a name is herdr's, else the folder's, else the kind; cut to 64, control characters removed; a title is not read`: an entry with a `title` and no `name` takes its folder's name.
  - `a session id is taken only for kind id, the pane's own agent, in its form`: `{ agent: 'claude', kind: 'id', value: 'abc-123' }` gives `sessionId: 'abc-123'`; `kind: 'path'`, another `agent`, a value of 129 characters and one with a newline give none, and the agent is still listed.
  - `the id is kept across a reconnect while the pane stays listed, and is another once it left`.
  - `done is unseen until the dial turns to it; a list that repeats done leaves it seen`.
  - `with no socket it watches, and connects when the socket appears`: no timer in the queue; after the server starts and the watch fires, the agents are listed.
  - `a dropped subscription keeps its agents until the first retry; that retry failing empties the list`: `[herdr] closed · ended`, `[herdr] retry · 1`.
  - `a refused connection retries after 1, 2, 4, 8, 16, 32 and 60 s, then waits on the watch with no timer` (a stale socket): seven `[herdr] retry · <n>` lines.
  - `after giving up, a change beside the same stale socket connects nothing; a replaced socket connects at once`.
  - `a subscription that drops within 60 s does not put the delay back to 1 s; one that lived 60 s does`.
  - `a list that fails, and a new subscription that does not start, are a drop`.
  - `while live and idle it holds one connection and no timer`.
  - `stop while the list is in flight: its answer lists nothing, and no connection, watch or timer is left`; `stop empties the list and tells once`; `start twice is one subscription`.
  - `on Windows start does nothing`: `platform: 'win32'`, no request, no watch.
  - `voice`: idle, done and a turn that ended idle are sent (`deps.prompt` got `['w1:p1', 'claude', 'run the tests']`, count `herdr`, `{ ok: true }`); needs-you is `{ ok: false, reason: 'api is waiting for your answer in herdr.' }` and `waiting`; working and unknown are `api is busy. Say it when it is done.` and `busy`, with no request; a second send while one runs, and a prompt the adapter answers `busy`, are `busy`; 2001 characters is `Too long. Say it shorter.` and `too-long`; `agent_not_ready` and an agent no longer listed are `api did not answer.` and `no-answer`.
  - `a tap focuses the agent's pane through deps.focus; one no longer listed is false`.
  - `no log line holds a pane id, a name, a folder or the words`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/cable/hosts/herdrSource.spec.ts`. Expected: FAIL (no `./herdrSource.js`).
- [ ] **Step 3: Implement** `herdrSource.ts`. Its header says why the list follows the subscription and not the other way (a change in flight is still heard), why the socket's stamp is kept (herdr's log is in the watched folder), and why a pane asks once (a pane the list leaves out is replayed on every subscription).
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/architecture.spec.ts src/leanEntry.spec.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `devices: herdr's agents, listed and followed over its socket, pushed and never polled`.

### Task 6: The devices run the herdr source

**Layer:** devices service process. **Depends on:** Tasks 3, 4 and 5. **Effort:** `xhigh` (what starts and stops with the dial; two sources' cards; `services/devices.ts` is in the 100% gate).

**Red test:** `cli/src/services/devices.spec.ts`.

**Files:**
- Modify: `cli/src/services/devices.ts`
- Test: `cli/src/services/devices.spec.ts`

**Interfaces:**
- Consumes: `HerdrSource`, `HerdrSourceDeps` (Task 5); `watchHerdrSocket`, `herdrClientDeps` (Task 1); `herdrClient`, `herdrAdapter`, `adapters`, `noting` (Task 4); `outsideEntries`, the named `onChange` turn (Task 3).
- Produces, in `devices.ts`:
  - `DevicesDeps.herdrWatch?: HerdrSourceDeps['watch']`: for this service's tests. By default `(changed) => watchHerdrSocket(herdrClientDeps(), changed)`.
  - `const herdr = observed ? new HerdrSource({ … }) : null`, with:
    - `client: herdrClient`, `platform: apps.platform`, `now: Date.now`, `monotonic`, `uuid: randomUUID`, `after: timerIn('herdr')`, `log`;
    - `prompt: herdrAdapter.prompt`;
    - `focus`: the herdr adapter of `adapters` (so `noting` notes the move) with `{ adapter: 'herdr', id: paneId }`: the command a hooked agent's tap runs (Q6);
    - `count`: the line the observed source's `count` writes, `[device] voice · <what>`.
  - The registry is `[cableHost.harness, observed, herdr]` when the switch is on.
  - `herdr.onChange` runs the same turn as `observed.onChange`.
  - `dialAttached(true)` starts it and `dialAttached(false)` stops it, each through `part.call('herdr', …)`. The devices' `stop` already calls `dialAttached(false)`.

- [ ] **Step 1: Write the failing tests** in a new `describe("herdr's agents, over its socket (docs/specs/2026-11-16-device-herdr.md)")`. Its `herdr` is a client the test drives: `subscribe` keeps each subscription's entries, callbacks and whether it was closed; `request` answers `agent.list` from the test's agents; `prompt` records. Its `orca` is `` { ...mac, onPath: (name: string) => `/opt/${name}/bin/${name}` } ``, so a focus is read in `orcaRuns`. Its `herdrWatch` records its starts and stops. `live(agents)` attaches the dial, calls the first subscription's `started()` and awaits the list. Everywhere else `start` passes Task 4's inert client and `herdrWatch: over.herdrWatch ?? (() => () => {})`, so no other test holds a watch or lists a herdr agent.
  - `with a dial attached herdr's agents are listed svf, with host herdr; detached, the source stops`: `listed()` is `[{ id: expect.any(String), name: 'api', caps: 'svf' }]`; after `seen.host.watching!(false)` the subscription is closed and nothing of herdr is listed.
  - `a status change is a card`: `working` gives one `turnStarted` for the id with text `''`; `blocked` gives one with `'Waiting for you · herdr'`; `done` gives one `turnDone`; `calls('summary')` and `calls('question')` are `[]`.
  - `a herdr agent mid-turn is reminded`: one more `turnStarted` after `REMIND_MS`.
  - `a turn that ends idle, its pane focused in herdr, is a done card` (Q10): `working`, then `idle`: one `turnDone` for the id, and no reminder follows `REMIND_MS`. The same after `blocked`. An agent first listed `idle`, and `done` then `idle`, add none.
  - `a hooked agent in a herdr pane is one row, its hook's, and gets each card once`: a Claude hook with `{ HERDR_PANE_ID: 'w1:p1' }`, and herdr listing `w1:p1` as `claude`. `listed()` is one row whose id is `observedAgentId('claude', 'sess-1')`. After the hook's `turn-start` and herdr's `working`, `calls('turnStarted')` has one call, that id's. After `REMIND_MS`, one more, that id's.
  - `the herdr row first, then its hook: the row becomes the hook's, and the old id never reaches the core`: with herdr's row `X` working, the hook arrives; `listed()` is the hook's row alone; `host().activityText(X)` is null; `host().sendTurn(X, 'hi')` is `{ ok: false, machine: expect.any(String), reason: 'it runs outside Harness' }`; `host().openAgent(X)` runs nothing (`orcaRuns` is `[]`); `core.agents.activityText` and `core.turns.send` were never called with `X` (Q7: as `main`, until the next list).
  - `the dial's words reach an idle herdr agent, and each refusal is said once`: `sendTurn` is `{ ok: true }`, the client's `prompt` got `['w1:p1', 'claude', 'run the tests']`, `said()` is `['[device] voice · herdr']`. Then working, blocked, 2001 characters and a failed prompt add `busy`, `waiting`, `too-long`, `no-answer`, one line each.
  - `a tap runs herdr agent focus for the pane, brings no app forward, and is the dial's own move`: `host().openAgent(id)` answers undefined; `orcaRuns` is `[['/opt/herdr/bin/herdr', ['agent', 'focus', 'w1:p1'], 10_000]]`, with no `open -b`; the client was asked nothing for it. With a tab report waiting on its settle before the tap, the settle says `[device] tab · skipped · echo` (the tab describe's helpers).
  - `turning the dial to a done agent marks it seen here, and asks herdr nothing`.
  - `HARNESS_DEVICE_OBSERVED=off: nothing is subscribed or watched`; `on Windows nothing is subscribed or watched` (`orca` with `platform: 'win32'`).
  - `the devices stopping stops the source`: the subscription is closed and the watch stopped.
  - `a herdr part that throws costs the dial nothing` (`faults: ['herdr']`): the dial still lists the observed agent.
  - `no log line holds a pane id, a name, a folder or the words`.
- [ ] **Step 2: Run** `cd cli && npx vitest run src/services/devices.spec.ts`. Expected: FAIL in the new describe only.
- [ ] **Step 3: Implement.** The comment over the source says it runs only while a dial is attached, behind the observed agents' switch, and never on Windows.
- [ ] **Step 4: Run** the step 2 command, then `cd cli && npx vitest run src/cable src/services/devicesProcess.spec.ts src/architecture.spec.ts src/leanEntry.spec.ts && npm run test:core && npm run typecheck`. Expected: PASS, 100% for `services/devices.ts`, the core's file list unchanged.
- [ ] **Step 5: Commit** `dial: herdr's agents are on the dial with their state, hook or no hook`.

### Task 7: End to end, a private herdr

**Layer:** test. **Depends on:** Task 6. **Effort:** `high`.

**Red test:** none: no behavior (it adds the end-to-end test of what Tasks 1 to 6 built).

**Files:**
- Create: `cli/e2e/deviceHerdr.e2e.ts`, `cli/e2e/harness/herdrServer.ts`

**Interfaces:**
- `herdrServer.ts`: a herdr server of the test's own, never the developer's.
  ```ts
  /** The installed herdr: on the worker's PATH, else ~/.local/bin/herdr of the account that runs the tests
   *  (`userInfo().homedir`: the suite's HOME is a throwaway one). Null when there is none, or no `cc`: the file is
   *  then skipped. */
  export const herdrBinary: string | null
  export class PrivateHerdr {
    static start(d: IsolatedDaemon): Promise<PrivateHerdr>
    readonly socket: string                     // <d.env.HOME>/.config/herdr/herdr.sock
    rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
    /** A workspace in <projectsDir>/<folder>, not focused: its pane id. The pane holds its shell. */
    pane(folder: string): Promise<string>
    /** A line typed into the pane, then Enter. */
    type(paneId: string, line: string): Promise<void>
    /** Tells herdr the pane holds a `claude` agent in that state. */
    report(paneId: string, state: 'idle' | 'working' | 'blocked'): Promise<void>
    /** A pane with the fake agent running in it, reported to herdr: its pane id. */
    agent(folder: string, state: 'idle' | 'working' | 'blocked'): Promise<string>
    screen(paneId: string): Promise<string>
    stop(): Promise<void>
  }
  ```
  - `start`: writes `<home>/.config/herdr/config.toml` with `[update]`, `version_check = false`, `manifest_check = false`, so the server calls no other computer. It writes the daemon's `herdr`, a two-line `sh` wrapper in the folder of `d.env.CLAUDE_PATH` (the daemon's `bin`, first on its `PATH`): `XDG_CONFIG_HOME=<d.env.HOME>/.config`, then `exec` of `herdrBinary` with its arguments. So the daemon's `herdr agent focus` (Q6) finds a `herdr`, and reaches this server alone, whatever herdr reads its home from. It refuses a socket path over 103 bytes, naming `TMPDIR=/tmp`. It runs `herdr server` with `{ ...d.env, XDG_CONFIG_HOME: join(d.env.HOME, '.config') }`, in a process group of its own, told to the reaper (`watchGroup`), and waits for the socket. It makes one plain workspace first (`workspace.create { focus: true }`), so that an agent's pane is never the focused one.
  - `rpc`: one connection a request, the test's own few lines: not the product's client.
  - `pane`: `workspace.create { cwd }`. `type`: `pane.send_text`, its text ending in a newline. `report`: `pane.report_agent { pane_id, source: 'harness-e2e', agent: 'claude', state }`.
  - `agent`: `pane`, then the fake agent's absolute path typed into it, then `report`.
  - The fake agent is the spike's C program, compiled once per test with `cc` to `<d.root>/hb/claude`: it prints `fake> `, and `GOT[<line>]` for each line it reads. It is named `claude` because herdr tells an agent by its process name; a copied `/bin/cat` under that name is killed by macOS.
  - `screen`: `pane.read { pane_id, source: 'visible' }`.
  - `stop`: `server.stop`, then the process group ended if it is still there, and forgotten by the reaper.
- Consumes: `IsolatedDaemon`, `until`, `Desk`, `FakeBackend` and the spoken turn, as `deviceCodex.e2e.ts` uses them; `Outside`'s way to read a session id from `d.hookLog()`.

- [ ] **Step 1: Write** `herdrServer.ts`.
- [ ] **Step 2: Write the tests** in `deviceHerdr.e2e.ts`, `describe.skipIf(!herdrBinary)`, each with a daemon of its own (`CABLE_DISABLE: 'false'`), signed in as a fixture machine for the speech, and a dial with no `appFilter`. `afterEach` stops the herdr server before the daemon.
  - `herdr's agents are on the dial with their state and no hook, and take a tap and the dial's words`:
    1. herdr runs with `api` reported idle. The dial plugs in and hears the row `{ name: 'api', engine: 'claude', host: 'herdr', caps: 'svf' }`.
    2. `report(pane, 'working')`: `turn.started` for it. `report(pane, 'blocked')`: a `turn.started` or `turn.activity` whose text is `Waiting for you · herdr`. `report(pane, 'working')`, then `report(pane, 'idle')`: `turn.done`, as an unfocused pane's turn ends `done`.
    3. The dial sends `agent.open`: the daemon runs `herdr agent focus <pane>` through the wrapper, and `rpc('agent.get', { target: pane })` reads `focused: true`.
    4. The dial speaks `run the spoken tests`: it hears `voice.transcript`; `screen(pane)` holds `GOT[run the spoken tests]`; the daemon's log has `[device] voice · herdr`.
    5. `report(pane, 'working')`, then the dial speaks `not now`: it hears `voice.error`; the log has `[device] voice · busy`; `screen(pane)` holds no `not now`. Then `report(pane, 'idle')`, the pane still focused: `rpc('agent.get')` reads `agent_status: 'idle'`, and the dial hears `turn.done` for it (Q10).
    6. A pane that holds only its shell, reported idle (`pane('ops')`, then `report`), is listed. The dial speaks `ls` to it: `voice.error`; the log has `[device] voice · no-answer`; its screen holds no `ls`.
    7. The log holds no pane id, no folder's path and none of the words.
  - `herdr started after the dial, and stopped: its agents come with no daemon restart, and go`:
    1. The dial plugs in with no herdr. Then `PrivateHerdr.start` and `agent('api', 'idle')`: the row is heard.
    2. `stop()`: a list without the row follows, and the log has `[herdr] closed · ended`.
    3. A second `PrivateHerdr.start` and `agent('api', 'idle')`: a row is heard again, on the same daemon.
  - `a hooked Claude Code in a herdr pane is one row, its hook's, and gets each card once`:
    1. `"$CLAUDE_PATH"` typed into a herdr pane (`pane('hooked')`, then `type`) starts the suite's fake Claude Code there. Its SessionStart hook runs with herdr's own `HERDR_PANE_ID`; the session id is read from `d.hookLog()`.
    2. `report(pane, 'idle')`. The dial's latest list has one row for that pane: id `observedAgentId('claude', sessionId)`, host `herdr`.
    3. A prompt typed into the pane (`type`): one `turn.started` and one `turn.done` are heard, both for that id, and none for any other id.
    - If herdr 0.8.0 will not list a reported agent whose process is the suite's fake engine, stop and report it. The test is not weakened.
- [ ] **Step 3: Run**, on this Mac: `cd cli && npm run typecheck && env -u TMUX -u TMUX_PANE TMPDIR=/tmp npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdr.e2e.ts e2e/deviceWithoutApp.e2e.ts e2e/deviceCodex.e2e.ts`. Expected: PASS, and `deviceHerdr` not skipped. Then `ps -A -o command= | grep -c "[h]erdr server"` prints what it printed before the run.
- [ ] **Step 4: Commit** `e2e: herdr's agents on the dial, from a private herdr server`.

Nothing registers the file: `vitest.e2e.config.ts` finds `e2e/**/*.e2e.ts`, a file with no hint in `cli/ci-e2e-durations.json` costs the default, and on a runner with no herdr every test of it is skipped.

### Task 8: Say it in the docs

**Layer:** repo files. **Depends on:** none. **Effort:** `medium`.

**Red test:** none: no behavior.

**Files:**
- Modify: `cli/AGENTS.md`, `cli/src/services/AGENTS.md`, `docs/specs/2026-11-13-device-without-the-app.md`, `docs/specs/2026-11-15-device-host-adapter.md`

- [ ] **Step 1:** Write the changes, in each file's own words and length:
  - `cli/AGENTS.md`, the devices row of the processes table: herdr's agents, listed and followed over herdr's own socket while a dial is attached (`cable/hosts/herdrSource.ts`, `herdrClient.ts`).
  - `cli/src/services/AGENTS.md`, the devices bullet: an app that lists its own agents is one source file under `src/cable/hosts/` beside its adapter, named once in `src/services/devices.ts`; a hooked copy and a listed copy of one agent are one row (`registry.ts`).
  - `docs/specs/2026-11-13-device-without-the-app.md`, where it says a host adapter beats observed: one sentence that points at `2026-11-16-device-herdr.md`, where the hook's copy wins.
  - `docs/specs/2026-11-15-device-host-adapter.md`, at the de-duplication row, at "herdr or WezTerm inside an Orca terminal still takes words and rests through Orca", and at herdr's row of the adapters table (it types now, over herdr's socket; its focus is still `herdr agent focus`): one sentence each that points at the new spec.
  - `docs/specs/2026-11-13-device-claude-orca.md` does not change: a tap on herdr is still `herdr agent focus` (Q6).
- [ ] **Step 2:** Check every link resolves.
- [ ] **Step 3: Commit** `docs: herdr's agents reach the dial over herdr's socket`.

---

## Verification

**Platforms the pull request names:** the daemon on macOS and Linux. Tested: the unit specs on Linux in PR CI and on this Mac, check 1 on this Mac, check 2 on Linux runners and on this Mac. Windows: nothing a person sees changes from `main`. Unit tests with `platform: 'win32'` hold that the source never runs, that the adapter types nothing, and that a tap runs the same `herdr agent focus` command (Tasks 4 to 6).

**Never touched:** Diego's own herdr (its server, its session, `~/.config/herdr`), his everyday daemon (port 18473), `~/.claude`, `~/.codex`, his tmux server, his dial, any backend, production.

**Temporary workflow:** none. Check 1 needs the herdr installed on this Mac, which no GitHub runner has. Check 2 has a workflow of the repo's own.

**Turns.** The tester asks the orchestrator before the one hand-started GitHub run (check 2).

**Local gates**, recorded in the pull request (PR CI does not run them), on this Mac at the final head:
- `cd cli && npm run typecheck && npx vitest run src/cable src/services/devices.spec.ts`.
- `npm run test:core`: 100% per file under `src/services/`, `services/devices.ts` named. This is the one gate the repo requires for this change (`docs/validation-and-release.md`, "What PR CI does not run").
- `npx vitest run src/architecture.spec.ts src/leanEntry.spec.ts`. `git diff --stat origin/main -- cli/src/core cli/src/architecture.coreFiles.txt` prints nothing.
- `python3 scripts/local-checks.py --run` from a clean tree at the final commit (`cli-core`). Its receipt goes in the pull request's body before the tested commit is pushed.
- Not needed: `npm run test:harnessd`, the serial and PTY specs, `cargo test` in `device-app`, `make device-test`, `make desktop-test`.
- The end-to-end suite is no required gate: no script runs it, and the repo asks for one hand-started run for a user-facing CLI flow (check 2).

**1. A private herdr, the real daemon, a fake dial**
- Where: this Mac only, at the final head. herdr 0.8.0 at `~/.local/bin/herdr`, and `cc`.
- Run: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/deviceHerdr.e2e.ts`. `TMPDIR=/tmp` keeps the daemon's and herdr's socket paths under their limits.
- Isolation, the suite's own (`cli/e2e/harness/daemon.ts`, cli/AGENTS.md rules 5 and 6) and the helper's:
  - a throwaway home, data folder and Codex home, a private port and tmux server, fake engines, a fake dial on a pseudo-terminal, a fake backend on loopback for the speech;
  - a herdr server of the test's own, its config folder `<throwaway home>/.config/herdr`, with its update and manifest checks off, so nothing leaves this computer;
  - a fake agent binary compiled into the throwaway root;
  - the daemon's own `herdr`, the wrapper that pins it to that server (Task 7): the daemon under test inherits no `XDG_*` and no `HERDR_*` (`src/testing/daemonEnvironment.ts`), and the wrapper sets the one it needs.
  - Before the run, note `ls -la ~/.config/herdr` and `ps -A -o pid=,command= | grep "[h]erdr"`; after it, both read the same. No `herdr` command is run against that folder, not even to read.
- A person sees: three tests pass, none skipped. In the first, the tap focuses the pane in the private herdr (`focused: true`), and a turn that ends `idle` in that focused pane is heard as `turn.done`. The daemon's log of the first has `[herdr] listed · 1 agents`, `[device] voice · herdr`, `[device] voice · busy` and `[device] voice · no-answer`. The log of the second has `[herdr] closed · ended`. No `herdr server` process is left.
- If herdr is not installed, or the file is skipped: report it as not verified, never as passed.
- On GitHub: none, and no workflow changes (Q9): no runner has herdr, and the file reads skipped there.

**2. The other dial flows still hold**
- On GitHub, by hand, once on the final head: Actions → CLI end to end → Run workflow, branch `feat/device-herdr` (`.github/workflows/cli-e2e.yml`). Every shard passes. `deviceHerdr.e2e.ts` reads skipped there. The link goes in the pull request.
  - Isolation: the suite's own, as above. No account, no secret.
  - What it shows: `deviceWithoutApp`, `deviceClaudeOrca`, `deviceCodex`, `dialPaneFollow`, `dialClaudeAppFollow`, `dialAppFilter`, `dialAppFilterOnDial` and `devicesProcess` pass on the changed registry order and the changed card readers.
- On this Mac, the one file Linux skips: `cd cli && env -u TMUX -u TMUX_PANE TMPDIR=/tmp E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/dialTerminalFollow.e2e.ts`. Every test passes.

**3. In PR CI, by itself:** `cli-typecheck` and `cli-tests` run the specs of Tasks 1 to 6 on Linux, each socket spec on a fake server in a temp folder. Nothing is started by hand.

**4. Numbers:** none to take. The source polls nothing: Task 5's tests hold it to one connection and no timer while live and idle, to a watch and no timer while herdr is closed, and to one new subscription a second at most. A status event sets the state and tells the dial in the same turn, with no timer between, which is the spec's "within a second".

**5. On a dial:** none. No firmware changes, and the fake dial hears the frames a dial does.

**6. Against Diego's own herdr session:** none, and never. If a check seems to need it, it is a question for Diego.

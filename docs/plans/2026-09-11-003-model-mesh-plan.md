# Model mesh: an agent on one machine, its model on another

Status: **SUPERSEDED** by `2026-09-14-004-harness-grid-plan.md` — this plan assumed grid was being deleted and that the harness had to carry inference itself. Grid stays; it already provides serving, the model catalogue and both dialects. Kept for the relay/E2EE analysis only.

## Context

```
A — desktop, 1 opencode + 1 claude          C — full harness machine: deepseek v4 flash,
B — 1 codex agent, inference served by C         and its own agents
```

The stated flow is four relay hops. Two corrections shape the design:

1. **Hops 1 and 4 already exist and are not touched.** `prompt (A) → codex (B)` is the existing
   `message` down-frame (`backendSocket.ts:1021` `dispatchDown` → `sessionInput` → tmux).
   `codex (B) → answer (A)` is the existing transcript plane — codex writes JSONL, the watcher tails
   it, `normalize` produces ServerEvents, `backend.send()` publishes `up:{machineId}`
   (`backendSocket.ts:672`).

2. **Hops 2 and 3 are not one round trip — they are N.** A coding agent does 10–50 model round trips
   per prompt (tool call → read file → tool result → next completion). The B↔C leg is therefore the
   hot path, carries the largest payloads in the product (full context on every request), and is the
   only thing between "works" and "unusably slow".

The build is exactly one new leg: **B ↔ C, carrying inference.**

### Grid is being deleted, and it was carrying the launch layer

This plan must not depend on `gridLaunch.ts`, `gridAssignment.ts`, `gridCredentials.ts`,
`gridWebMcp.ts`, `gridConfigDir.ts`, `gridHandoff.ts`, or the `payload.grid` frame contract. That is a
real cost, not a rename: grid owned the one thing this feature needs most — **the per-engine table of
how a vendor lets you move its endpoint.** That table has to be re-derived and re-owned (Change 1),
and it roughly doubles the CLI-side work versus reusing it.

**Sequencing constraint, and it is the sharpest one in this plan: land Change 1 while grid still
exists.** Grid's table is the only working reference for these contracts in the tree. Re-deriving
each entry from vendor documentation is the correct method regardless, but doing it while a
known-good implementation is still present means every entry can be differentially tested against it.
After deletion there is no oracle, and a wrong entry fails *inside the vendor's binary* with an error
naming neither the harness nor the endpoint — the exact failure mode `gridLaunch.ts:20-38` was
written to prevent.

### What survives grid's removal and is genuinely reusable

Every one of these is generic plumbing that grid happened to be the only caller of:

| Piece | Where | What it gives us |
|---|---|---|
| Pane env injection | `createAgentPane.ts:40` `env`, → tmux `new-session -e` | Set arbitrary env for a new agent's pane |
| Launch argv + env clearing | `engineLaunch.ts:41` `extraArgs`, `:74` `clearEnv` | Codex's `-c` argv; removing inherited vendor creds. **Mesh becomes `clearEnv`'s new caller** — grid is its only one today |
| Live process env read | `processEnv.ts` `readProcessEnv` | Read-back: what endpoint is this pane actually on |
| Retarget | `restartAgent.ts`, `respawn-pane -k -e` | Move a running agent, keep pane + scrollback |
| Machine→machine client | `remoteRelay.ts:171` `RemoteRelayPool`, `:212` `acquire()` | A daemon dialing `/api/web-ws` **as a client** toward a peer, terminating E2EE itself |
| Machine→machine trust | `e2ee/machinePeers.ts` | Pinned Ed25519 peer, via `harness remote-password set` + `harness link connect` |
| HTTP-over-WS streaming | `appTunnel.ts`, `tunnel.ts:74-110` | The streaming-HTTP-over-a-socket shape, already proven for SSE |
| Binary lane + P2P | `terminalBinary.ts`, `terminalP2p.ts`, `remoteRelay.ts:511` | Per-`streamId` transport that already migrates to WebRTC and demotes back |
| Loopback HTTP + credential | `hookServer.ts:328,654`, `hookAuth.ts` | 127.0.0.1 server, 0600 minted token, uid/mode/`O_NOFOLLOW` checked |

### The repo became a monorepo after this plan was written

`desktop/` (the Flutter client) and `device/esp32-circle/` (the dial firmware) now live in this tree.
Three consequences, one of which reduces scope:

**Changes 5 and 7 become atomic cross-stack commits.** The `payload.model` frame contract and the
`machine_link_connect` UI used to span two repositories and therefore two PRs with a compatibility
window between them. They are now one commit, testable end to end before merge. Add `desktop/lib/`
to those changes' touch lists.

**The Dart binary mirror does NOT need the model kinds.** `desktop/lib/terminal/terminal_binary.dart`
mirrors `cli/src/lib/terminalBinary.ts` and carries explicit "keep the two in step" comments, so a
reader adding `modelBody = 8` / `modelChunk = 9` will reasonably wonder whether to mirror them.
**Do not.** Those kinds travel B-daemon ↔ C-daemon only; no model frame ever reaches the app, whose
lane is the separate `terminalLocal*` framing over loopback. `fromCode` already answers null for an
unknown code and drops, so the app stays correct with no change. Say this in the commit, or someone
will mirror them "for consistency" and add two kinds the app can never receive.

**Watch the `Grid` name collision when grid is deleted.** `Grid` in `desktop/lib/` is the **design
system** ported from the Grid app — `_GridTokenScope` and its tokens (`main.dart:129-140`), plus
several widgets documented as "ported from Grid". It has nothing to do with the inference grid this
plan is dropping. A grep-driven deletion will happily take the app's theming with it.

**Scope reduction: `agentFrame`'s `grid` field has no consumer left.** The app-v2 desktop parses
`agentId`, `machineId`, `name`, `machine`, `recent`, `engine`, `confidence` (`desktop/lib/core/models.dart:359-366`)
— and no `grid`. The field at `agentFrame.ts:45`, and the reconciliation bug its doc comment
describes, belong to the pre-v2 client. So Change 5 should **delete** that field with grid rather
than rename it to `mesh`, and add `mesh` only when there is UI that reads it. `meshAssignment.ts`
read-back is net-new display, not a replacement for something working today — which means it can be
deferred out of the first shippable phase if the schedule needs it.

## Design principles

**1. The harness tunnels bytes; it does not serve models, and it does not translate dialects.**
C is not asked to become an inference server — it is asked to expose something already serving models
on its loopback (ollama, vllm, llama.cpp, LM Studio). A dialect mismatch is **refused at launch with
a named error**, never bridged. See "Not in scope".

**2. Read the truth off the process; never bookkeep it.** Which model host an agent is on is read
from its live environment, the way `gatewayRuntime.ts` reads which endpoint a pane talks to. A
daemon restart forgets nothing, and an agent the user started themselves in their own shell reports
the truth rather than "none".

**3. Refusing loudly beats starting wrong.** Every precondition is checked before the pane spawns,
with a code specific to what failed — not discovered when the first completion errors inside the
vendor's binary.

## Architecture

```
A (desktop)
  │ agent_create { engine:'codex', model:{ hostMachineId:'C', model:'deepseek-v4-flash' } }
  ▼
relay ──▶ B daemon
             │ modelEndpoint: OPENAI_BASE_URL=http://127.0.0.1:18474/mesh/C/v1
             │                OPENAI_API_KEY=<minted per agent>   + clearEnv vendor creds
             ▼
          codex process ──HTTP POST /v1/chat/completions (stream)──┐
                                                                    ▼
                                             B daemon: ModelGateway (loopback HTTP)
                                                  │ model_open + binary body chunks
                                                  │ over RemoteRelayPool.acquire(C)
                                                  ▼
                                           relay  (opaque ciphertext, rate-guarded)
                                                  ▼
                                             C daemon: ModelHost
                                                  │ HTTP → 127.0.0.1:11434
                                                  ▼
                                             deepseek v4 flash
                                                  │ SSE tokens
                                                  ▼
                                   model_head + chunk frames ──▶ B's still-open response
                                                  │
                                         codex writes its JSONL
                                                  ▼
                                  watcher → normalize → up:{B} → A    ← existing, untouched
```

**C is a full harness machine** (decided): it runs its own agents alongside serving models. Two
consequences: there is no `--models-only` mode to build, and C's own agents compete with B for the
same GPU — so the concurrency cap in Change 2 is a real scheduling decision, not a formality.

**Loopback short-circuit.** An agent *on C* pointed at C's own model must not leave the machine. When
`hostMachineId === own machineId`, the gateway proxies straight to the local backend and never
touches `RemoteRelayPool`. Same URL shape, same token check, no relay, no E2EE session. This is the
common case on a single GPU box and it must not pay for the network.

---

## Change 1 — own the engine endpoint contract

New: `cli/src/lib/model-mesh/modelEndpoint.ts`. **Land this first, while grid still exists.**

One table: *given engine E, a base URL, a key and a model, how does the vendor let you point it
there?* Every entry cites the vendor documentation it was read from, and is proven by a recorded
session from the real binary — the standard `cli/src/engines/README.md` already sets for engine
contributions. Do not copy grid's implementation; re-derive, then differentially test against grid
while it is still in the tree.

**v1 covers the three engines in the worked example** — the two on A and the one on B:

| Engine | Mechanism | Dialect it will speak to C |
|---|---|---|
| `codex` | `-c model_providers.*` argv + `env_key` indirection (key never in argv) | OpenAI |
| `claude` | `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` | Anthropic |
| `opencode` | private `opencode.json` via `OPENCODE_CONFIG` — the user's own `~/.config/opencode` is never touched | OpenAI |

Every other engine is **refused** with `MESH_ENGINE_UNSUPPORTED` and a reason specific to it. Adding
one later is a self-contained contribution: one table entry, one citation, one fixture.

Also in this module, because they are the same knowledge:

- `conflictingEnvToClear(launch)` — the vendor credentials a mesh launch must remove so the engine
  cannot silently fall back to its own login. Computed from what the launch itself sets. Feeds
  `engineLaunch.ts`'s existing `clearEnv`, which exists precisely for this and can only be done in
  the launch script (tmux `new-session -e` can set a variable, never remove one).
- `MESH_URL_RE` — the loopback route pattern, so Change 4's read-back and this writer cannot drift.

> Note on claude: it speaks Anthropic Messages and ollama serves OpenAI only, so `claude → C` works
> only if C runs a backend serving the Anthropic dialect. That is not a gap to paper over — it is
> exactly the refusal `MESH_DIALECT_UNSUPPORTED` exists for, checked in Change 4's pre-flight.

---

## Change 2 — C: the model host

New: `cli/src/lib/model-mesh/host.ts`, `backends.ts`.

**Backend discovery, not configuration** (principle 2). Probe known local servers on their documented
default ports and model-list endpoints; each entry cites its source:

| Backend | Probe | Dialect |
|---|---|---|
| ollama | `GET 127.0.0.1:11434/api/tags` | OpenAI (`/v1`) |
| vllm | `GET 127.0.0.1:8000/v1/models` | OpenAI |
| llama.cpp server | `GET 127.0.0.1:8080/v1/models` | OpenAI |
| LM Studio | `GET 127.0.0.1:1234/v1/models` | OpenAI |

An unprobeable backend is absent, not an error — a machine hosting nothing pays nothing, the same
rule `CONTRIBUTING.md` sets for multiplexers. `ADAPTER_MODEL_BACKENDS` overrides for a non-default
port, parsed the way `config/terminalConfig.ts` parses its backends list.

**Serving is opt-in and off by default.** Ownership and a peer link are not consent to spend a GPU —
especially now that C runs its own agents on it. State in
`${ADAPTER_DATA_DIR}/model-mesh/serve.json` (0600, `secureState.ts` conventions):

```
harness models serve --allow <machineId>   # or --all-linked
harness models serve --off
harness models list                         # what this machine serves, and to whom
```

An unlisted requester gets `MESH_NOT_SERVING` — never a silent hang.

**Concurrency cap.** `maxConcurrent` in `serve.json`, default 1. C's own agents are already using
that GPU; a second concurrent stream on a single-GPU box makes both slower and neither fails
visibly. Over the cap → `MESH_BUSY`, refused immediately rather than queued (a queued inference
request is indistinguishable from a hung one to every engine's HTTP client).

**Advertisement needs no backend change.** New RPC `model_backends_list`, answered in the existing
switch in `dispatchDown` (`backendSocket.ts:1411` is the neighbour to copy). A already attaches to C
with `machine_select` over `/api/web-ws`; it just calls the RPC. No new Redis key, no catalogue to
keep in sync. Register `model_backends_list_result` in `ENCRYPTED_RPC_RESULT_TYPES`
(`e2ee/core.ts:345`) — a model catalogue is machine content and must not leave C plaintext.

---

## Change 3 — the wire: a `model_*` plane

New: `cli/src/lib/model-mesh/frames.ts`, `backend/src/lib/modelRelay.ts`.

Modelled on `app_req`/`app_body`/`app_res` (`tunnel.ts:74-110`), multiplexed by `streamId`, but E2EE
and machine↔machine.

**Control frames (JSON, `up`/`down` with `targetConnId`):**

| Down (B→C) | Up (C→B) |
|---|---|
| `model_open` `{streamId, method, path, headers, model}` | `model_head` `{streamId, status, headers}` |
| `model_abort` `{streamId, reason}` | `model_end` `{streamId, ok}` |
| | `model_error` `{streamId, code, message}` |

**Body frames (binary):** two new kinds on the existing binary lane (`terminalBinary.ts:33`):

```
modelBody   = 8    // request body chunk, B→C
modelChunk  = 9    // response body chunk, C→B
```

This is the highest-leverage decision here. Riding the existing binary lane means bodies are sealed
with the already-derived binary key and stay opaque to the relay; the 24-byte hop header
(`terminalBinary.ts:68`) is reused verbatim so the backend needs no new framing; and
**`remoteRelay.ts:511` `sendBinary` already routes per-`streamId` over P2P and demotes to relay on
failure** — so Change 6 is largely configuration rather than a second implementation.

Chunk at `UPLOAD_CHUNK_BYTES` (256 KiB, `terminalStreamManager.ts:31`), under the 512 KiB
per-binary-message ceiling shared by the relay and the data channel. A 200k-token prompt is ~800 KB,
so chunking is the normal path, not an edge case.

**Backend (`modelRelay.ts`, mirroring `terminalRelay.ts`):** closed `MODEL_DOWN_TYPES` /
`MODEL_UP_TYPES` vocabularies; `isEncryptedModelFrame()` failing closed exactly like
`terminalRelay.ts:27`; and a `ModelRateGuard` that is **byte-dominant where the terminal guard is
frame-dominant** — single-digit requests per minute, megabytes each. Start at `model_open` 600
frames / 64 MiB, body kinds 20,000 frames / 512 MiB, then tune against a measured run and write the
measurement into the comment the way `terminalRelay.ts:48` does. Gate in `webWs.ts` (down, beside
`TERMINAL_DOWN_TYPES` at `:309`) and `adapterWs.ts` (up).

Register the JSON control types in `ENCRYPTED_DOWN_TYPES` (`e2ee/core.ts:362`) and
`ENCRYPTED_UP_TYPES` (`:339`) — headers carry the model id and the caller's token.

> `webWs.ts:414` forwards unrecognised frame types down generically, so a v1 would *function* with no
> backend change. Do not ship that: an ungated plane has no size cap and no rate guard, and "it works
> without the guard" is how the terminal plane's rejected-ack freeze happened.

---

## Change 4 — B: the loopback gateway

New: `cli/src/lib/model-mesh/gateway.ts`, started by `cli.ts` beside the hook server.

`http.createServer` bound to **127.0.0.1 only** (`hookServer.ts:654`), **one port per daemon**
(decided): `ADAPTER_MESH_PORT`, default `18474`, with the same "taken means another daemon is
running" report the hook port uses (`config/env.ts:123`).

Route `/mesh/:machineId/*` → the peer's backend, path and query verbatim.

**Auth: one token per agent** (decided). `Authorization: Bearer`, `timingSafeEqual`-compared, 0600
under `${ADAPTER_DATA_DIR}/model-mesh/` via `secureState.ts` — `hookAuth.ts` is the file to copy,
including its `O_NOFOLLOW`, uid and mode checks. A token is scoped to one `(agentId, hostMachineId)`
pair and dies with the agent, so revoking one agent never touches its siblings.

Per request:

1. `hostMachineId === self` → proxy to the local backend, return. Otherwise
   `RemoteRelayPool.acquire()` (`remoteRelay.ts:212`). No pinned peer → **403** naming the exact fix:
   `harness link connect <machineId>`.
2. `model_open` with method, path, and an **allowlisted** header set (`content-type`, `accept`,
   `authorization`, `anthropic-version`; hop-by-hop and identifying headers such as `x-stainless-*`
   are dropped — they do not cross machines).
3. Stream the request body as `modelBody` chunks; `model_abort` if the client hangs up first.
4. On `model_head`, write status + headers and `flushHeaders()` before the first chunk so SSE starts
   immediately. Write each `modelChunk` straight through — no buffering.
5. On `model_end`, `res.end()`.

**Timeouts and truncation.** No `model_head` within 30s (`appTunnel.ts:32` `RESPONSE_TIMEOUT_MS`) →
**504**. And the one that matters: if the link drops mid-stream, **`res.destroy()` — never
`res.end()`**. A truncated-but-cleanly-ended SSE stream is indistinguishable from a complete one to
every engine's HTTP client, and would be recorded as a finished turn that silently lost its tail.
Destroying surfaces it as the transport error it is, and every engine retries on that.

---

## Change 5 — launch and read-back

New: `cli/src/lib/model-mesh/meshAssignment.ts`. Touches `backendSocket.ts`, `cli.ts`,
`registry.ts`, `createAgentPane.ts`, `terminalAgentDiscovery.ts`, `agentFrame.ts`.

**New frame contract**, replacing `payload.grid` — on `agent_create` and `agent_retarget`:

```ts
/** Run this agent's inference on a peer machine reached over the relay. */
model?: {
  hostMachineId: string   // a machine id; validated, control characters rejected
  model: string           // the model id as C reports it
}
```

Deliberately **no `baseUrl` and no `apiKey`**: the caller cannot know B's loopback port and cannot
mint B's token, so accepting either would create two sources of truth for one address. B synthesises
`http://127.0.0.1:<meshPort>/mesh/<hostMachineId>/v1` and mints the key itself. Parsing mirrors
`parseGridLaunchOverride`'s tri-state shape — `absent` is a first-class answer so a build that sends
no `model` field creates agents exactly as it always did.

**Read-back** (principle 2): `probeMeshAssignment(process)` reads the engine's own env/argv through
`readProcessEnv`, matches Change 1's `MESH_URL_RE`, and answers
`{ hostMachineId, model } | null`. The registry field `grid` becomes `mesh`, and
`terminalAgentDiscovery.ts` / `tmuxAgentDiscovery.ts` / `agentFrame.ts` follow it. The key is never
read — the pane's credential is the pane's business.

**Pre-flight, before the pane spawns** (principle 3). B asks C `model_backends_list` and checks
reachability, serving consent, model presence, and that the dialect the engine speaks is one C
serves. Each miss refuses the create with its own code:

`MESH_PEER_OFFLINE` · `MESH_NOT_SERVING` · `MESH_MODEL_NOT_FOUND` · `MESH_DIALECT_UNSUPPORTED` ·
`MESH_ENGINE_UNSUPPORTED` · `MESH_NO_PEER_LINK`

---

## Confidentiality: what is encrypted, and between which two points

**Every byte of a model request and response is ciphertext for the whole of its journey across the
relay.** Naming the ends precisely, because "end-to-end" is doing real work in that sentence:

```
codex ──plaintext──▶ ModelGateway ══ciphertext═══════════▶ ModelHost ──plaintext──▶ ollama
      127.0.0.1 (B)       │         relay sees only this        │        127.0.0.1 (C)
                          └── the cryptographic ends are B's daemon and C's daemon ──┘
```

**The two plaintext segments are on loopback, inside a trust boundary the user already owns.** They
are unavoidable and should be stated rather than glossed: ollama does not speak this protocol, and
codex speaks ordinary HTTP. The trust boundary is the machine, not the process — which is the same
boundary the terminal plane already draws, where a pane's bytes are plaintext in the daemon before
being sealed.

**Keys must be pairwise, never the group key.** This is the one way to get it silently wrong. The
per-process group key (`k: 'g'`) is readable by *every* paired client of a machine — every browser,
every device. Model traffic carries whole prompts and whole completions and must be `k: 'p'`:
the pairwise `c2s`/`s2c` pair from `RelaySessionCrypto`'s X25519 ephemeral DH, established against
the Ed25519 peer pinned in `machinePeers.ts` and verified by `helloSig`/`welcomeVerify`
(`e2ee/relayClient.ts`). Bodies on the binary lane use the separately derived
`deriveTerminalBinaryKey(c2s|s2c)`, ChaCha20-Poly1305 per frame, with `replayWindow.ts` rejecting
replays. Ephemeral per connection, so the leg has forward secrecy.

**P2P changes nothing about this.** `remoteRelay.ts:511` seals *before* choosing a transport —
`encryptTerminal(clear)` runs, then p2p or ws carries the identical sealed bytes. The JSON path does
the same with `wrapOutgoing`. A DataChannel adds DTLS underneath; it never replaces the payload
encryption.

**Fail closed — the rule this plan was missing.** C must refuse a `model_open` that arrives on a
connection with no established pairwise session, rather than serving it in the clear. This mirrors
the existing enforcement in `emitReply` (`backendSocket.ts:989-1012`), where a content-bearing RPC
result answers `E2EE_REQUIRED` instead of falling back to plaintext — including for the legacy
`connId === ''` awaiter. Without the same rule here, "encrypted by default" is a property of the
happy path rather than a guarantee. Add `MESH_E2EE_REQUIRED` to the refusal codes, and cover it in
`modelRelay.test.ts` alongside the fail-closed envelope check.

**What the relay does learn:** that B opened a stream to C, when, how large it was, and how often.
Stream metadata and the cleartext hop header (`machineId`, `connId`, direction) are routing
information and cannot be encrypted without a different relay design. It does not learn the prompt,
the completion, the model id, or the credential — the model id and `Authorization` header travel
inside `model_open`'s encrypted payload, not beside it.

## Change 7 — the B→C link must be establishable from A's desk

**The key setup is reused; the existing pins are not sufficient.** Both halves matter.

**Reused.** The machine↔machine relation already exists and model calls are simply a third consumer
of it. `cli.ts:4133` states the intent directly: *"The SAME identity `harness remote-password
set` publishes and `harness link connect` proves knowledge against, so one link ceremony covers the
desktop app's relay and the dial's lane alike."* Model calls join the desktop relay and the dial's
lane as consumers of that one ceremony. No second key, no second ceremony, no new crypto — B→C runs
through the same `RemoteRelayPool.acquire()` against the same `machinePeers.json` pin.

**Not sufficient.** The pin is **directional and per-machine**: `machinePeers.json` lives in each
machine's own `${ADAPTER_DATA_DIR}/e2e/`. Linking from a desktop on A produces **A→B** and **A→C**.
The model call needs **B→C**, and B has no pin for C. Nothing about driving agents on B and C from A
implies B has ever heard of C.

**And today that link can only be made by standing on B.** `harness link connect` is an interactive
command, run as its own process on the joining machine, prompting for the target's remote password.
So the mesh currently requires SSH-ing into B — in a product whose premise is that the desk is where
the work is directed from.

**Fix: `machine_link_connect`, modelled on `device_e2ee_pair`.** That precedent is exact
(`e2ee/manager.ts:457` `pairDeviceFromTrustedWeb`): a client with an already-established E2EE session
— checked as `session.role === 'web'`, refusing `UNTRUSTED_WEB` otherwise — instructs the machine to
carry out a pairing ceremony on its behalf, and gets an encrypted RPC reply. Same shape here:

1. A's desktop is already E2EE-trusted with B. The user types C's remote password on A.
2. A sends `machine_link_connect {hostMachineId: 'C', password}` to B, encrypted with the existing
   A↔B pairwise session. The relay never sees the password.
3. B runs the ordinary CPace ceremony against C and pins the result — byte-identical to what
   `harness link connect C` does when typed on B.
4. B replies with the peer fingerprint so A can display it for out-of-band verification, exactly as
   `cli.ts:4789` asks the operator to do today.

**The password proof stays.** It is tempting to let the backend authorize a link between two machines
it already knows share an owner, and skip the password. Do not: the CPace exchange is what makes the
relay unable to mint links, and a backend that could authorize one could link an attacker's machine
into a user's mesh. Ownership is a necessary check, never a sufficient one.

This is small, but without it the feature is "works once you SSH into B" rather than "works".

---

## Change 6 — P2P (phase 4, but designed for now)

Because bodies ride the binary lane, `remoteRelay.ts`'s per-`streamId` P2P routing applies with two
changes: add the model kinds to the migration-eligible set, and let `TERMINAL_P2P_DOWN_TYPES`
(`terminalP2p.ts:47`) carry the `model_*` control frames.

Worth doing early. Inference bodies are the largest payload class in the product — ~100 KB–1 MB per
round trip × 30 round trips per prompt × every agent — and A, B and C are frequently on one LAN,
where a direct path turns a WAN round trip into a sub-millisecond one.

---

## Not in scope (deliberately)

- **Dialect translation** (Anthropic Messages ⇄ OpenAI). Refused with `MESH_DIALECT_UNSUPPORTED`.
  A translator is a real product need but a substantial one, and putting it in the tunnel means every
  bug in it presents as a model bug.
- **Metering / billing** (decided). Stream-level counters go to the daemon log only — bytes, chunks,
  duration, model, peer — so the data exists if we want it later, with no billing plumbing to unpick.
- **Scheduling across several hosts.** One agent, one named host machine.
- **Serving outside the user's account.** Ownership is checked at the relay and stays checked.

## Failure modes

| Condition | Caught where | User sees |
|---|---|---|
| C offline | pre-flight, then `model_open` | create refused, `MESH_PEER_OFFLINE` |
| C not serving to B | pre-flight | refused, `MESH_NOT_SERVING` + the `harness models serve` command |
| No pinned peer | `RemoteRelayPool.dial` | 403 + the `harness link connect` command |
| Model absent on C | pre-flight | refused, `MESH_MODEL_NOT_FOUND`, listing what C does have |
| Engine dialect ≠ C's | pre-flight | refused, `MESH_DIALECT_UNSUPPORTED`, naming both |
| Engine has no endpoint contract | Change 1 | refused, `MESH_ENGINE_UNSUPPORTED`, reason specific to that engine |
| C at its concurrency cap | ModelHost | `MESH_BUSY` → 503, immediately |
| C's backend down mid-session | `model_error` | upstream status passed through (502) |
| Link drops mid-stream | gateway | `res.destroy()` → engine sees a transport error and retries |
| Over the rate guard | backend | frame rejected; gateway 429s rather than hanging |

## Testing

1. `modelEndpoint.spec.ts` — one fixture per engine contract; **differentially tested against
   `gridLaunch.ts` while it still exists**, then the differential test is deleted with grid.
2. `frames.spec.ts` — chunking, reassembly, ceilings, malformed-frame rejection.
3. `modelRelay.test.ts` (backend) — fail-closed envelope check, `ModelRateGuard` buckets. Mirrors
   `terminalRelay.test.ts`.
4. `gateway.spec.ts` — a recorded OpenAI SSE stream replayed end-to-end through a stubbed relay,
   byte-compared at the gateway's HTTP output. **This is the conformance bar: the bytes the engine
   receives must equal the bytes C's backend produced.**
5. Truncation test, explicitly: kill the link mid-stream, assert `destroy` not `end`.
6. Loopback short-circuit test: `hostMachineId === self` never constructs a relay session.
7. `model-mesh.real.spec.ts` (opt-in, like `test:tmux-real`) — two daemons, real ollama, real codex
   pane. The one test that proves the thing works.

## Sequencing

| Phase | Contents | Ships alone? | Note |
|---|---|---|---|
| 1 | Change 1 — engine endpoint contract | Yes | **Must land before grid is deleted** |
| 2 | Change 2 — host, probe, `serve.json`, `model_backends_list` | Yes | A can list what C serves |
| 3 | Change 3 — frames, backend guards, e2ee registration | No | lands with 4 |
| 4 | Change 4 + 5 — gateway, launch, read-back | Yes | first user-visible value |
| 5 | Change 7 — `machine_link_connect` | Yes | can land any time; without it, setup needs shell access to B |
| 6 | Change 6 — P2P | Yes | |

Nothing in phases 1–4 changes an existing frame's meaning: an older daemon reports no model backends
and refuses a mesh launch it does not understand.

## Open questions

1. **Does grid's deletion remove endpoint-pointing as a product capability entirely, or does mesh
   inherit it?** If a user should still be able to point an agent at an arbitrary public endpoint
   after grid is gone, Change 1 should expose that directly rather than only via `hostMachineId` —
   it is the same table either way, and the decision changes the module's public shape.
2. **Does C's GPU need protecting from its own agents?** `maxConcurrent` bounds remote streams, but
   an agent running locally on C bypasses the gateway and the cap entirely.
3. **Engine coverage past the three.** v1 is codex, claude, opencode. Which is fourth, and is there a
   user waiting on it?

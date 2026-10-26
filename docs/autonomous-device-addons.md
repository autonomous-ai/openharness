# Autonomous device add-ons, v1

An **add-on** is an agent on the paired computer that reads what a device chose to publish about
itself and proposes what the device might do. The first device is the Autonomous lamp (lampOS): a
partner's add-on can read summaries such as "someone is at the desk" or the lamp's mood, and suggest a
warm evening light or a small mood lift. The lamp decides whether to act on it, through its own
judge, safety limits and output owners. The design on the lamp's side is lampOS
[`docs/addons.md`](https://github.com/autonomous-ai/lampOS/blob/lamp-voice/lampOS/docs/addons.md).

**Status:** implemented in this checkout (CLI only); not released or deployed. Do not assume a
running CLI supports it until its hello advertises the capabilities below.

## What Harness does and does not do

- **Carries, bounds and forgets.** Harness keeps the newest value of each published topic in RAM,
  forwards proposals to the one device they are for, and records the device's decision. It bounds
  sizes, rates and lifetimes so that one agent cannot flood a device and one device cannot grow the
  daemon's memory.
- **Never judges.** Which topics are safe to publish, which acts a device understands and whether a
  proposal is carried out are the device's policy. A proposal is a suggestion, never a command:
  nothing here writes to a speaker, light or motor.
- **Is device-agnostic.** No topic or act is named by Harness. Topic names and act names only have
  to be well formed.
- **Adds no transport.** Everything rides the existing direct, end-to-end encrypted device channel
  of [the device integration](autonomous-device-integration.md): protocol `proto: 1`, the same
  pairing, identity pins, PAKE and envelopes. No new listener, credential, or pairing flow.

## Capabilities

An authenticated role-device application `hello` advertises two more strings:

```json
["addon.publish", "addon.decision"]
```

An older CLI does not list them and answers `UNSUPPORTED_CAPABILITY`. A device offers add-ons by
publishing after its hello. **A hello clears what the device published before**, and the device
publishes its whole set again after every hello, so a topic it no longer offers (a person withdrew
consent) is gone, not left readable. When the Wi-Fi device service restarts under a session the
gateway kept, no hello comes: the computer sends the `addon.republish` event below, and the device
publishes its whole set again.

## Device → computer requests

Both are ordinary encrypted application requests: a fresh UUIDv4 `requestId`, unknown fields
rejected, answered with `<type>_result`. They count against the connection's existing token bucket
(burst 20, one a second), so a device coalesces its changes into batches.

### `addon.publish`

```json
{"type":"addon.publish","requestId":"<uuid>","values":[
  {"topic":"room/presence","value":{"someone":true},"at":1761030000000},
  {"topic":"mood/state","value":{"energy":0.6,"warmth":0.5}},
  {"topic":"voice/state","value":null}
]}
```

| Field | Rule |
|---|---|
| `values` | 1 to 16 entries, taken or refused as one batch |
| `topic` | two to four lowercase segments, `[a-z][a-z0-9_]*` each, `/` between, at most 96 characters |
| `value` | a JSON object of at most 4096 bytes serialized; `null` withdraws the topic |
| `at` | optional, the device's own time of the value in Unix milliseconds, kept as given |

At most 32 topics per device: a batch that would exceed it is refused `BACKPRESSURE`. An oversized
value is `PAYLOAD_TOO_LARGE`. Success: `{"type":"addon.publish_result","requestId":…,"topics":<count>}`.

Publish **summaries only**. The computer and every agent on it can read what is published; a device
must never publish transcripts, pictures, audio, faces, names or memory it would not show the person.
Even summaries say a lot about a person's routine (when someone is at the desk, when the room is
loud), and here they leave the device. So a device publishes only with its person's yes, and v1
gives the device no way to tell add-ons apart (below, "Not in v1"): what one agent may read, every
agent on the computer may read. Per-add-on consent, seen and revoked per add-on, needs that
identity first.

### `addon.decision`

```json
{"type":"addon.decision","requestId":"<uuid>","proposalId":"<uuid>","decision":"kept","reason":"evening, someone here"}
```

`decision` is `kept` or `dropped`; `reason` is optional, 1 to 200 characters without control
characters. Success: `{"type":"addon.decision_result","requestId":…,"proposalId":…,"state":"kept"}`.

- A proposal sent to another device, unknown, or aged out answers `PROPOSAL_UNKNOWN`. A device
  learns nothing about another device's proposals.
- The same decision again answers the same result; a different one answers `IDEMPOTENCY_CONFLICT`.
- A decision for a proposal that already lapsed here is still recorded: the device's judge decided.

## Computer → device events

`addon.republish`, with an empty payload, asks the device to publish its whole set again (above).

A proposal reaches its device as an encrypted `autonomous_device_event`:

```json
{"type":"event","serverInstanceId":"<uuid>","machineId":"<machine>","kind":"addon.proposal",
 "payload":{"proposalId":"<uuid>","addon":"evening-glow","act":"light","why":"evening","sure":0.6,
   "holdsMs":30000,"params":{"colour":"warm","level":2},"note":"A warm evening light.","expiresAt":1761030030000}}
```

- It goes to that device's links alone, is **not** in the replay log, and has no `eventId`. A device
  that is offline when a proposal is made never gets it; a lapsed proposal is never worth replaying.
- `expiresAt` is the computer's clock (`sentAt + holdsMs`). A device judges with its own clock and
  may drop a proposal it received late.
- `addon` is the name the computer gives the agent (below). It is said by the computer, not proven:
  the device rate-limits and judges every proposal whatever it is called.
- `act`, `why`, `params` and `note` are the device's vocabulary. A device drops a proposal it does
  not understand, with a reason.

## Agents on the computer

Agents use the CLI, which calls the credential-checked loopback hook server like the other
`autonomous-device` commands.

```sh
harness autonomous-device addon state [--device <id>] [--json]
harness autonomous-device addon propose --act light --holds-ms 30000 \
  [--why evening] [--sure 0.6] [--params '{"colour":"warm","level":2}'] [--note '…'] \
  [--addon evening-glow] [--key <idempotency key>] [--device <id>] [--json]
harness autonomous-device addon proposal <proposalId> [--json]
```

| Route | Input / result |
|---|---|
| GET `/api/autonomous-device/addon/state[?deviceId=…]` | `{devices:[{deviceId,online,topics:{<topic>:{value,at,receivedAt}}}]}` |
| POST `/api/autonomous-device/addon/propose` | `{addon,idempotencyKey,act,holdsMs,why?,sure?,params?,note?,deviceId?}` → `{proposal}` |
| GET `/api/autonomous-device/addon/proposal?proposalId=…` | `{proposal}`; `PROPOSAL_UNKNOWN` (404) for one never sent or aged out |

A proposal record is `{proposalId,deviceId,addon,idempotencyKey,act,why?,sure?,holdsMs,params?,note?,
state,reason,sentAt,expiresAt,decidedAt}`, with `state` one of `sent`, `kept`, `dropped`, `expired`.

**Proposal rules**

| Field | Rule |
|---|---|
| `addon` | `[A-Za-z0-9._:-]{1,64}`. The CLI uses `--addon`, or else the engine of the agent running the shell and a 12-hex hash of how Harness names that outside caller (`claude-1a2b3c4d5e6f`): one name per session, never the session's own id |
| `idempotencyKey` | `[A-Za-z0-9_-]{1,64}`; the same add-on and key is one proposal. The CLI makes a fresh key per call unless `--key` is given, and prints the key it used when a propose fails |
| `act`, `why` | `[a-z][a-z0-9_]{0,31}` |
| `sure` | 0 to 1 |
| `holdsMs` | 1000 to 30000 |
| `params` | a JSON object of at most 2048 bytes |
| `note` | at most 300 bytes, no control characters but newline |
| `deviceId` | optional when exactly one device that published is connected |

**Limits:** six proposals a minute per add-on and device, and twelve a minute per device whatever the
add-ons call themselves, since the name is the caller's (`RATE_LIMITED`); four undecided proposals per
device (`BACKPRESSURE`). A proposal not decided within `holdsMs` becomes `expired`. Settled proposals
stay readable ten minutes; at most 256 are kept, and a proposal still inside the rate window is never
dropped to make room: a new one is refused `BACKPRESSURE` instead.

**No answer in time.** The CLI waits 5 seconds for the Wi-Fi device service. A `propose` with no answer
in time is `OUTCOME_UNKNOWN` (504): it may have been sent. Retry with the same `--key` and it is sent at
most once. A read with no answer is `UNAVAILABLE` (503).

**Errors** (HTTP status): `INVALID_REQUEST` 400, `PAYLOAD_TOO_LARGE` 413, `DEVICE_NOT_FOUND` 404,
`PROPOSAL_UNKNOWN` 404, `MISSING_TARGET` 409, `DEVICE_OFFLINE` 409, `IDEMPOTENCY_CONFLICT` 409,
`RATE_LIMITED` 429, `BACKPRESSURE` 429, `UNAVAILABLE` 503 when the Wi-Fi device service is not running,
`OUTCOME_UNKNOWN` 504 for a propose with no answer in time.

## A device that is a Harness machine

Some devices run Harness themselves: the lampOS V2 lamp is a signed-in Harness machine on its person's
account, so it has no paired device channel to publish on (openharness#1654). Its add-ons go through its
own daemon instead. The contract, bounds, rates and lifetimes are the ones above; two things are added.

**The device's own service**, a process of the same OS user on that machine, uses the credential-checked
loopback routes, like the other `autonomous-device` routes:

| Route | Input / result |
|---|---|
| POST `/api/autonomous-device/machine-addon/hello` | `{}` → `{topics:0}`: what it published before is cleared, as a device's hello clears it. Send it at start |
| POST `/api/autonomous-device/machine-addon/publish` | `{values}`, as `addon.publish` takes them → `{topics}` |
| POST `/api/autonomous-device/machine-addon/decision` | `{proposalId,decision,reason?}`, as `addon.decision` → `{proposalId,state}` |
| GET `/api/autonomous-device/machine-addon/proposals?after=<seq>&waitMs=<ms>` | `{proposals:[{seq,proposal}],next,reset?}` |

`proposals` is the device's inbox in place of the `addon.proposal` event: the proposals after `after`, each
as the event's payload with its `seq`, and `next` for the next take. With none, it waits up to `waitMs`
(at most 20 s) for one. The inbox keeps the last 32; `gap: true` says proposals after the cursor were
dropped from it before this take.

**Restarts.** Everything is in RAM, and the daemon or its devices' process may restart at any time (every
Harness update does). Every `hello`, `publish` and `proposals` answer carries `instance`, the store's own id,
new after each restart. The service passes the last one it saw as `proposals?instance=`. When the store is
another one, or the cursor is ahead of it, the answer says `reset: true` and reads from the start: what
the service published is gone, and the owner's machines get `DEVICE_NOT_FOUND` until it publishes again.
**On `reset`, the service sends `hello` and publishes its whole set again**, as a device does after
`addon.republish`.

**Agents** on the owner's other machines reach the device over the existing machine link, as the
sealed `machine_addon` request (`{op:"state"|"propose"|"proposal",input}`), and the CLI takes
`--machine` for it:

```sh
harness autonomous-device addon state --machine lamp-4ace --json
harness autonomous-device addon propose --machine lamp-4ace --act say --holds-ms 30000 --note '…' --json
harness autonomous-device addon proposal <proposalId> --machine lamp-4ace --json
```

- **Only the owner's machines.** A guest, a device, an observer, or a session that isn't the account's
  own is refused `OWNER_REQUIRED`. The device's service routes are for a process on that machine alone
  (`LOCAL_ONLY` over the link).
- **Each proposal says the machine it came from:** `from: {machineId, label}`, taken from the pairing
  record of the link that carried it (`Asker.machine`), never from the payload, which may not carry one.
  A device can then ask its person's yes per computer. The owner's phone or browser may read `state`, but a
  proposal needs a machine (`MACHINE_REQUIRED`). An agent on the device itself proposes as that machine.
- **A machine reads back its own proposals alone.** Another machine's reads as `PROPOSAL_UNKNOWN`, and its
  idempotency keys are its own: the same key from another machine is another proposal.
- `--machine` takes a machine's id or its name. Two of the account's machines with that name are refused
  `AMBIGUOUS`: name one by its id.
- A proposal's target is always the device that is that machine: `deviceId` in the input is ignored.
- It runs in the devices' process (`services/machineAddons.ts`), started at its first request, in RAM; a daemon restart forgets it all.

## Lifetime

- A device's link closing marks it `online: false`: its values stay readable, and nothing is
  proposed to it until it publishes again.
- A hello clears what it published; a restored session is asked to publish again.
- Unpairing (either side) forgets everything it published and every proposal made to it.
- A daemon restart forgets everything: values, proposals and decisions.

## Implementation and validation

`cli/src/lib/autonomous-device/addons.ts` holds the contract and the bounded state;
`service.ts` advertises and routes the two requests; `services/wifi.ts`, `core/wifiLink.ts` and
`services/wifiProcess.ts` carry the agent-facing operation across the service process boundary as
`harness device receipt` is carried; `lib/deviceManagementHttp.ts` validates the routes;
`addonCommand.ts` is the CLI. A device that is a Harness machine: `machineAddons.ts` beside them, served by
`services/machineAddons.ts`. Unit tests cover each layer; `services/wifi.spec.ts` runs the real
service and relay end to end with a fake core (publish, state, a proposal sealed to that device, its
decision, unpairing). Not shown: a physical device. No device implements it yet.

## Not in v1

- An MCP tool for agents (`harness mcp`), and a Desktop view of published state.
- Per-add-on identity proven to the device (for example from a Store package), and revoking one
  add-on without unpairing.
- Pushing published changes to agents as they happen; v1 agents read on demand.
- Reading device memory or context beyond what the device publishes as topics.

# How it works

One execution system, with several interfaces. Work belongs to the machine running it;
opening or closing a view does not determine whether that work runs.

## System overview

Conceptual architecture, recorded September 27, 2026. The founder identifies the TUI as part
of current development; this diagram describes its intended client role. The web app is now
a browser target of the existing desktop Flutter package, available as a public preview at
[harness.autonomous.ai](https://harness.autonomous.ai).
[Public shared-session pages](product-direction.md#web-shared-sessions-as-an-acquisition-loop)
remain the next acquisition experiment beyond authenticated workspace access and private invitations.
The [product direction and roadmap](product-direction.md)
describe the larger bet and its proposed sequence.

```text
                            HUMAN
                              |
          +-------------------+-------------------+
          |                   |                   |
     DEEP WORK           QUICK CONTROL        AUTOMATION
          |                   |                   |
   +------+------+     +------+------+         +-----+
   | Desktop     |     | Mobile      |         | CLI |
   | TUI (dev)   |     | Web         |         +--+--+
   +------+------+     +------+------+            |
          |                   |                   |
          +-------------------+-------------------+
                              |
                SHARED COMMAND + EVENT CONTRACT
                start / resume / stop / answer
                status / questions / results
                              |
             +----------------+----------------+
             |                                 |
        Local socket                  Encrypted remote access
             |                        P2P for terminal traffic
             |                        Relay path / fallback
             |                                 |
             v                                 v
   +-----------------------+       +-----------------------+
   | DAEMON: laptop        |       | DAEMON: workstation   |
   |                       |       |                       |
   | Work + sessions       |       | Work + sessions       |
   | Status + questions    |       | Status + questions    |
   | Engine adapters       |       | Engine adapters       |
   | Tool/viewer lifecycle |       | Tool/viewer lifecycle |
   +-----------+-----------+       +-----------+-----------+
       ^       |                               |
       |       v                               v
       |  +--------------------+    +--------------------+
       |  | Agent processes    |    | Agent processes    |
       |  | Domain tools       |    | Domain tools       |
       |  | Project files      |    | Project files      |
       |  | Artifacts + checks |    | Artifacts + checks |
       |  +--------------------+    +--------------------+
       |
      USB
       |
   +-----------------------+
   | HARNESS DEVICE        |
   | Glance at progress    |
   | Answer questions      |
   | Speak instructions    |
   +-----------------------+


   SUPPORTING SERVICES
   +----------------------------------------------------+
   | Backend: accounts, machine discovery, shared tabs   |
   | Relay: connection signaling + encrypted forwarding |
   | Store: domain packages, tools, skills, viewers      |
   +----------------------------------------------------+
```

The contract in the diagram is an API boundary, not an extra server. The daemon already
exposes commands and events through its [local socket](cli.md#automation). A common contract
does not require every client to expose every operation.

The diagram groups interfaces by their main job; the CLI is also useful for interactive
administration, and desktop work includes quick decisions. Actual connection paths differ:

- **Desktop and local CLI commands** reach the local daemon. Desktop access to another
  machine goes through that local daemon's encrypted link.
- **Mobile** is a standalone client that authenticates and terminates encryption itself.
  It hosts no agents. See [the mobile architecture](../mobile/README.md).
- **Web** shares desktop's Flutter screens, state, and terminal renderer in `desktop/`.
  It authenticates and terminates encryption in the browser, reaching machines through
  the relay. Browser sign-in, storage, and native capability adapters are separate;
  there is no browser daemon. This first target does not negotiate WebRTC.
- **Remote terminal traffic** can use direct WebRTC or TURN; the encrypted relay path
  remains available. Other command/event traffic uses the supported daemon/relay paths.
- **The device** communicates over USB with its host daemon. It does not connect to the
  backend or execute agents.

## Ownership boundaries

| Component | Responsibility |
| --- | --- |
| Daemon | Authoritative machine execution state, agent lifecycle, question state, engine integration, and tool/viewer processes. |
| CLI | Scriptable operations and machine administration over the execution system. |
| Desktop | Rich interaction, terminal presentation, artifact inspection, and local window layout. |
| Mobile | Remote access, focused interaction, and decisions while away from the desktop. |
| Device | Desk status, questions, and voice input through the host. |
| TUI, in development | Interactive access inside a terminal, using the same operations. |
| Web, public preview | The shared desktop workspace in a browser, including private read-only invitations; public session pages for discovery and acquisition follow separately. |
| Backend and relay | Identity, discovery, selected shared metadata, signaling, and encrypted forwarding. |
| Domain packages | Instructions, skills, toolchain setup, project templates, checks, and viewers. |

Window layouts belong to clients; account-level tab membership is shared through the backend.
Runtime truth belongs to the daemon owning the work. A question answered through one interface
must resolve for the others. Closing an interface leaves execution running on an available host;
it does not make a sleeping or disconnected host capable of continuing work elsewhere.

The current [orchestrator](../cli/src/orchestrator/service.ts) already persists local project
runs, task dependencies, and artifact handoffs. Cross-machine orchestration, project migration,
and universal engine-session portability are separate capabilities; access to a remote terminal
does not provide them automatically.

## Daemon, sessions, and transport

**The daemon** runs detached under your account. Every five seconds it reconciles the `harness-*`
tmux sessions with its registry; a pane has to be missing on two scans before its agent is marked
gone. It tails each agent's transcript with a byte offset (JSONL for most engines, SQLite for
OpenCode, Kilo, Hermes and Devin) and turns lines into a normalized event stream: turn started,
tool call, sub-agent, question, turn ended. Hooks it installs into the vendor CLI tell it about
session start, prompt submit and stop. Every five minutes it re-reads engine configs and pane
footers to keep model and effort right. On start it restores panes that died with the tmux server,
and it self-updates from a signed manifest, swapping the bundle atomically.

**The session model.** The registry (`~/.harness/cli/data/registry.json`, mode 0600) is the source of
truth for agents: engine, working directory, tmux pane, bound transcript, process identity. Layouts
belong to the app. The relay stores machine records, agent names and daily counters, never a
transcript, a recap or a keystroke.

**Transport.** Each daemon holds one WebSocket to the relay, authenticated with its SSO token.
Terminal bytes ride a binary channel on that socket until a WebRTC data channel negotiates, then move
to it. Encryption is on for every path and has no switch:

- **Ed25519** identity keys, pinned at first pairing and signing every ephemeral after it.
- A **CPace-style PAKE** over ristretto255 — the six-character pairing code bootstraps a shared secret
  across the untrusted relay, and an attacker gets one online guess.
- **X25519** ephemeral Diffie–Hellman per connection, through HKDF to pairwise session keys.
- A **per-process group key** so one event encrypts once for many readers.
- **ChaCha20-Poly1305** on every frame, with the associated data binding frame type and session.

The crypto core lives in [`cli/src/lib/e2ee/`](../cli/src/lib/e2ee/) and is a byte-identical twin of the
browser's copy, with a drift-guard test and committed self-vectors.

## Providers, relay, web

- **`provider/`** — the spec ([`spec/README.md`](../provider/spec/README.md)), the deterministic
  [`reference-provider`](../provider/reference-provider/) with the conformance runner on port 4319, and
  [`example-provider`](../provider/example-provider/), a real one backed by the local `claude` CLI on
  port 4502 (read its README before running it; it skips permissions). `provider/e2e` runs both.
- **`desktop/`** — one Flutter package for native desktop and web, with shared product UI
  and platform adapters. See [web development](../desktop/README.md#web-development).
- **`backend/`** — the relay: Node, MongoDB via Prisma, Redis. Its WebSocket paths include
  `/api/adapter-ws` for daemons, `/api/web-ws`, `/api/observer-ws` for private sharing,
  `/api/device-ws`, and `/api/manager-ws`. It signals WebRTC
  and hands out STUN/TURN, and persists machines, agent names and counters. `npm install && npm run
  dev` on `:8085`; [`backend/README.md`](../backend/README.md) and `.env.example` for the rest.
  `harness-api.autonomous.ai` is the hosted instance.
- **[harness.autonomous.ai](https://harness.autonomous.ai)** is the download page: it hosts the CLI
  installer and the desktop downloads. It is not in this repository.

## The Harness device

A round 466×466 AMOLED with touch and a far-field microphone, USB-C on the bottom edge. It has no
WiFi and holds no credential. It is served entirely over the cable by the daemon on the computer it is
plugged into; plugging it in is the authorization. The wire is one USB serial device (`303a:1001`),
framed as `A5 5A | ver | type | len | payload | crc16` with a JSON vocabulary, a five-second ping,
and a hard 8 KiB frame ceiling.

What it shows: your agents as tiles in the order of the window's panes, with what each is doing and
for how long; a wheel of your machines; the agent's own question when it asks one, answerable with a
tap; the recap when a turn finishes, with one quiet tone. Scroll the face to scroll the terminal.
Double-tap and speak to send a task: the audio goes to the daemon as PCM, comes back as a transcript,
and Boss mode routes it. A voice turn can carry a mode — `/goal` runs an instruction to done,
`/loop` on a schedule — adapted per engine; `/loop` is Claude Code only today.

Firmware updates travel over the same cable in 16 KB credit windows, offered from the published
metadata and never for a dev build. `harness flash` re-flashes a device from a USB port. The firmware
is ESP-IDF ≥ 5.5 under [`devices/harness-device/firmware/`](../devices/harness-device/firmware/) (`idf.py set-target esp32s3 &&
idf.py build`); `make device-test` runs the host-side tests with no board attached.

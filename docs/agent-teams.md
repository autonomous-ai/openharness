# Agent teams

Implementation and operating guide, September 27, 2026. Verification limits are recorded below.

## Default experience: swarm tabs

The default UI now uses [swarm tabs](tab-channels.md), September 28, 2026.
Existing tab membership replaces manual team setup. Settings → Experimental → Swarm
collaboration is off by default. Once enabled, agents consult peers in their tab
automatically. Questions stay inside the tab; cross-swarm requests and Cmd+Shift+A
are deferred. The conversation view shows shared history. The protocol
below also supports standalone teams managed through the advanced CLI.

Agents retain their own engine, context, repository, and session. For example, mobile
asks the daemon agent which endpoint returns daemon state, that agent explicitly
replies, and the answer returns to mobile so it can continue its task. The durable
ledger records delivery separately from a correlated answer.

## Contract (team.v1)

1. **Ownership.** One machine daemon owns a team's roster and exchange ledger. Members are
   addressed by stable `(machineId, agentId)`; a display name, window, pane index, or vendor
   conversation ID is never a routing address. Multiple teams can include the same agent.
2. **Scope.** Standalone teams explicitly connect members; tab channels derive them from the saved desk. An agent's membership capability only
   grants reads and communication inside that team, including answers for that member. Team
   management remains an owner operation. All participants run under the person's existing
   Harness authority; membership is not an OS sandbox between same-user processes.
3. **Transport.** The daemon exposes `team` and `team_delivery` RPCs over existing local and
   paired E2EE machine transports. Remote bodies, member capabilities, replies, and ledgers
   never travel as plaintext through the backend. Shared observation connections cannot write.
   No new cloud database, service, or model subscription is needed.
4. **Engine boundary.** Shell commands are the universal adapter. A team introduction teaches
   existing agents `members`, `ask`, `inbox`, `reply`, and `status` without restarting engines,
   rewriting their settings, or reading another engine's private conversation. Claude, Codex,
   Grok, and other shell-capable agents use the same protocol. Ordinary terminal shells cannot
   be automatic answering members. An MCP adapter could wrap these operations later; this
   implementation uses the CLI and does not install vendor-specific tools or settings.
5. **Durability.** Reserve every team, question, answer, and delivery before external effects.
   Persist privately and atomically. A repeated operation ID with the same content returns the
   existing record; conflicting reuse fails. A daemon restart never blindly repeats an
   uncertain terminal submission. Queued-but-unsent work can resume. Corrupt state is preserved
   and reported, not treated as an empty successful team.
6. **Delivery.** Use bounded, per-session serialization. Never send interrupt/cancel keys or
   overwrite a human draft. Wait while a member is working, presenting a permission/question
   dialog, has a draft, or is unavailable. Recheck at the actual write boundary. Distinguish
   queued, delivered, started, rejected, and unknown. Terminal submission and turn completion
   cannot constitute an answer.
7. **Answers.** Only an explicit, correlated `reply` answers a question. An answer carries its
   author, timestamp, text, and optional evidence references. Duplicate identical replies are
   harmless; conflicting replies and replies by the wrong member fail. Answers are peer
   context, never a replacement for the user's instructions or permission to deploy/publish.
8. **Continuation.** A question defaults to asynchronous delivery. The asking agent can keep
   working; a separate tracked answer delivery resumes it when safe. A bounded `wait` reads the
   ledger and inbox. Incoming questions break the wait so the agent can answer them, avoiding
   mutual-wait deadlocks. Reading/claiming an inbox item suppresses an unsent terminal notice.
   A retrieved answer suppresses an unsent continuation notice.
9. **Bounds.** Limit roster size, text/evidence sizes, outstanding requests, and retained
   exchanges. Requests have deadlines and optional parent question IDs with bounded depth.
   No automatic broadcasts, model polls, or endless agent reply loops. Pause holds new sends
   and withdraws queued terminal writes; resume only releases known-unsent work.
10. **Failure.** Offline, unpaired, busy, draft, expired, cancelled, and uncertain states are
    visible and actionable. Cancellation stops unsent notices, never interrupts an agent's
    unrelated task. Late answers remain attributable but do not automatically resume cancelled
    or expired work. Closing UI, timing out a poll, and losing an RPC reply do not cancel or
    resend work. Retry uses the original operation ID.
11. **Clients.** Desktop and browser share the existing Flutter workspace. Mobile presents the
    same roster and exchanges through its daemon connection. CLI provides readable output,
    structured JSON, and a terminal conversation view. All clients reconstruct from daemon
    state and ignore older revisions. Controls explain old-daemon incompatibility.
12. **Verification.** Exercise real cross-engine question → reply → continuation in isolated
    sessions; test restart, duplicate requests, wrong-member replies, busy/draft/dialog safety,
    cancellation, expiry, deadlock avoidance, remote encryption, and UI reconnect/keyboard and
    visual behavior. Synthetic transcripts and green unit tests alone do not establish live
    engine support. Never use the person's ongoing sessions as disposable test fixtures.

## Components

`cli/src/teams/` owns the protocol model, private ledger, participant mailboxes, command
adapter, prompts, and tests. `BackendSocket` supplies the existing authenticated transport
and registry. The existing session-input controller supplies serialized terminal writes,
with a team-only preflight that preserves drafts and dialogs. Remote delivery uses the
existing machine relay; each destination owns and deduplicates its local terminal receipts.

Team UI is a projection of the ledger. It retains operation IDs across uncertain replies,
shows question state separately from delivery state, and keeps the user's draft while
refreshing. Standalone team membership is independent of pane visibility and can span paired machines. Tab channels follow saved tab membership instead.
Capabilities remain in private daemon records and the relevant member's introduction; they
are omitted from public snapshots, RPC frame logs, and ordinary UI. The selected agent's own
conversation and shell commands include its key, so connecting a member shares that team's
context with the member's existing engine/provider. Removing a member revokes its key. Adding
the same session again creates a new membership and key; old exchanges remain attributable.

## Advanced standalone teams

The main desktop/web and phone entries open tab channels. Standalone teams remain
available through the CLI for explicit groups that do not follow tab membership.
Their original creation/editing widgets remain in the implementation for compatibility
and tests; the default channel view has no creation form or human question composer.

Standalone team creation sends the selected agents introductions. Pausing holds
known-unsent deliveries, membership edits change the explicit roster, and archiving
retains the record while cancelling pending work. Tab channel membership instead
follows the saved desk and permits already-started exchanges to finish after departure;
see the channel guide for that extension and its backend activation.

The CLI is also a complete client. `harness team --help` lists commands. For example, create
`team.json` using actual machine and agent IDs from the sessions you intend to connect:

```json
{
  "id": "ad185a5b4dc24492bc1c080681efdb32",
  "name": "Build Harness",
  "members": [
    {"machineId": "YOUR_MACHINE_ID", "agentId": "DAEMON_AGENT_ID", "name": "daemons", "role": "Daemon protocol and APIs"},
    {"machineId": "YOUR_MACHINE_ID", "agentId": "MOBILE_AGENT_ID", "name": "mobile", "role": "Phone client and mobile UX"}
  ]
}
```

```sh
harness team create --file team.json --json
harness team --team ad185a5b4dc24492bc1c080681efdb32 members
harness team --team ad185a5b4dc24492bc1c080681efdb32 watch
```

`watch` is a read-only TUI: use Up/Down or j/k to select an exchange, r to refresh, q or Esc
to close. In redirected output, use `get --json` instead. Pass `--machine MACHINE_ID` when
the team belongs to another paired machine. `--port` selects a different local daemon.

Agents use the exact command prefix in their introduction. It includes the owner machine,
team, and private member key, so `ask daemons 'Which endpoint returns daemon state?'`
automatically identifies the sender. `reply QUESTION_ID 'The endpoint is …' --evidence
'path/to/file.ts:42'` records the answer. Use `--text-file PATH` for multiline text. `inbox`
reads pending questions and recent answers; `wait QUESTION_ID --seconds 30` yields incoming
questions first and never cancels a request on timeout. The owner CLI can initiate an ask
with `--from MEMBER_ID`; `members` provides membership IDs, which differ from agent IDs.

For an uncertain create, ask, or add, reuse its operation ID and identical content. CLI
errors include `operationId`; keep it as `id` in a create/add JSON file or use `ask --id`.
The UI retains these attempts and offers **Check connection**, **Check send**, or
**Check teammate**, including after closing and reopening the workspace in the same app
session. After restarting the app, inspect the ledger before creating a replacement.

## Protocol and recovery

`team` requests carry an `action`, `requestId`, and (except list/create/capabilities)
`teamId`. A member supplies `memberKey`; owner connections omit it. The transport returns
`team_result` with the matching request ID and either a result or `{error, detail}`.
`capabilities` returns `protocol: "team.v1"`. Team snapshots contain a monotonic revision
and omit membership keys. `team_delivery` is the owner-to-destination RPC for runtime
inspection, submission, status, hold/release, cancellation, and inbox consumption.

An agent ask is a payload such as:

```json
{
  "action": "ask",
  "teamId": "ad185a5b4dc24492bc1c080681efdb32",
  "memberKey": "PRIVATE_MEMBER_KEY",
  "id": "2c9a4efb568e41aeb15791672d35d875",
  "to": "daemons",
  "text": "Which endpoint returns daemon state?",
  "context": "I am implementing the phone's daemon list.",
  "ttlMs": 900000
}
```

`reply` uses `questionId`, `text`, and optional `evidence: [...]`. Only the addressed member
can answer as that agent. An owner reply also names `memberId` and is attributed to the
user. A late answer is retained, with `late: true`, without automatically continuing expired
or cancelled work. `notify: false` on an ask permits explicit inbox/status retrieval without
an answer notification. `parentId` links a follow-up to an exchange involving the sender.

Delivery states are observations, separate from question state. **Queued** can mean busy,
offline, draft, permission dialog, or temporary input queue pressure. **Agent accepted input**
means a matching turn was observed, not that the question was answered. **Read in inbox**
means the member retrieved the record. **Delivery unconfirmed** means it might have reached
the terminal: inspect that member or have it read `inbox`/`status`; do not invent a new ID and
resend. Reading suppresses a notice only if it has not already been pasted. The final write
guard rechecks the receipt and captured terminal state; it cannot make a physical keyboard
and terminal paste atomic.

The owner stores private records under the daemon data directory's `teams/` tree. Each
destination stores its own private delivery records there. Directories are mode 0700 and
records 0600, written by atomic rename with file and directory synchronization on Unix.
After a restart, known-unsent notices resume; uncertain writes remain uncertain. Corrupt
files produce an error and remain intact for recovery. No background retention deletion is
performed. Back up the team state before manual repair; deleting receipts can remove the
evidence that prevents a duplicate delivery.

Bounds are explicit: 100 retained teams per owner, 32 retained memberships and 500 exchanges
per team, 8 pending questions per sender, 30 questions per minute per team, and at most four
questions in a parent chain. Question/context fields each allow 8,000 characters; answers
16,000; evidence 16 references of at most 1,024 characters each. Terminal notices fit 24 KB
and link to the full ledger text when excerpted. Question deadlines default to 15 minutes
and range from 10 seconds to 24 hours. Introductions and answer notices expire after 24 hours.
Each destination retains at most 10,000 delivery records and accepts at most 32 queued or
submitted notices per agent. Archive retains history and therefore does not reclaim these
limits. Exhaustion is an explicit error, not silent history loss.

## Verification status

Implemented: daemon protocol and recovery, encrypted relay framing, queued terminal input,
CLI/TUI, desktop/web workspace, and the self-contained mobile client. No existing user
session has been connected, restarted, or used as a test fixture. No release has been deployed.

Automated checks exercise durable replay, conflicting IDs, wrong-member replies, explicit
human attribution, late answers, removal/rejoin, pause/cancel/expiry races, draft/dialog/busy
safety, queue pressure, inbox consumption, and mutual-wait handling. Transport tests use a
real loopback WebSocket server. Relay tests perform actual pairing and encrypted round trips
with team bodies and capabilities, including replay rejection. A two-daemon fixture
(`cli/src/teams/remote.spec.ts`) also drives the full question → explicit reply → continuation
path through real local WebSocket APIs, `RemoteRelayPool`, and `BackendSocket` instances.
It pairs disposable client identities, routes the recipient's reply through its own local
daemon back to the owner, checks duplicate-reply suppression, and asserts that bodies and
membership keys are absent from relay-visible frames. Only the cloud's opaque routing and
agent terminal behavior are simulated. This passed locally; it does not establish behavior
on physical remote machines or at model providers.

CLI typechecking and builds passed. The full CLI suite passed 4,911 tests, with one unrelated
Hermes hook fixture failure (missing temporary registry file); that test passed when rerun
in isolation. The focused Team/input/encryption run passed 123 tests; both TUI tests passed
after the final roster-layout improvement. The additional complete paired-relay fixture
passed. Desktop regression tests passed (82 tests before the final additional encryption case); final Team
and encryption tests passed (18 tests). Phone Team/controller/event/encryption tests passed
(17 tests). Static analysis of the changed desktop and phone code passed. Widget
checks cover 320/390-pixel phone widths, desktop narrow/wide layouts, active theme variants,
large terminal fonts, explicit Connect, keyboard close, refresh, and preserved drafts.
Rendered desktop and phone fixtures were visually inspected. Screen-reader interaction and
physical native keyboard/IME behavior have not been manually exercised.

Normal macOS debug and web production builds succeeded. The macOS artifact is
`desktop/build/macos/Build/Products/Debug/Harness.app`; web output is `desktop/build/web`.
No Android/iOS release build or browser-device interaction test was performed.

**The complete live Claude/Codex/Grok acceptance passed.** After explicit user approval and
renewing Grok's login, the native test drove Claude Code 2.1.283, Codex 0.154.0, and Grok 1.0.34
in disposable tmux sessions. Claude asked each peer for a different random value in its private
fixture file. Both peers explicitly replied through the daemon, and Claude retrieved the
correlated answers and wrote both exact values into `RESULT.txt`. Question and return receipts
became `received`; all three introductions were attributed to matching native turns. The fixture
exited successfully and removed its copied authentication files. See the
[live verification record](agent-teams-live-verification.md) for identifiers and evidence.

The live run exposed two compatibility issues now fixed: Codex's configurable footer was
mistaken for a draft, and Claude's new `pasted_content` envelope made an accepted introduction
appear unconfirmed. Regression tests cover both, including negative attribution checks.
The final focused Team/input/encryption run passed 96 tests after these changes; typechecks
and the CLI build passed. The fixture's workspace-trust handling also now explicitly selects
Claude's Yes option instead of assuming the default selection.

An earlier Grok attempt stopped at browser sign-in because its cached refresh token was
invalid. The user completed `grok login`, and the full passing run verified real Grok model
participation. The native gate is complete for these measured provider versions.

`cli/scripts/team-native-e2e.ts` uses a separate tmux server, a six-minute acceptance deadline,
and at most nine observed turns per agent per run. It cleans up its own sessions and copied
authentication files. The default run requires Claude to obtain and use different random
strings from both peers. With authorization and working provider logins, run from `cli/`:

```sh
HARNESS_TEAM_LIVE=1 npx tsx scripts/team-native-e2e.ts
```

`HARNESS_TEAM_ENGINES=codex,claude` selects the two-engine diagnostic run. Its evidence
explicitly reports `fullAcceptance: false`; it does not replace the default three-engine gate.

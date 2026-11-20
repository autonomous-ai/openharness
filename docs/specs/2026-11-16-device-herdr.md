# The dial lists, follows, talks to and opens herdr's agents over herdr's socket (PM for Diego, 2026-11-16)

This is item #5 of wave 1 in the device integration roadmap: section 3, row 5 of the priority list, and item 3 of
Phase 0 in the roadmap. On `main` (8fcfa7de5c, after #4341) the dial reaches a herdr agent only when that agent's own
hook ran and sent `HERDR_PANE_ID`. A tap then runs `herdr agent focus <pane>` (`cli/src/cable/hosts/herdr.ts`).

Two gaps follow:
- An agent with no hook is not on the dial at all. That covers most of the 19 kinds herdr detects, which Harness has
  no hook for, and any agent started before the daemon.
- No herdr agent takes the dial's words.

## Goal

With herdr running on this computer:
- every agent herdr sees is on the dial with its live state, whether or not a hook told of it;
- a tap brings its pane forward in herdr;
- the dial's words reach it as its next prompt, only while it is at its prompt, and never a pane that holds anything
  else.

## The spike (2026-11-16, herdr 0.8.0, protocol 19, this Mac)

herdr 0.8.0 is installed (`~/.local/bin/herdr`), and its server was not running. Nothing was installed.

The spike ran two private herdr servers, one after the other, never Diego's `~/.config/herdr`:
- `HOME` and `XDG_CONFIG_HOME` were set in the session's scratch folder;
- a pane ran a 10-line C program named `claude` that echoes each line it reads;
- `pane.report_agent` told herdr that pane held a `claude` agent.

Both servers were stopped afterwards.

| Case | What happened |
|---|---|
| Socket | `$XDG_CONFIG_HOME/herdr/herdr.sock`, else `~/.config/herdr/herdr.sock`; herdr follows `XDG_CONFIG_HOME`. A path over about 104 bytes (`sun_path`) fails to bind |
| Framing | Newline-delimited JSON. A request is `{"id","method","params"}`. The answer is `{"id","result":{"type",...}}` or `{"id","error":{"code","message"}}`. A malformed request gets `"id":""` and `invalid_request` |
| One request per connection | The server closes the connection after its answer. A second request on a subscription's connection closes that subscription |
| `agent.list` | `{"type":"agent_list","agents":[AgentInfo]}`, where `AgentInfo` has `pane_id` (`w1:p1`), `terminal_id`, `agent` (kind: `claude`, `codex` and so on), `agent_status`, `focused`, `cwd`, and, when known, `name`, `title` and `agent_session` (`{agent, kind: id\|path, value}`) |
| `agent.get {target: <pane_id>}` | `{"type":"agent_info","agent":AgentInfo}`. A pane with no agent gets `agent_not_found` |
| `events.subscribe` | Answers `subscription_started`, then replays one `pane_agent_detected` per present agent. Only the kinds subscribed to are replayed. No status is replayed, and no marker ends the replay |
| Agent arrives | `{"event":"pane_agent_detected","data":{"pane_id","agent","workspace_id"}}` |
| Agent leaves (its process exits) | `pane_agent_detected` with `"released":true,"final_status":"done"`, then status `unknown`. `agent.get` then answers `agent_not_found` |
| Pane closes | `{"event":"pane_closed","data":{"pane_id"}}` |
| Status | `{"event":"pane.agent_status_changed","data":{"pane_id","agent","agent_status"}}`, only for a `pane_id` named in the subscription: one entry per pane. It arrives in the same millisecond as the change. `pane.updated` carries no status change |
| `done` | An agent in an unfocused pane going from working to idle reads `done`. Focusing it (`agent.focus`) marks it seen |
| `agent.prompt` to an idle agent | Text and Enter landed as one submitted line: `{"type":"agent_prompted"}` |
| `agent.prompt` when the pane's foreground is a shell | Refused with `agent_not_ready` ("no longer the pane foreground process"), and nothing typed. `agent.list` still lists that agent from its last report |
| `agent.prompt` to a pane with no agent | Refused with `agent_not_found` |
| `agent.prompt` while working or blocked | **Typed anyway.** herdr has no queue and no idle check. The working agent's Enter was lost, and its text joined the next prompt |
| A newline in the text | Typed as Enter: two submitted lines |
| Empty text | Refused with `empty_agent_prompt` |
| A named session (`herdr --session <name>`) | A server of its own, at `<config>/herdr/sessions/<name>/herdr.sock`. Its pane ids start again at `w1:p1`. Its panes have `HERDR_SESSION=<name>`; the default session's (plain `herdr`, or `--session default`) have none. Both have `HERDR_SOCKET_PATH` |

From the screen alone, with no hook, herdr detects these kinds: pi, claude, codex, gemini, cursor, devin, agy, cline,
opencode, copilot, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli and maki (`herdr server agent-manifests`). Most
of these names are also Harness engine ids.

### herdr's plugin system (what exists)

`herdr plugin install <OWNER/REPO[/SUBDIR]> [--ref <ref>]` installs a plugin from a GitHub repository. The other
commands are `link` (a local folder), `enable`, `disable`, `list`, `action`, `log` and `pane`.

A plugin's manifest declares:
- `actions`: commands a person runs from herdr;
- `panes`: an overlay or a split that runs a command;
- `events`: a command run on a herdr event;
- `startup` and `build` commands;
- `link_handlers`;
- `platforms` (linux, macos, windows) and `min_herdr_version`.

A plugin runs its commands with the person's rights, inside herdr.

## Design

Everything is in the devices process. The core never hears of herdr (cli/AGENTS.md rule 7).

### One herdr client (`cli/src/cable/hosts/herdrClient.ts`)

The herdr adapter and the herdr source share it.

- **Socket path:** `$XDG_CONFIG_HOME/herdr/herdr.sock`, else `~/.config/herdr/herdr.sock`, from the daemon's own
  environment, as herdr itself works it out.
  - Named sessions (`herdr --session <name>`) and remote servers are not followed (Follow-ups). A hook from a named
    session names no herdr pane (the adapter, below).
  - A `HERDR_SOCKET_PATH` set in another process is not seen: the daemon reads no other process's environment.
  - Before each connection the path must be a socket owned by this user (`lstat`).
- **`request(method, params)`:** one connection, one line out, one answer in. It has a 10 s deadline
  (`RUN_TIMEOUT_MS`). It answers the result or a fault, and never throws. A fault is the client's own word
  (`no_socket`, `refused`, `timeout`, `ended`, `oversize`, `bad_json`, `bad_answer`), or `rejected` for herdr's own
  refusal, with herdr's code held beside it. So no code of herdr's reads as one of the client's words: a herdr that
  answers `no_socket` has a socket.
- **`subscribe(entries, onEvent, onClose)`:** one connection that is held open, closable by its caller.
- **Bounds:** a line over 1 MiB, or bad JSON, closes that connection with a reason code.
- **`prompt(paneId, kind, text)`:**
  1. `agent.get` reads the pane again: it must still hold that kind, in state `idle` or `done`;
  2. `agent.prompt` then sends the line.

  herdr has no conditional prompt, so step 1 narrows the gap to one round trip. Every prompt goes through here, a
  hooked agent's and a listed agent's alike, so each gets this check.
  - The text is never empty and at most `MAX_TEXT` (2000) characters.
  - Control characters become spaces, as Orca's `send` does, since herdr types a newline as Enter.
  - The answer is `sent`, `busy` (not idle) or `failed`, with the fault as a request says it, or `bad_request` (the
    client would not send it) or `not_that_agent` (the pane holds another kind).
- **No focus (Q6).** The socket carries listing, status and words only: `agent.list`, `agent.get`,
  `events.subscribe` and `agent.prompt`. A tap stays the `herdr agent focus` command (the adapter, below).

### A herdr source (`cli/src/cable/hosts/herdrSource.ts`)

A new `HostSource` with the id `herdr`.

- **When it runs:** while a dial is attached, as the open scan does (`devices.ts` `attached`), on macOS and Linux, with
  `herdr` on `PATH`, as the adapter's `focus` needs. `PATH` is read again at each attach.
  - With no herdr installed, nothing is subscribed or watched: no watch of `~/.config` or the home folder (recursive on
    macOS) waits for a socket that never comes.
  - On Windows it never runs.
  - It closes its connections, watch and timers when the dial detaches and when the devices stop.
- **Following herdr's agents:** one subscription holds `pane.agent_detected`, `pane.closed`, `pane.exited`, and one
  `pane.agent_status_changed` entry per known agent pane. Every time a subscription starts, one `agent.list` follows
  it and sets every agent's fields and state. A change made while the list is in flight is still heard, because the
  subscription is already live.
  - A replayed `pane_agent_detected` for a pane already known changes nothing, so a new subscription's replay never
    leads to another one.
  - A `pane_agent_detected` for a pane not yet known starts a new subscription with that pane added. The new
    subscription opens before the old one closes. At most one new subscription is started per second; detections
    that arrive meanwhile join it.
  - A `released` detection, a `pane_closed` or a `pane_exited` drops that pane at once. A pane that left needs no new
    subscription: pane ids are never reused.
  - A status event sets that agent's state.
- **Push, not poll:**
  - With no socket, it watches the nearest existing folder of `herdr/`, its config folder, and the home folder, and
    connects when the socket appears.
  - A refused connection or a dropped subscription retries after 1 s, doubling up to 60 s.
  - After a 60 s retry of an attempt that never listed fails, it stops retrying and waits on the watch: a server that
    starts again replaces the socket file. A refused socket nothing has subscribed on is stale at once, after one
    retry when it is under 2 s old ([Herdr Core](../plans/2026-11-16-herdr-app-design.md#herdr-080s-stale-socket-herdrsourcets)).
  - An attempt that listed keeps the 60 s retry and is never given up on: that herdr is running, but drops each
    subscription.
  - On a drop, the agents stay listed with their last state until the first retry. If that retry fails, the list
    empties.
  - A retry that finds another socket (another inode or change time) is a herdr that started again. It numbers its
    panes afresh, so the list empties before it connects: a kept row would take the status of the new pane of its id,
    and a `working` row turned `idle` would give a done card no turn had.
- **Each agent:**

  | Field | Value |
  |---|---|
  | `id` | A fresh UUID per pane id and kind. It is kept across reconnects to the same socket while the pane stays listed, and dropped with the pane |
  | `engine` | herdr's kind |
  | `sessionId` | `agent_session.value` when its `kind` is `id` |
  | `cwd` | herdr's `cwd` |
  | `host`, `app` | `herdr` |
  | `name` | herdr's name for the agent if it has one, else its folder's name, else its kind. herdr's `title` is not read (Q8) |
  | `paneKeys` | `['herdr:<pane_id>']` |

  | herdr state | Dial state |
  |---|---|
  | `idle` | idle. After `working` or `blocked`: done, with nothing unseen (`unseenDone` false) |
  | `done` | done, with `unseenDone` |
  | `working` | working |
  | `blocked` | needs-you |
  | `unknown` | idle. It is listed, but voice refuses it |

  herdr says `idle`, never `done`, when a turn ends in the pane it has focused. With one pane, always focused, that is
  every turn. So a change from `working` or `blocked` to `idle` still tells the dial the turn is done, with a done card
  (Q10).

  `markSeen` clears `unseenDone` here only: turning the dial to an agent does not focus its pane in herdr.
- **Capabilities:** status, voice and focus, but no answer (`svf`). A blocked agent's row shows `Waiting for you ·
  herdr`, as an observed agent with no question text does.
- **Voice:**
  - The source refuses by its own state first: needs-you gets the waiting sentence; working or unknown get the busy
    sentence.
  - Then it prompts through the herdr adapter (below), which holds one operation per pane and calls
    `client.prompt`. Words already under way to the pane are the adapter's `busy`, which gets the busy sentence too.
  - The sentences are the observed source's:
    - busy: `<name> is busy. Say it when it is done.`
    - waiting: `<name> is waiting for your answer in herdr.`
    - too long: `Too long. Say it shorter.`
    - no answer, for `failed`: `<name> did not answer.`
  - Each outcome goes to the counter the observed source uses (`ObservedActions.count`): `herdr` when sent; `busy`,
    `waiting`, `too-long` or `no-answer` when refused.
- **Tap:** the herdr adapter's `focus` (below), taken from the devices' `adapters` list, so the dial's move is noted
  as every other tap's is (`devices.ts` `noting`).
  - No app is brought forward. A listed agent has no hint of the terminal that holds herdr's client.
  - The herdr app (`dev.herdr.app`) is opened only for a hooked agent that says it runs there, as today.
- **Checked input:** every field from the socket is checked in this file before use:
  - `pane_id` against `HERDR_PANE` (`w<n>:p<n>`, each `<n>` in herdr's base 32 over `123456789ABCDEFGHJKMNPQRSTVWXYZ0`,
    so `w2:pE`: [2026-11-20-dial-herdr-pane-ids-design.md](../plans/2026-11-20-dial-herdr-pane-ids-design.md));
  - the kind against herdr's own name rule, `[a-z][a-z0-9_-]{0,31}`;
  - the status against its enum;
  - names cut to 64 characters, with control characters removed;
  - `cwd` cut to 4096 characters.

  An entry that fails any check is left out. At most 64 agents are listed. The rest are left out, with one log line.

### The herdr adapter (`hosts/herdr.ts`)

- `focus` stays the `herdr agent focus <pane>` command, exactly as `main` runs it, on every platform: the same pane
  check, lookup on `PATH`, arguments and timeout (Q6). So there is one way to focus, and a hooked agent's tap on
  Windows is not lost. The herdr source's tap runs this same `focus`.
- `type` is new: `client.prompt` with the kind it was given. A hooked agent in a herdr pane (an observed agent) then
  takes words when neither its mod nor the Codex queue does, under the observed source's idle rules. The client's
  `agent.get` check runs as well, since that agent's pane was named by a hook.
  - On Windows the adapter has no `type`: the client does not speak herdr's named pipe, so no words are offered
    through herdr there, as today.
  - `canType` (new on `HostAdapter`, asked at each look as `canShow` is) answers whether the client finds herdr's
    socket (`socketStamp`). A daemon started by launchd or systemd may not have the shell's `XDG_CONFIG_HOME`. With no
    socket the observed source's words skip herdr, and no other app takes them: since #4336 a multiplexer's agent has
    no Orca pane ([wave 1 checks](2026-11-15-device-wave1-checks.md)), so an agent in a herdr pane, inside an Orca
    terminal or not (Ghostty, say), lists no voice but its mod's or the Codex queue's, and takes no rest through Orca.
- **A hook's pane is the default session's.** A named session's pane ids start again at `w1:p1` (the spike), so a
  hook's `HERDR_PANE_ID` from one could make the dial type into, fold away or focus the default session's agent of the
  same id. The hook (`cli/hook/notify.mjs`) reads only its own environment: when `HERDR_SESSION` is set, it leaves
  `HERDR_PANE_ID` out. It never sends the session's name or its socket's path.
- **One operation per pane at a time**, as Orca's switch and send do. The adapter holds both the command and the
  client, so it keeps the order:
  - a prompt waits for a focus under way on the same pane;
  - a focus waits for a prompt under way;
  - a second focus is the same run;
  - a second prompt is `busy`.

  The herdr source's words go through the adapter too, so they keep this order with a tap.
- herdr comes first in the adapter order. So a herdr inside an Orca terminal now takes words through herdr, into the
  agent's own pane, instead of through Orca, while herdr's socket is there. Orca types into whichever pane herdr has
  focused (Q4).
- `type` answers a boolean, as the interface says. The observed source counts `herdr` from `actions.count(adapter)`,
  as it does for Orca.

### One agent, one row (the merge key #4341 left to this pull request)

A hooked agent in herdr is seen twice: once by its hook (observed) and once by `agent.list` (herdr).

- **The key:** `HostAgent` gains `paneKeys`, filled only with herdr pane keys:
  - the herdr source's agent gets `herdr:<pane_id>`;
  - in `ObservedSource.list()`, a live observed entry whose panes include a herdr pane gets `herdr:<id>`. An ended
    entry gets none.

  No tty, Orca handle or other pane becomes a key, so no two observed entries ever fold into one.
- **The match:** `HostRegistry` treats two copies **from different sources** as the same agent when they share a
  session key (engine and session id, as today) or a pane key. Within one source, nothing changes.
- **The winner:** the observed copy wins over the herdr copy (Q2). It carries the last answer, the question's text,
  the mod and the Codex queue, and it reaches the same herdr pane for words and taps. The strength order becomes
  Harness, then observed, then any listing source.
  - This reverses the order the 2026-11-15 spec planned for a listing adapter, and `registry.spec.ts:40` changes with
    it.
  - With no listing source on `main`, this changes nothing a person sees today.
- **Ids:** an id the dial still holds after a hook arrives (the herdr copy's) acts as on `main` (Q7): its words are
  refused and its tap is ignored until the next list, at most about a second later, shows the hook's row.
  `HostRegistry.outside` looks through every source other than Harness, listed or not, so that id never reaches the
  core. `cableHost.ts` does not change.
- **Pages:** a hooked agent stays on the page of its outermost app, as today: herdr inside Ghostty is on Ghostty's
  page. An agent no hook told of is on the herdr page.
- **A scan-only session:** a Claude Code session found only by the open scan (no hook yet, so no pane) matches only by
  session id. herdr reports that id only with its own Claude integration installed. Until the session's next hook, it
  may be listed twice, once per source.

### The dial: cards and reminders for both outside sources

`services/devices.ts` reads `observed` alone in six places:
- `outside` (:337);
- `waiting` (:340);
- `told`;
- `showWaits` (:649);
- the `onChange` turn (:665);
- `remind` (:711).

Each of them now reads the **outside agents**: the entries of the registry's merged list whose source is not Harness.
So cards go only to the copy the dial lists, never to a hidden duplicate.

- Both sources' `onChange` run the same turn.
- `waiting` asks the observed source for a question's text only for its own agents.
- The activity lookup's fallthrough (:349) never sends an outside id to the core.

The herdr source joins the registry after observed, behind the same kill switch as the observed agents,
`HARNESS_DEVICE_OBSERVED=off` (Q3). It has no last answer, so it gets no summary card.

### Measures and logs

- Log lines, with no ids, names, paths or text:
  - `[herdr] listed · <n> agents`
  - `[herdr] list · <reason code>`, when `agent.list` fails; herdr's own error codes are said as `rejected`
  - `[herdr] closed · <reason code>`
  - `[herdr] retry · <seconds>`
  - `[herdr] over · <n> left out`
  - `[herdr] skipped · <n> pane-id`, when the number of entries left out for their `pane_id` changes
- The voice outcomes above, through the existing counter.

## Platforms

- **macOS and Linux:** herdr runs on a Unix socket there, and that is where the observed agents run today.
- **Windows:** herdr uses a named pipe, which the client does not speak. The source does not run there, and no words
  go through herdr. A hooked agent's tap runs `herdr agent focus`, as today.

## Data

Nothing is stored or synced. For each herdr agent, the dial gets the fields it gets for an observed one (name, state,
kind and folder), over the same local link. The socket is read as this user only, from the devices process.

## Testing

- **Specs:** a fake herdr server, a Unix socket in the test's temp folder, replays the spike's recorded lines with paths
  removed. It covers:
  - the framing;
  - one request per connection;
  - a second request closing a subscription;
  - the replay and the released detection;
  - every refusal code;
  - a stale socket;
  - a line over the bound.
- **End to end, on this Mac only:** a private herdr 0.8.0 server, with its `XDG_CONFIG_HOME` under the e2e daemon's
  `HOME`, a short root kept under `sun_path`, and the fake agent binary. It is never Diego's own herdr session. The
  file is skipped where herdr is not installed, and no workflow changes (Q9).

## Out of scope

- **A herdr plugin (Q5).** herdr has the plugin system above. The roadmap's plugin is a Phase 2 distribution item:
  "a small panel that says the device is connected and points to the shop; the integration stays in the app". It also
  needs a public GitHub repository for `herdr plugin install`.
- Answering a blocked agent from the dial. It is answered in herdr, as today.
- Installing or starting herdr, and herdr's own integrations (`herdr integration install`).
- Windows, beyond the tap a hooked agent has there today.

## Follow-ups

- **Named herdr sessions (`herdr --session <name>`) and remote (`--remote`) servers.** The source follows only the
  default session's socket. Today a hooked agent in a named session shows its status through its hook only: its hook
  names no herdr pane, so no tap focuses its pane and no words go to it through herdr. It is reached only as an agent
  outside herdr is (its app, its mod, Codex's queue). An agent there with no hook is not on the dial.

## Done when

1. With herdr's server running and no hook, its agents are listed with their state. A status change reaches the dial
   as a card within a second, a turn that ends `idle` in a focused pane included.
2. A tap focuses the agent's pane in herdr. Focus stays the `herdr agent focus <pane>` command, as `main` runs it, on
   every platform.
3. The dial's words reach an idle or done herdr agent as one submitted line. They are refused, and nothing is typed,
   when:
   - the agent is working, blocked or unknown;
   - its pane holds a shell;
   - the text is empty or too long.
4. A hooked agent in herdr is listed once, from its hook's copy, and gets each card once.
5. When herdr is closed, nothing is listed and no timer runs. When herdr starts later, its agents appear without a
   daemon restart.
6. The specs and the end-to-end check under Testing pass.

## Decided (PM for Diego, 2026-11-16)

- **Q1.** Voice by `agent.prompt`, behind a fresh `agent.get`, instead of `pane.send_text` + `pane.send_keys`: herdr
  then refuses a pane that is not the agent.
- **Q2.** When the two copies match, the hook's copy wins over herdr's.
- **Q3.** The same kill switch as the observed agents (`HARNESS_DEVICE_OBSERVED=off`); the source runs only while a
  dial is attached.
- **Q4.** The herdr adapter types for hooked agents too, ahead of Orca.
- **Q5.** The herdr plugin is its own later item, not this pull request.

Answered after the draft plan (PM for Diego, 2026-11-16):

- **Q6.** Focus stays the `herdr agent focus <pane>` command on every platform, exactly as `main` runs it. The socket
  is used only for listing, status and words. The herdr source's tap goes through the same adapter `focus`. The
  adapter keeps one operation per pane between a focus and a prompt.
- **Q7.** An id the dial still holds after the hook's copy took the row acts as on `main`: refused or ignored until
  the next list. `cableHost.ts` does not change.
- **Q8.** herdr's `title` is not read. The name is herdr's name, else the folder's name, else the kind.
- **Q9.** No workflow changes. The herdr end-to-end file is skipped where herdr is not installed.
- **Q10.** A herdr agent that goes from `working` or `blocked` to `idle` tells the dial its turn is done, with nothing
  unseen. `done` from herdr stays done, with `unseenDone`.

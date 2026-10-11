# Harness Pro: cable contract with the daemon

The daemon (`cli/src/cable/*`) talks to every device over the same framed JSON cable. The Harness Pro (Pod UI)
and the round dial are two clients of that one daemon. They differ only in what their `hello` says.

**The hello capabilities are the contract.** A capability key in the hello turns on extra daemon output for that
session. A device that names none of them (the round dial, or an older Pro) gets exactly the traffic it gets
today: no new field, no new message, byte-identical frames. A daemon that predates a capability simply ignores
the key, and the Pro must still work with empty bodies (plan, Review Focus 1).

Sources: branch `dev/firmware-pro` at 0c73edf72 (read-only), merge base with main `59ce00535`; main at
`10c9e7420`. Firmware side: `SRC/main/cable_client.c`, `ui/habitat/ui_habitat.c`,
`ui/habitat/pro_player_library.h` (`SRC` = `devices/harness-device/firmware` in the read-only worktree).

## 1. Pro hello (owner decision 7)

Full key list, in the order the Pro sends it:

| Key | Value | Meaning |
|---|---|---|
| `fw` | firmware version string | existing |
| `product` | `CABLE_PRODUCT` | existing; the daemon releases the port if it does not match |
| `proto` | number | existing |
| `hw` | board name | existing, informational |
| `board` | `"pro"` | new on main: names the client kind, for logs |
| `swarms` | `"members-v1"` | capability |
| `recap` | `"long-v1"` | capability |
| `activity` | `"steps-v1"` | capability |
| `player` | `"library-v1"` | capability |
| `mac` | `aa:bb:...` | existing |

Dropped from the branch's hello: `speech` (`pcm16-v1`). The Pro does not take speech output.

A capability is a positive string match; any other value (absent, wrong string, wrong type) means "off".
Capabilities are per session: they reset on a new port and on close, like the branch's `playerCapable`.

## 2. Capability table

| Capability | Turns on | JSON shape and limits |
|---|---|---|
| `swarms: "members-v1"` | `agentIds` and `members` on each `swarms` item | `{t:"swarms", selected, items:[{id, name, agents, panes, agentIds?:string[], members?:[{id, name, engine, machine, online:bool}]}], tiles:[{x1,y1,x2,y2,a}]}`. One frame, hard cap `CABLE_MAX_PAYLOAD` = 8192 B; the daemon budgets 8192 - 256 B. Shrink order when too big: ids + members for all tabs, then ids for all tabs, then ids for the selected tab only, then none. Firmware caps: 24 tabs (`SWARMS_MAX`), 24 ids per tab (`SWARM_MEMBERS_MAX`), id < 48 B (`ID_MAX`). `members` only names ids that are in `agentIds`; it covers ids the roster and library cannot name (an offline machine's agent). `online` is false only when the daemon knows that machine is `offline`; absent or unknown reads as online. |
| `recap: "long-v1"` | `full` on `summary` (live and `restore:true`) | `{t:"summary", agentId, recap, text, full?:string, restore?:true, ...}`. `full` is the whole answer's prose: markdown stripped, whitespace collapsed, at most **1200 chars**, at most **3600 UTF-8 bytes**, cut on a word boundary with `…`. Omitted (not empty) when the answer has no text. Firmware recap buffer is 2048 B. `recap` and `text` are unchanged. |
| `activity: "steps-v1"` | `step`, `action`, `elapsedSeconds` on `turn.activity` | `{t:"turn.activity", agentId, text, action?:string, elapsedSeconds?:int, step?:string}`. `step`: one tool card as `"Tool · arg"` (a path argument keeps its last segment), at most **120 chars**, sent as `{text:"", step}` the moment the tool starts; the firmware cuts at 400. `action`: latest assistant-written progress paragraph, whitespace collapsed, at most **188 bytes** (firmware keeps 192 B). `elapsedSeconds`: integer **0..2592000**, parsed from the engine footer (`1h 2m 3s`); anything else is omitted. `action` also rides on the first `turn.activity` right after `turn.started`. |
| `player: "library-v1"` | feature `player.library` in `welcome.features`; the `player.library.get` request and the `player.library` reply | Request (device to host): `{t:"player.library.get", offset:int 0..1000000, request:int 0..4294967295}`; anything else is ignored. Reply: `{t:"player.library", request, offset, total, machines, rows:[...]}`. `rows` has at most **6** (page size); `offset` is clamped to `max(0, total-6)`; the page is never re-sorted (desktop order). Row: `{id, machineId, name, engine, status, ageSeconds}`; `id`, `machineId` non-empty and < 48 B; `name` <= 95 B, `engine` <= 15 B (control chars to spaces, UTF-8 safe); `status` one of `idle working question finished failed paused offline`; `ageSeconds` is -1 (unknown) or 0..315360000. The firmware rejects the whole page if `count != min(6, total - offset)`. `request` echoes the latest request; a reply for an older request is dropped. Resent at most every 10 s unless the page changed. |

Order of arrival the firmware tolerates: any. Every field above is optional on the device side; a missing one
leaves the Pod showing an empty body, never an error.

## 3. Port inventory

Branch commits touching `cli/` and `desktop/` since the merge base: `92283ad62` (dock companion, unrelated to Pod),
`4051f87f4` (Harness Player 1), `07ea2fd55` (every session in the Player library), `0c73edf72` (Pod). Firmware
reads below are `SRC/main/...`.

| Feature (branch files) | (a) Pod reads it | (b) On main | (c) Port |
|---|---|---|---|
| **Swarm members**: `agentIds` on `swarms` items; `swarmMembers` flag; `members` metadata (`memberMeta`, `SwarmMemberMeta`); 8 KB shrink in `swarmsMessage`; `agentIds` added to the change key; `setSwarms` also notes overview agents. From `0c73edf72` (+ metadata in the same branch). | Yes: `cable_client.c:763-790` (`agentIds`, `members`), `ui_habitat.c:7052` -> `pod_ui_swarms`. | No. `CableSwarm` has no `agentIds`; `listSwarms` drops them (`cableHost.ts:437`) though `AppSwarms.swarms[].agentIds` already exists, and desktop already sends it. The change key counts only `agents`, so a reorder or move inside a tab is not re-sent. | **Yes**, gated on `swarms=members-v1`. `cable/cableSession.ts` (`CableSwarm.agentIds`, `swarmMembers`, `memberMeta`, `swarmsMessage`, key), `cable/cableHost.ts` (`listSwarms` keeps `agentIds`). Without the flag the frame must not change (the key may include ids only when the flag is on, so a round dial's push cadence is unchanged too). |
| **Long recap**: `deriveLongRecap`; `full` on `summary`; `fullText` in `recentSummaries`/`RecentTurn` for restore; `DeviceFleet` passes `fullText`. `0c73edf72`. | Yes: `cable_client.c:1197-1202` -> `ui_project_recap_full` -> `pod_ui_recap`. | Partly. The mirror already stores full text (`recapReads.ts` `RecentRecap.fullText`, `mirror.lastFullText`); the cable layer drops it. | **Yes**, gated on `recap=long-v1`. `lib/deviceRecap.ts` (`deriveLongRecap`, 1200/3600 limits), `cable/cableSession.ts` (`summary(..., fullText)`, restore loop, `CableHost.recentSummaries` type), `cable/cableHost.ts` (`RecentTurn.fullText`, `recentSummaries`), `device/deviceFleet.ts` (`fullText` in the recap cache), `cli.ts` (pass `mirror.lastFullText(...)` to `cable.summary`). |
| **Tool step**: `cableStepFor`, `turnStep`, step tee in `cli.ts`. `0c73edf72`. | Yes: `cable_client.c:1179` -> `ui_project_step`. | No. | **Yes**, gated on `activity=steps-v1`. `cable/cableHost.ts` (`cableStepFor`), `cable/cableSession.ts` (`turnStep`, drops the frame without the flag), `cable/cableFleet.ts` (`turnStep` fan-out), `cli.ts` (tee before `cableEventFor`). The branch sends `step` to every device ("older firmware ignores it"); on main it must not reach a round dial. |
| **Player activity**: `action` + `elapsedSeconds` on `turn.activity`; `terminalActivitySnapshot`; `activitySnapshot` host hook; `CommanderMirror.latestUpdate` and the `update` field on `processing`; `update` passthrough in `cableEventFor`, `FleetEvent`, `DeviceFleet`. `4051f87f4`. | Yes: `cable_client.c:1173-1177` -> `ui_project_player_activity` -> `pod_ui_turn("activity")` (`ui_habitat.c:5919-5940`). Inventory R3. | No. `terminalActivity` returns the footer text only. | **Yes**, gated on `activity=steps-v1`. `cable/terminalActivity.ts`, `cable/cableHost.ts` (`activitySnapshot`, `cableEventFor.update`), `cable/cableSession.ts` (`sendActivity`, `readActivity`, `turnStarted(..., update)`), `cable/machineFleet.ts` + `device/deviceFleet.ts` (carry `update`), `lib/commander.ts` (`playerUpdate`, `latestUpdate`, `update` on `processing`; `latestAction` is unused by the daemon wiring and can stay behind), `cli.ts` (`activitySnapshot` wiring). Check that `update` on the `commander_event` payload does not change what other consumers (WiFi device, desktop) receive; gate or strip it if it does. |
| **Player library**: `cable/playerLibrary.ts` (`playerPage`, `PLAYER_PAGE_SIZE=6`), `player.library.get`, `syncPlayerLibrary`, welcome feature `player.library`, `host.playerLibrary` (overview sessions, else the flat agent list). `4051f87f4`, `07ea2fd55`. | Yes: `cable_client.c:1281-1283` (`pro_player_library_parse`), request at `cable_client.c:204`; feature bit in `cable_features.c`. | No. `listAgentsFlat` exists. | **Yes**, gated on `player=library-v1`. New `cable/playerLibrary.ts`; `cable/cableSession.ts` (`player.library.get` case, `syncPlayerLibrary` in the tick and after restore, `player.library` in `features`, per-session resets); `cable/cableHost.ts` (`playerLibrary()` fallback only). |
| Player overview: `player.overview`, `player.context`, `syncPlayerOverview`, `AppSwarms.overview`, `appSwarmsFrom` overview parse in `localWsServer.ts`. `4051f87f4`. | **No.** `cable_client.c:1285-1316` parses them but `ui_player_context` has no Pod code and `pro_app_context` is a no-op (owner decision 4); `player.overview` is round-only (Pro ignores it). | No. | **No.** Not on the wire for the Pro, so nothing to port. The plan's Task 8 interface lists `player.context`; this document drops it because Pod does not read it. Add it later if a Pod view needs it. |
| Library from the desktop inventory: `overview.sessions` in `app_swarms`, `playerSessions` parse in `localWsServer.ts`, `status`/`lastActivityAt` per session. `07ea2fd55`. | Partly: Pod reads `status` and `ageSeconds` from each row (`pro_player_library_parse`), but any valid value works. | No. | **Open decision** (section 6). Not ported by default: the daemon fallback lists every agent the router knows with `status:"idle"`, `ageSeconds:-1`. |
| Creature voice: `creatureVoice.ts`, `creatureVoiceConfig.ts`, `CableHost.creatureVoice`. | No. It feeds `cableSpeech`, and the Pro drops `speech` from its hello. | No. | **No.** Speech synthesis for the round dial only. |
| Speech frames: `cableSpeech.ts`, `cableSession.speech`, `CableType.Speech = 0x05`, `speech.state`. | No (`CABLE_TYPE_SPEECH` and `speech.*` are in the inventory's ignored list). | No. | **No.** Also avoids the frame-type 0x05 clash noted in memory (Pro Player Studio). |
| Models menu: `models_menu_controller.dart` `validUntil`, `models_menu_test.dart`. | No. It only feeds `player.context` allowance. | No. | **No.** |
| Desktop Player overview: `AppNotifier.playerOverview`, `_schedulePlayerAnnouncement`, `overview` in `app_swarms`, `player_overview_test.dart`. | No (see overview and library rows). | No. | **No**, unless the open decision below is taken. |
| Desktop swarms announce test, `dial_swarms_announce_test.dart` and the `dialAnnouncementSenderForTest` hook. | No, test seam only. | No test. | **No** (see section 4). |
| `CableFleet.sessionForPort`, `Speech` wiring in `cli.ts` dock companion. `92283ad62`. | No. | No. | **No.** Unrelated prototype session hook. |
| `welcome.features` stays as on main plus `player.library` (only when `player=library-v1` and the host can list). | Yes: `cable_features.c` reads it; more than 16 entries, or a non-string entry, makes the firmware read 0. | No. | Part of the library row. Keep the list <= 16. |

### Where it landed on main

Main moved the devices into their own process (`services/devices.ts`), so the branch's `cli.ts` wiring became:
the step tee and `update` pass-through in `services/devices.ts` (`card`, `toDial`); the timer through a new optional
`core.agents.activitySnapshot` (`core/api.ts`, `core/main.ts`, `core/devicesLink.ts`, `services/devicesProcess.ts`;
the timer is parsed by `elapsedSecondsOf` in `lib/terminalActivity.ts`); `action` is the latest `update` seen on that
agent's processing card (cleared at the turn's end), not read from the core. The live `summary` gets `full` from
`recentSummaries(agentId)[0].fullText` when that turn's `text` equals the card's. Not ported: the branch's
`agents` key change (`total|`) and recording the swarms key only after a send, since neither is a Pro field and both
change a round dial's cadence.

### Port order (all in `cli/src/`)

1. `cable/cableSession.ts`: hello parse of `swarms`, `recap`, `activity`, `player`, `board` (new, main parses none today); reset on new port and on close.
2. The four features above, each behind its flag, with the specs in plan Task 8 step 2: a round hello (no capabilities) gets identical frames; Pro hello gets steps, full recap, members, a 6-row library.
3. `cli.ts` wiring.

## 4. Desktop

**No desktop change is required for Pod on main.**

- Main's `AppNotifier._announceOpenPanesToDial` already builds `swarmRows` with `'agentIds'` per swarm
  (`desktop/lib/state/app_state.dart`, in the `swarmRows` block, then `sendTerminalFrame('app_swarms', {...})`),
  and `AppSwarms.swarms[].agentIds` is already parsed by `appSwarmsFrom` in `localWsServer.ts`. The daemon only
  drops it in `listSwarms`. So tabs and members come from a daemon-only port.
- Reorder and move re-send: the announce runs from the layout-change path (`_announceOpenPanesToDial()` right after
  `_layoutRevision++`), and the branch's `dial_swarms_announce_test.dart` is a test of that existing path, not of a
  new change. The branch diff in `app_state.dart` touches the announce only to add `overview` and the test seam.
  What was missing was the daemon's change key (it hid a same-count reorder), which the daemon port fixes.
- The remaining desktop diff (`playerOverview`, `_schedulePlayerAnnouncement`, `models_menu_controller.dart`) feeds
  `player.overview`, `player.context` and the library's `sessions`; Pod reads none of the first two.
- Plan Step 4 says to add the desktop test only if desktop is touched; it is not.

## 5. Messages the Pro ignores (round-only)

The Pro counts these as unknown and does nothing (debug log only): `wifi.configure` (a Pro feature, decide
separately), every `speech.*` and the speech PCM frame (`0x05`), `models`, `notif.replace`, `notif.seen`,
`question.state`, `answer.receipt`, `draft.state`, `voice.draft`, `voice.question`, `voice.search`, `voice.form`,
`selection.state`, `carry.state`, `form.state`, `visit.state`, `metrics.state` (and `metrics.get`),
`player.overview`, `player.context` (parsed in the shared firmware but unused by Pod), `machine.selected`,
`machine.error`, `toast`, and the notification fields of `summary` (`silent`, `quiet`, `name`, `machine`).
The Pro does use: `welcome`, `ping`, `agents.*`, `agent.updated`, `machines.*`, `swarms`, `focus`,
`turn.started/activity/done/error`, `summary`, `question`, `question.close`, `player.library`, `voice.transcript`,
`voice.error`; and sends `hello`, `machines.list`, `agents.list`, `player.library.get`, `agent.open`, `scroll`,
`pong`, the voice stream and `voice.cancel`.

## 6. Open points

1. **Library status and age.** Without the desktop `overview.sessions` port, the host's rows are `status:"idle"` and
   `ageSeconds:-1` for every session. The cable session overrides `status` with what it has seen itself: `working`
   from `turn.started` (or a step, or a live footer) until `turn.done`, `turn.error` or a non-silent `summary`, and
   `question` from `question` until `question.close` (then `working` again). Without that, the page the daemon resends
   every 10 s put a working agent to `idle` on the Pro until its next event (2026-10-11). The age is still unknown.
   Porting the rest means `desktop/lib/state/app_state.dart` (`playerOverview`), `localWsServer.ts` (`playerSessions`) and
   `AppSwarms.overview`. Owner call.
2. **`player.context` in the plan.** Plan Task 8 lists it as produced; Pod does not read it. Not ported here.
3. **`update` on `processing`.** It rides the shared `commander_event`; confirm no other consumer of the card
   changes behavior before porting `latestUpdate` (see the Player activity row).

Firmware offers: a hello with `board:"pro"` gets no `fw.offer` (no manifest lookup, no transfer) until the Pro has its own OTA channel; a hello without `board` is offered as before.

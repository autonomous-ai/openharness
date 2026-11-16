# Harness Device: the agent tells the dial when it needs you

Status: approved (Ken, 2026-11-16). Branch `feat/dial-agent-notify`. Checked against main at 5840f0786f (after #4340, #4366).

## What and why

Dee wants the dial to notify the way the Swarm's PM did: smart, in the agent's own words, only when the person has to
do something. In the Swarm the PM itself decided and wrote "@Ken ..." when it needed him; nothing guessed from outside.
Today the dial beeps for every finished turn (`cli/src/lib/notifyTier.ts`, `rule:turn`) and for questions and
permission asks, and it cannot know that an agent's answer says "connect the VPN so I can run the staging tests".

So the agent that needs the person says so to the dial itself. Claude Code and Codex, running outside Harness in Orca or
any terminal (the dial-without-the-app path, #4289, #4296, #4334), learn that the person has a dial and get one command
to reach it. The person chooses in the Harness Device menu-bar app (`device-app/`) whether ordinary turn ends still
beep.

Done when, on a Mac with a dial and no Harness desktop app:
1. A Claude Code or Codex session that needs the person (information, an action outside its reach such as a VPN, a
   sign-in or a cable, a decision) runs `harness device notify "<one line>"`, and the dial beeps, wakes and shows that
   line with the agent's name, pinned like a question.
2. The menu has Notifications: All / Needs you. In Needs you an ordinary finished turn is a drawer row with no beep and
   no wake; in All it beeps as today. Questions, permission asks, failed turns and agent notices beep in both.

## Goals, non-goals, anti-goals

- Goal: the ring comes from the agent's own judgment and its own words, as the Swarm PM's did.
- Goal: Claude Code and Codex in v1.
- Non-goal: Desktop, the phone, the website and the Orca plugin change nothing. No setting in Desktop.
- Non-goal: no firmware change. The dial already pins, wakes and beeps for a question card and obeys a summary's
  `tier` (`devices/harness-device/firmware/main/cable_client.c`).
- Non-goal: no model of Harness's decides anything (Jev was taken out of notifications on 2026-11-02 at Diego's
  request: `docs/superpowers/specs/2026-11-02-device-notify-no-jev-design.md`). No watcher agent either: the agent
  that needs the person is the one that says so.
- Anti-goal: an agent that rings for "done" or for every step. The skill says plainly: only when the person must act;
  a finished task is not a notice. The daemon bounds it (Limits).
- Anti-goal: a second permission prompt to the person just to send the notice.
- Anti-goal: the notice carrying a secret or a long transcript onto a screen anyone near the desk can read.

## Approaches

- **A. A skill plus a CLI command, installed by the existing enable paths (chosen).** The Claude Code plugin
  (`plugins/harness-device/`) gains a skill; Codex gets the same skill in its skills folder. The skill's description is
  always in the agent's context, so the agent knows a dial is there; its body says when and how to call
  `harness device notify`. Cost: the agent's judgment decides, so a badly behaved agent can over- or under-notify;
  the daemon's bounds cap the first, the skill's wording the second.
- B. An MCP tool instead of the CLI command. Same judgment, a typed tool, but a second process per session and a new
  install surface for both engines; the plugin today has only hooks, and the dial path already calls the `harness` CLI.
  Dropped for v1.
- C. Claude Code's own `Notification` hook. It fires with fixed text ("Claude is waiting for your input"), not what is
  needed; Codex has no equivalent. Dropped.
- Dropped earlier in the discussion: a model of Harness's reading every answer (Jev), and a PM-like watcher agent
  woken on every turn (Hachi-style): both judge from outside and cost a model call or the person's tokens per turn.

## What rings

| Event | All | Needs you |
|---|---|---|
| `harness device notify` from an agent (new) | rings, pinned, its line | rings, pinned, its line |
| A question or a permission ask | rings (today) | rings |
| A failed turn (`turn.error`, which includes Codex's usage limit) | rings (today) | rings |
| An ordinary finished turn with a recap | rings (today) | drawer row (`list`), no beep, no wake |
| On screen, a sub-agent, an empty turn | silent (today) | silent |

Default: **All**, so nobody's dial changes until they choose (my call).

## The how (decided)

### The command: `harness device notify "<text>" [--json]`

- Run by the agent, from its own session. The daemon on this computer finds which agent it is from the caller, as the
  device path already does for outside sessions (Claude Code's session id from the plugin's hook environment, Codex's
  thread id `CODEX_THREAD_ID`); when it cannot tell, the notice still goes, under the session's folder name or "An agent".
- Text: one line, at most 120 characters after trimming; control characters and line breaks removed; longer is cut
  with an ellipsis. It is drawn as the agent wrote it.
- Answer (exit 0): `shown` (a dial took it), `no dial` (none attached: the agent says it in its chat as it normally
  would), or `limited` (Limits). The skill tells the agent to say the same thing in its own answer either way, so the
  person sees it at the screen too.
- On the dial it is a question-style card: pinned, wakes, beeps (coalesced as today), the agent's name and machine,
  the line whole, and one option, "In <app>". No " · answer in <app>" suffix: the question line is cut at 99 bytes, and
  the agent's line needs them. It goes away when that agent's next turn starts or the person taps "In <app>" to open
  the agent in its app; opening the alert to read it does not close it.
- The command reaches the devices' own listener, not the core: no request name is added to `cli/src/core/api.ts`.
  Known gap: where that listener does not run (Windows, and a daemon that runs its services inside the core, as on
  Harness OS), the command answers `no dial`.

### The skill (Claude Code and Codex, one text)

- Name `dial`; description: "The person has a Harness dial on their desk. Use it when you need them to do something
  you cannot: give information, act outside your reach (connect a VPN, sign in, plug in a device), or decide."
- Body, a few lines: call `harness device notify "<what you need, in one line>"`; never for progress or "done"; at
  most once for the same need; never put a secret, a token or a file's content in the line; still write the full ask
  in your answer.

### Install

- Claude Code: `harness device claude enable` already installs the plugin; the plugin now carries the skill.
  `disable` removes it with the rest. The plugin's hook is unchanged: it still decides nothing
  (`deviceClaude/asked.ts`, the README's "It never answers a prompt").
- Codex: a new `harness device codex enable|disable|status`, as the Claude one: writes the skill to
  `$CODEX_HOME/skills/dial/SKILL.md` (`~/.codex` by default), the Codex home the person's Codex reads, and removes it.
  Checked against Codex 0.167.1. The Harness Device app offers it once, as it offers Claude Code (consent
  first), and the menu shows Codex: On / Turn off as it does Claude Code.

### No approval prompt: the one existing allow-list (my call, from the builder check)

Harness already writes, at every daemon start, the rules that let its agent commands run without a permission
question and outside Codex's sandbox (`HarnessAllowance`, `cli/src/engines/facets/hooks.ts`): `Bash(harness <verb>:*)`
in Claude Code's `permissions.allow`, and `~/.codex/rules/harness.rules` with `prefix_rule(..., decision="allow")` for
Codex. `harness device notify` joins that list as one exact three-word rule (Claude Code: `Bash(harness device
notify:*)` and the launcher's full-path spelling; Codex: `prefix_rule(pattern=["harness","device","notify"], ...)`),
never the whole `device` verb, so `harness device claude enable` and the rest still ask. The list's existing guards
hold: a person's own deny or ask rule for the command keeps it out.

- Why this and not a decision from the plugin's hook or a second Codex rule: one way to do a thing (code standard 1),
  and the hook keeps its "decides nothing" guarantee.
- Shell safety: Codex's prefix rule matches argv, so text after `notify` is one argument. Claude Code's prefix rule
  does not cover a compound command (`;`, `&&`, `$(...)`, backticks): those still ask. Unit tests pin the exact rule
  text; no test here can run the engines' own matchers, so a compound command is tried by hand in each engine, with
  the real-engine check.
- The rule is written for everyone running the daemon, dial or not; with no dial the command answers `no dial` and
  does nothing else.

## Which agents it covers (my call, from the builder check)

| Agent | `harness device notify` | Needs you lowers its turn ends |
|---|---|---|
| Claude Code or Codex outside Harness on this computer (Orca, terminals) | yes, tied to its observed session | yes |
| A Harness pane agent on this computer (it reads the same `~/.claude` / `~/.codex`, so it sees the skill) | yes, tied by its Harness agent id, as `harness whoami` resolves it | yes |
| An agent on another of the person's machines that this dial shows | v1: answers `no dial` on its own machine unless that machine has a dial; named as a known gap | yes, on this computer's dial |

The setting is about this dial, so it lowers every ordinary turn end the dial shows, whichever path the card came by
(`services/devices.ts`: the upstream-tier path, the `tierOf` path and the fleet path). A remote agent's need still
rings when it is a question or a failed turn. Relaying notices between machines is a later item, not v1.

A notice rings whether or not the Harness desktop window is open: it is the agent's own ask, so it takes its own path
past the `heldOnTab()` gate (`services/devices.ts`, since #4340: a window open on its tab, or an app's ring no
connected dial shows) that holds outside agents' turn cards today (my call).

Outside agents now come from more than one source (`outsideEntries()`: the observed source and, since #4366, herdr's
source). A notice from an agent herdr lists is tied the same way as an observed one, through the entry the registry
holds for it; Needs you lowers herdr agents' turn ends like any other.

## Release order (my call, from the builder check)

`harness device claude enable` installs the plugin from this repository's main branch, so a plugin change reaches
people on their next plugin update, before any CLI release.

1. This branch: the CLI (`harness device notify`, the allow-list rule, `harness device codex`, the setting and the
   watch lines), the menu-bar app and the Codex skill. The plugin's skill is **not** in it.
2. After a CLI release carries `harness device notify`: a small second pull request adds the skill to
   `plugins/harness-device/`. People who already turned the plugin on get it with no new offer: they agreed to the
   dial reaching Claude Code, and this is the same reach the other way; the plugin's README says what it adds.
   Replaced by [the dial skill design](2026-11-16-dial-skill-every-home-design.md); #4386 was closed.

The Codex skill is written by `harness device codex enable`, which ships with the CLI that has the command, so it
needs no such wait.

### The setting: Notifications, All or Needs you

- Stored per computer in the daemon's data dir, read by the devices service where it sends `cable.summary`
  (`services/devices.ts`, both the upstream-tier and the `tierOf` paths): in Needs you an `alert` decided by
  `rule:turn` becomes `list`, logged as `rule:needs-you`; nothing else is lowered.
- The menu-bar app reads and writes it through `harness hardware watch --json`, as its Sound item does (#4360): out,
  `"notify":"full"|"you"` on the watch line; in, exactly `{"notify":"full"}` or `{"notify":"you"}` on the watch's
  stdin; latest wins, one change in flight, 12 s bound, one stderr line on an error.
- Menu: a **Notifications** submenu, **All** and **Needs you**, the one in force checked; shown while a dial is
  attached and not updating and the watch's line carries `notify`, absent otherwise (unlike Sound, it does not wait
  for the dial to report its settings: the setting is this computer's); the check follows what the watch reports.
- The setting and the notice are local to this computer: neither is relayed to other machines, the phone or the
  backend, and neither is a dial setting (`harness_device_settings` stays the dial's own).

## Limits

- Per agent: one notice a minute; the same text again within 10 minutes is dropped (answer `limited`).
- Per computer: 20 notices an hour. Over it: `limited`, and one log line.
- A notice for an agent the dial already shows a pending card for replaces that card, never stacks.

## Security and data

- The line is outside text (the agent may have read it from a web page or a pull request): it is data, drawn as text,
  never interpreted; trimmed and capped as above. No new data is stored beyond the setting's one value. Nothing leaves
  the computer: the command talks to this computer's daemon, which talks to the attached dial.
- Logs say `notify · <engine> · shown|no dial|limited`, never the text.
- The allow rule covers exactly `harness device notify`, so it cannot be used to approve another command.

## Constraints

- device-app rules hold (`device-app/AGENTS.md`): thin over the CLI, fixed arguments and stdin lines, one redacted
  log, no path of another component in a string.
- The core gains nothing: the notice and the setting go through the devices' own listener, and no name is added to
  `cli/src/core/api.ts`. The allow-list rule is one more line in the engine contracts the core already loads.
- Copy (docs/naming-system.md): "Notifications", "All", "Needs you"; the dial card's footer as the permission cards'.
- Platforms: macOS for the app (Linux built in CI); the CLI and skill wherever the dial path runs (macOS, Linux).

## Left to the builder

- How the daemon ties a `harness device notify` call to the session, for each engine, and what it shows when it
  cannot.
- The request names and the stored file's name.
- How the fleet path's cards are lowered in Needs you without changing what the remote machine decided for its own
  dial.

## Tests (red first)

- CLI: `notify` text trimming and caps; `shown` / `no dial` / `limited`; the limits; the card frame sent to a fake dial;
  the tier in each mode; the watch's `notify` line out and in; the setting survives a daemon restart.
- Allow-list: the Claude Code and Codex rules for exactly `harness device notify` are written; `harness device claude
  enable` is not covered; a person's deny rule keeps it out; the rule text is pinned exactly. A compound command after `notify` still asking
  is tried by hand in each engine (below).
- Codex enable/disable: writes and removes exactly the skill; status reads it.
- Coverage: a pane agent's and an outside session's notice each name the right agent; a fleet card is lowered in
  Needs you; a notice rings with the desktop window open.
- App `cargo test --lib`: the submenu's states, the click's fixed stdin line.
- By hand, on a Mac with a dial and no Harness desktop app: a Claude Code and a Codex session each asked to do work that
  needs a VPN ring the dial with their own line and no approval prompt; Needs you keeps an ordinary turn silent; All
  beeps it.

## What the person sees

The dial, when an agent needs the person (both modes):

```
 Claude Code in Orca, working on "Fix login":
   "The staging tests need the VPN, and I cannot connect it."
        │  harness device notify "Connect the VPN so I can run the staging tests"
        ▼
      ╭────────────────────╮
      │ ! Fix login · Mac  │   beep, wake,
      │                    │   pinned on top
      │ Connect the VPN so │
      │ I can run the ...  │
      │      In Orca       │
      ╰────────────────────╯
```

The card goes when that agent's next turn starts or the person taps "In Orca" to open the agent.

An ordinary finished turn:

```
 All                               Needs you
 ╭────────────────────╮            ╭────────────────────╮
 │ ✓ Fix login        │  beep      │                    │  no beep, no wake,
 │ Done: tests pass,  │  wake      │     (dark)         │  one drawer row
 │ 2 commits          │            │              • 1   │
 ╰────────────────────╯            ╰────────────────────╯
```

The menu-bar app:

```
┌───────────────────────────────┐
│ Dial: Connected               │
│ Claude Code: On               │
│   Turn off                    │
│ Codex: On                     │  (new)
│   Turn off                    │
│ ✓ Sound                       │
│   Notifications             ▸ ├──┬──────────────┐
│ ───────────────────────────── │  │ ✓ All        │
│   Sign in…                    │  │   Needs you  │
│   Quit                        │  └──────────────┘
└───────────────────────────────┘
```

The one-time Codex offer, when Codex is on this computer (as the Claude Code offer):

```
╭──────────────────────────────────────────╮
│ Let Codex reach your dial?               │
│ Codex can ring the dial when it needs    │
│ you: a VPN, a sign-in, a decision.       │
│               [ Not now ]  [ Turn on ]   │
╰──────────────────────────────────────────╯
```

## Flows

An agent learns of the dial and rings it:

```
harness device claude enable / codex enable   (the app asks once)
   │  installs the "dial" skill (the notify rule is in Harness's allow-list)
   ▼
Claude Code / Codex reads the skill's description: "the person has a dial"
   ▼
the agent needs the person (VPN, a key, A or B)
   │  harness device notify "<one line>"
   ▼
this computer's daemon
   ├─ one line, 120 characters at most, control characters removed
   ├─ limits: 1 a minute per agent, same text within 10 min dropped, 20 an hour
   ├─ no dial        ─▶ "no dial"  (the agent says it in its chat only)
   ├─ over a limit   ─▶ "limited"
   └─ dial attached  ─▶ card to the dial ─▶ "shown"
   ▼
the agent also writes the whole ask in its answer, for the person at the screen
```

A turn ends:

```
the agent finishes a turn
   ▼
the daemon decides its tier by today's rules
   ▼
Needs you, and the tier came from rule:turn?
   ├─ yes ─▶ list: one drawer row, no beep
   └─ no  ─▶ unchanged (questions, permission asks, errors always ring)
```

The setting changes:

```
click "Needs you" ─▶ {"notify":"you"} ─▶ harness hardware watch
   ─▶ the daemon stores "you" (this computer only)
   ─▶ the watch prints {"notify":"you"} ─▶ the menu moves its check
```

## Docs in the same PR

- `plugins/harness-device/README.md` changes in the second pull request (Release order), with the skill.
- `docs/plans/2026-11-13-device-menubar-design.md`, the menu table: Notifications.
- `docs/cli.md`: `harness device notify` and `harness device codex`.

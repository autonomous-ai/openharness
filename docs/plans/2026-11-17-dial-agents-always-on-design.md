# Harness Device: Claude Code and Codex reach the dial with no setting

## Why

The menu-bar app has a row per agent with Turn on / Turn off (#4389). On 2026-11-17 the Codex row vanished on Ken's
Mac (the app's bare PATH could not find `codex`), and a person had to find and press Turn on twice before the dial
could ring for them. A person who plugs in a dial wants their agents to reach it; there is no choice to make.

## What the person gets (Ken, 2026-11-17)

- Plug in the dial: Claude Code and Codex on this computer can ring it, with nothing to press.
- An agent installed later is set up as soon as Harness sees it, without a restart; its sessions already running get
  the skill as they do today (Codex at once; Claude Code when its `skills/` folder existed at its start).
- The menu has no Claude Code or Codex rows.
- Set up once per computer: what the person removes themselves stays removed (decision b).

## Goals, non-goals, anti-goals

- Goal: no menu row, popup or click for Claude Code or Codex.
- Goal: an agent installed after the dial is set up at Harness's next scan.
- Goal: removal is respected: a plugin uninstalled through Claude Code's `/plugin`, or a dial skill deleted from a
  Codex home, is never put back by Harness.
- Non-goal: other agents (OpenCode and the rest); Windows (the dial answers "no dial" there today).
- Non-goal: changing the skill text, `harness device notify`, the Notifications or Sound items, or the core.
- Anti-goal: Harness fighting the person: re-adding what they removed, or nagging.
- Anti-goal: writing into an agent's home on a computer that never had a dial.

## Approaches

1. **Set up once, automatically; removal respected (chosen, Ken: "b").**
2. Always on: every scan re-adds the plugin and the skill. Simplest, but a person who removes it can never say no,
   with no switch left in the menu.
3. Keep the menu rows (the previous plan, `fix/device-menu-agent-rows`, dropped): still a click per agent.

## Decided

- **When:** the devices service (its own process, not the core) sets the agents up from the first time a dial attaches
  on this computer, and on every scan after, whether or not a dial is attached then. A computer that never had a dial
  gets nothing (anti-goal).
- **Codex:** each Codex home the service knows (default `~/.codex`, adopted homes, homes from the rollout scan, as
  #4389) gets the dial skill once. The service records each home it wrote; a recorded home whose skill is gone was
  cleared by the person and is left alone. A new home is written at the next scan. No `codex` command is needed:
  the skill is a file.
- **Claude Code:** when `claude` is found (by the daemon's own engine lookup, never the app's PATH) and the plugin has
  not been set up on this computer before, the service installs and enables `harness-device@openharness` the way
  `harness device claude enable` does today, then the skill follows as today. It records that it did; a plugin the
  person later uninstalls is not installed again, and its skill goes as today (the plugin off takes the skill away).
- **Kept current (Ken, 2026-11-17):** while the person has not removed it, each scan keeps what Harness set up up to
  date: a Codex skill Harness wrote whose bytes differ from this CLI's `DIAL_SKILL` is rewritten (as #4389 does for
  its own file), and the Claude Code plugin is updated to the version this CLI ships when the installed one is older.
  What the person removed is never updated back in.
- **Failures** (no network for the plugin install, a home not writable): logged with a name and the reason, retried
  at later scans with a bound (my call: at most once an hour per agent), never shown as a popup.
- **The commands stay** as the way back: `harness device claude enable|disable` and `harness device codex
  enable|disable`. `enable` sets up again what the person removed; `disable` removes it and records the removal, so
  automatic setup leaves it alone.
- **Existing answers (Ken, 2026-11-17):** the old menu's answers in `dial-skill.json` are dropped, not migrated: the
  menu with Turn off shipped only in Device 0.1.1 on 2026-11-17, so nobody's choice is lost and no migration branch is
  kept. Only a removal recorded by the new code (a `/plugin` uninstall seen, a deleted skill, `disable`) is respected.
- **Measured (Ken, 2026-11-17):** the devices service's daily tally counts, with no content or identifiers:
  `harness device notify` results (`shown`, `no dial`, `limited`) per engine, and automatic setups per engine
  (`set up`, `updated`, `failed`, `left removed`).
- **Plan answers (orchestrator for Ken, 2026-11-17):**
  - *When, exactly:* setup runs at the devices service's start (once a dial has attached on this computer), at each
    attach, and at each scan while a dial is attached. With the dial unplugged nothing runs until the next attach, which
    sets up at once. No new timer on an idle daemon.
  - *Plugin kept current:* the plugin carries no version and the CLI ships none, so once after each CLI update the
    service runs `claude plugin marketplace update openharness` then `claude plugin update
    harness-device@openharness --scope user`, and records the CLI version it did it for.
  - *The skill's marker line:* the old line points at a switch that is gone. The new one is
    `# Written by Harness. Remove it with harness device claude disable or harness device codex disable.` Harness knows
    its own file by one rule: a line starting with `# Written by Harness.` (so files 0.6.58 wrote are still its own,
    and the kept-current pass rewrites them with the new line). No list of markers.
  - *Notify tally:* counts only what the devices service answers itself.
  - *A Claude Code skill file deleted by hand while the plugin stays on:* the same rule as Codex: left alone until
    `harness device claude enable`.
  - *`harness device claude|codex status` stays*, so Device 0.1.1's rows keep working until that app updates.
- **The menu-bar app:** the Claude Code and Codex rows, their Turning on/off and error rows, and the app's calls to
  `device claude|codex status|enable|disable` go. Dial, Signed in, Sound, Notifications, Open Harness and Quit stay.

## The menu

```
┌───────────────────────────────┐
│ Dial connected · 0.1.0        │
│ Signed in                     │
│ ✓ Sound                       │
│   Notifications             ▸ │
│ ───────────────────────────── │
│   Open Harness                │
│   Quit                        │
└───────────────────────────────┘
```

## Flow

```
a dial attaches (first time on this computer: setup begins) ─┐
every scan of the devices service ───────────────────────────┤
                                                              ▼
Codex homes known ──▶ each new home: write the skill, record it
                      a recorded home with no skill: leave it (the person removed it)
claude found? ── no ──▶ nothing; asked again next scan
   │ yes
   ▼
plugin set up here before? ── yes ──▶ nothing (on, or removed by the person)
   │ no
   ▼
install + enable the plugin (as `device claude enable`) ──▶ record ──▶ skill written as today
   └─ failed ──▶ log; retry at a later scan, at most once an hour
```

## What changes

- CLI devices service (`cli/src/devices/`, `cli/src/services/devices.ts`): the setup above at attach and each scan;
  the records next to `dial-skill.json`.
- CLI commands (`cli/src/deviceClaude/command.ts`): `disable` records the removal; `enable` clears it.
- device-app (`model.rs`, `app.rs`, whatever polls the engines' status): the rows and their calls removed, with
  their tests. The Harness Device menu sketch in `desktop/design/desktop-design-system.md` changes in the same PR.
- Data: a per-computer record of what was set up and what the person removed (Design section in the plan, per
  docs/feature-design-rules.md). Nothing leaves the computer.

## Tests

- Red then green, CLI: first attach sets up Codex homes and runs the plugin install (fake `claude`); a home whose
  skill was deleted is not rewritten; a new home is; `claude` appearing later is set up at the next scan; an
  uninstalled plugin is not reinstalled; `disable` then a scan does nothing; `enable` after a removal sets it up; a
  computer that never had a dial gets nothing; a failed install retries no sooner than an hour.
- Red then green, app: the menu has no agent rows in any state.
- By hand on this Mac (Ken): a fresh Codex home and Claude Code get the skill with no click; removing the plugin with
  `/plugin` keeps it removed after a scan.

## Platforms

macOS (the dial app). The devices service runs the same on Linux; Windows writes nothing, as today.

## Release

CLI and Harness Device app, only when Ken says.

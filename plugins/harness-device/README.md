# Harness Device plugin for Claude Code and Codex

Shows Claude Code's and Codex's waiting prompts on the Harness round dial (a permission ask, a question form and, in
Claude Code, a plan approval), with the agent running in Orca, Ghostty or any terminal on this computer. In Claude Code
it also takes a prompt said at the dial.

## What it does

When Claude Code is about to ask the person to allow a tool call, its `PermissionRequest` hook (`hooks/asked`) tells
the Harness daemon on this computer, and decides nothing. While a dial is attached, the dial shows the agent waiting,
with one line of what it asks: "npm test · answer in Orca". A question form shows its first question (else its header,
else "A question"), and a plan approval the words "Plan ready to approve". Answer the prompt where it is, in the
terminal or the app; the line goes once the agent goes on.

Voice: a prompt said at the dial goes to the session as yours, idle or working. The plugin's mod (`hooks/device.js`)
keeps one request open to the daemon, and the prompt comes back as its answer; Claude Code starts it once its turn is
over. Nothing is kept for later.

The mod also tells the daemon which session the Claude app shows, and the dial turns to it while the app is in front.

On Windows, where a mod reaches no named pipe, the mod runs the Harness CLI instead
(`%USERPROFILE%\.harness\bin\harness.exe`, else `harness` on `PATH`): one `harness device claude inbox` per session
holds that request, and `harness device claude attach` tells which session the app shows. The CLI proves Harness's
tokens in its own process, and the mod is handed no token or other credential. A waiting prompt is the mod's to tell
there too, through `harness device claude asked`: it hears the prompt before the hook, and sets
`HARNESS_DEVICE_MOD_ASKS` for it, so the hook runs nothing.

With no dial attached, no Harness daemon running, or no Harness CLI (`~/.local/bin/harness`, on Windows
`%USERPROFILE%\.harness\bin\harness.exe`, then `harness` on `PATH`), the hook tells nothing, and Claude Code carries
on as it would without the plugin. On Windows Claude Code still starts the hook, in Git Bash, or in PowerShell when
there is none, and the prompt shows once it ends: about 0.5-1 s later in Git Bash, 2-3.5 s in PowerShell (measured on a Windows 11 ARM64 VM). The dial shows
the prompt as soon as the mod has told it. Where an organization manages Claude Code, its hooks pass over the mod: the
hook tells, and a PowerShell slower than the hook's 5 s rings nothing at the dial for that prompt, which still waits in
the session. There, on a busy machine, the prompt can show up to about 4 s later: on Windows `asked` waits up to 4 s
for the daemon (its process check up to 3 s, then 1 s for the post).

## Codex

The same folder is a Codex plugin too (`.codex-plugin/plugin.json`, Codex 0.172.0 or later). Its hooks are in
`hooks/codex.json`: `PermissionRequest`, on every tool, and `PreToolUse`, on `request_user_input`. Both run
`harness device codex asked` (off Windows through `hooks/codex-asked`), which tells the daemon and decides nothing.
Claude Code's `hooks/hooks.json` and its mod stay Claude Code's.

Codex runs these hooks before its own automatic review, and their input does not say whether the person is asked. So
the command reads the turn's setting from the session's rollout (`transcript_path` in the hook's input): backwards from
its end, at most 16 MiB, the `turn_context` line of the hook's turn, and of it only `approvals_reviewer` and
`collaboration_mode.mode`. It reads only a regular file inside the session's Codex home. A permission ask is told when
the reviewer is `user`, a question when the mode is `plan`. Anything else, a file it may not read, or no such line
within the bound tells nothing. Nothing of the rollout is kept or sent.

The dial's line: for `Bash`, the command's first line; for `apply_patch`, the first file it adds, updates or deletes;
for `request_user_input`, its first question; for any other tool, the tool's name. In a Harness pane, Harness hears the
wait itself, and this one is dropped.

On Windows Codex runs these hooks before its dialog shows, so on a busy machine the dialog can open up to about 4 s
later while `asked` waits for the daemon (see above).

Missed on purpose:

- A command the automatic review hands to the person, and a question in Default mode with Codex's
  `default_mode_request_user_input` on: both ring nothing, as before; a ring at every command the review approves would
  be worse.
- A hook input over 256 KiB, such as a large `apply_patch`: the command reads no further and tells nothing.
- Codex's own app tools (`mcp__codex_apps__…`): Codex takes their reviewer from `[apps]` in `config.toml`, over the
  turn's, so the rollout cannot say who reviews them, and they ring nothing.
- An organization's managed requirements for automatic review (`requirements.toml`): the command does not read them and
  goes by the turn's own setting.
- A `request_user_input` Codex refuses with no form (questions that do not parse, none, or one without options): it
  rings nothing.
- The same ask again: Codex checks a "don't ask again this session" approval after the hook has run, so the dial rings
  only the first ask of a session for the same tool and line, until the session ends. After a plain "Yes", the very
  same command asked again in that session is not rung again. After the Harness devices process restarts, a command
  approved for the session can ring once more.
- Codex waits for the hook before it shows its prompt: about 0.25 s on macOS and 0.5-1.5 s on Windows, where Codex runs
  it through Windows PowerShell. Codex can run a hook in the background (`"async": true`), but then its word can reach
  the dial after the person has answered, and the dial rings for an ask already answered: on Windows, in 4 of 5 turns
  that ended right after the command (#4668). So the hooks stay in the foreground.

## At session start

When a session starts, resumes, is cleared or compacts, the plugin adds this one line to its context:

> The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, run
> `harness device notify "[the ask]" --suggest "[your pick]" --waiting` (or `--proceeding` when you go on). Not for
> finished work or progress. The dial skill has the rest.

In Claude Code it comes from the `SessionStart` hook in `hooks/hooks.json` (`hooks/start`), in Codex from the one in
`hooks/codex.json` (`hooks/codex-start`), which Harness trusts as the plugin's other hooks. Each runs
`harness device claude start` or `harness device codex start`, which prints the line only while Harness's own dial
skill is in that session's home, the plugin is on, `disable` has not removed that engine, and the session's folder is
outside Harness's data folder, where Harness's own one-shots run. It reads no daemon and no network, and decides
nothing. Anything else the launcher prints is dropped. `harness device claude disable` and `harness device codex disable`
take the line away.

## What it never does

- It never answers a prompt: the dial approves nothing, and each prompt is answered in its own app.
- Nothing leaves the computer: the hook and the mod talk only to the daemon on it, and the dial attached to it. The
  dial sees the tool's name and one line: what a permission ask acts on (a command, a file, a site's host, an MCP
  server and tool), the first question for a form, fixed words for a plan approval, whose plan never leaves the hook.
  The rest stays in the hook. The mod sends only the session's id.
- It adds no other text to a session than that one line.

## Install and remove

With a dial plugged in, Harness installs it by itself, once, and keeps it current; removed (with `/plugin` or below), it
stays removed.
`harness device claude enable` installs and turns it on again. To remove it:

```
harness device claude disable
```

It takes effect at once, also in a session already running: the hook and the mod check Claude Code's settings and
Harness's removal before they act, so the dial shows no more prompts and nothing said at it reaches the session.

Codex: with a dial plugged in, Harness sets the plugin up in each Codex home it serves, through Codex's own
`codex plugin`, from `claude-marketplace` in Harness's data folder, which holds the copy this CLI carries. It adds that
folder as the `openharness` marketplace and brings the plugin current after each CLI update. Turned off in Codex, it
stays off. Removed, it stays removed while Harness's record of that home (`dial-setup.json` in Harness's data folder)
holds; an older CLI that rewrites that file drops the record, and the next pass sets the plugin up again.

Codex asks a person to review a plugin's hooks before they first run. Harness writes the records Codex writes on
"Trust" into the home's `config.toml`, only when the installed folder is the copy this CLI carries, and checks that
again at each dial setup pass. A folder that differs, such as one edited by hand, gets no trust from Harness: Codex asks
the person to review it, and Harness logs `untrusted · differs` once.

A Codex home whose `openharness` marketplace is the person's own (added from GitHub, as
[the harness plugin](../harness/README.md) shows, or from anywhere else) gets nothing from Harness, so its Codex waits
outside a pane do not reach the dial.

`harness device codex enable` sets the plugin up again, and `harness device codex disable` removes it where Harness set
it up; the marketplace stays, as Claude Code's plugin comes from it too. A session already running still runs the hook
after `disable`, which then tells nothing.

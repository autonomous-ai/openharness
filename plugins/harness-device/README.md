# Harness Device plugin for Claude Code

Shows Claude Code's waiting permission prompts on the Harness round dial, and takes a prompt said at the dial, with
Claude Code running in Orca, Ghostty or any terminal on this computer.

## What it does

When Claude Code is about to ask the person to allow a tool call, its `PermissionRequest` hook (`hooks/asked`) tells
the Harness daemon on this computer, and decides nothing. While a dial is attached, the dial shows the agent waiting,
with one line of what it asks: "npm test · answer in Orca". Answer the prompt where it is, in the terminal or the app;
the line goes once the agent goes on.

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
there is none, and the prompt shows once it ends: about 1-2 s later in Git Bash, 3-5 s in PowerShell. The dial shows
the prompt as soon as the mod has told it. Where an organization manages Claude Code, its hooks pass over the mod: the
hook tells, and a PowerShell slower than the hook's 5 s rings nothing at the dial for that prompt, which still waits in
the session.

## What it never does

- It never answers a prompt: the dial approves nothing, and each prompt is answered in its own app.
- Nothing leaves the computer: the hook and the mod talk only to the daemon on it, and the dial attached to it. The
  dial sees the tool's name and one line of its input; the rest stays in the hook. The mod sends only the session's id.

## Install and remove

With a dial plugged in, Harness installs it by itself, once, and keeps it current; removed (with `/plugin` or below), it
stays removed.
`harness device claude enable` installs and turns it on again. To remove it:

```
harness device claude disable
```

It takes effect at once, also in a session already running: the hook and the mod check Claude Code's settings and
Harness's removal before they act, so the dial shows no more prompts and nothing said at it reaches the session.

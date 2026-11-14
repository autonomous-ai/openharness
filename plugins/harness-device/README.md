# Harness Device plugin for Claude Code

Shows Claude Code's waiting permission prompts on the Harness round dial, and takes a prompt said at the dial, with
Claude Code running in Orca, Ghostty or any terminal on this computer.

## What it does

When Claude Code is about to ask the person to allow a tool call, its `PermissionRequest` hook (`hooks/asked`) tells
the Harness daemon on this computer, and decides nothing. While a dial is attached, the dial shows the agent waiting,
with one line of what it asks: "npm test · answer in Orca". Answer the prompt where it is, in the terminal or the app;
the line goes once the agent goes on.

Voice: a prompt said at the dial is typed into an idle session as yours, never into a running turn. The plugin's mod
(`hooks/device.js`) keeps one request open to the daemon, and the prompt comes back as its answer. While the session is
working or waiting on you, the dial says it is busy and nothing is kept for later.

With no dial attached, no Harness daemon running, or no Harness CLI (`~/.local/bin/harness`, then `harness` on
`PATH`), the hook tells nothing, and Claude Code carries on as it would without the plugin.

## What it never does

- It never answers a prompt: the dial approves nothing, and each prompt is answered in its own app.
- Nothing leaves the computer: the hook and the mod talk only to the daemon on it, and the dial attached to it. The
  dial sees the tool's name and one line of its input; the rest stays in the hook. The mod sends only the session's id.

## Install and remove

`harness device claude enable` installs and turns it on. To remove it:

```
harness device claude disable
```

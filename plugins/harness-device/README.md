# Harness Device plugin for Claude Code

Lets a person allow or deny Claude Code's permission prompts, and say a prompt, from the Harness round dial, with
Claude Code running in Orca, Ghostty or any terminal on this computer.

## What it does

When Claude Code is about to ask the person to allow a tool call, its `PermissionRequest` hook (`hooks/approve`) asks
the Harness daemon on this computer. While a dial is attached, the dial shows the request, "Allow Bash?" with one line
of what it would do, and waits up to 5 minutes for Allow or Deny. The terminal's own prompt is there all along:
whichever answers first wins, and the other closes.

Voice: a prompt said at the dial is typed into an idle session as yours, never into a running turn. The plugin's mod
(`hooks/device.js`) keeps one request open to the daemon, and the prompt comes back as its answer. While the session is
working or waiting on you, the dial says it is busy and nothing is kept for later.

With no dial attached, no Harness daemon running, or no Harness CLI (`~/.local/bin/harness`, then `harness` on
`PATH`), the hook decides nothing, no prompt comes, and the terminal carries on as it would without the plugin.

## What it never does

- No auto-approve: only a person's Allow on the dial allows, and only the one request the dial shows.
- No "always allow": each answer is for that one request.
- No Allow for what the dial cannot show whole: a long command, one on more than one line, or one with a character
  outside plain ASCII is answered in the terminal.
- Nothing leaves the computer: the hook and the mod talk only to the daemon on it, and the dial attached to it. The
  dial sees the tool's name and one line of its input; the rest stays in the hook. The mod sends only the session's id.

## Install and remove

`harness device claude enable` installs and turns it on. To remove it:

```
harness device claude disable
```

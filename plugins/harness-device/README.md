# Harness Device plugin for Claude Code

Lets a person allow or deny Claude Code's permission prompts from the Harness round dial, with Claude Code running in
Orca, Ghostty or any terminal on this computer.

## What it does

When Claude Code is about to ask the person to allow a tool call, its `PermissionRequest` hook (`hooks/approve`) asks
the Harness daemon on this computer. While a dial is attached, the dial shows the request, "Allow Bash?" with one line
of what it would do, and waits up to 5 minutes for Allow or Deny. The terminal's own prompt is there all along:
whichever answers first wins, and the other closes.

With no dial attached, no Harness daemon running, or no Harness CLI (`~/.local/bin/harness`, then `harness` on
`PATH`), the hook decides nothing and the terminal's prompt carries on as it would without the plugin.

## What it never does

- No auto-approve: only a person's Allow on the dial allows, and only the one request the dial shows.
- No "always allow": each answer is for that one request.
- Nothing leaves the computer: the request goes from Claude Code to the daemon and the dial attached to it. The dial
  sees the tool's name and one line of its input; the rest of the input stays in the hook.

## Install and remove

`harness device claude enable` installs and turns it on. To remove it:

```
harness device claude disable
```

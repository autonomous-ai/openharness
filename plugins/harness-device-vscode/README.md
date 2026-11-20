# Harness Device for VS Code

Lets the Harness dial reach Claude Code, Codex and cursor-agent running in VS Code's or Cursor's integrated terminal,
on this computer.

## What it does

- **Tap** a session on the dial: VS Code comes forward with the window that holds that session's terminal, and shows
  it. On VS Code before 1.128, a window behind another shows its terminal without coming forward.
- **Swipe** and rest on a session while VS Code is in front: VS Code switches to that terminal.
- **Scroll** on the dial while VS Code is in front: that terminal scrolls, line by line. With `"tui": "fullscreen"` in
  Claude Code's settings, its view moves a page for each 8 lines. Fullscreen set only by `CLAUDE_CODE_NO_FLICKER=1`
  does not move: set `"tui": "fullscreen"`.

In Cursor it does the same. There the dial also lists Cursor's own agent: a tap on one opens Cursor's window for its
folder (for a multi-root workspace its first folder, which may open as a second window).

Each window tells the devices process on this computer which shells its terminals run, and shows or scrolls the
terminal the devices process names, or presses its page keys, raising itself when the show is a tap's. It asks
`harness device vscode link` (`~/.local/bin/harness`, on Windows `%USERPROFILE%\.harness\bin\harness.exe`, then
`harness` in an absolute `PATH` folder) where that process listens.

## What it never does

- It reads nothing from a terminal. It types only PageUp and PageDown, never Enter or other text, and only into a
  terminal where Harness found Claude Code's fullscreen view running at the stroke's start.
- It starts nothing but `harness device vscode link`.
- It shows no panel, status bar item, notification or command of its own.
- Nothing leaves the computer: it talks only to the Harness daemon's devices process on it, and sends only its
  terminals' shell pids, which one is active and whether the window is focused.
- In a remote window (SSH, WSL, a container) it does nothing.

## On and off

It turns on by itself: once a dial has attached on this computer, Harness installs it into VS Code and into Cursor.

Off: uninstall it in the editor's Extensions view, or, one editor at a time:

```
harness device vscode disable
harness device cursor disable
```

Harness then leaves it off. Back on:

```
harness device vscode enable
harness device cursor enable
```

## Its output channel

**Harness Device** in VS Code's Output panel names its state:

- `noHarness`: no Harness CLI found.
- `notRunning`: Harness's daemon can't be reached: stopped, older than this extension, or 8 windows already connected.
- `unplugged`: no dial is plugged in.
- `connected`: the dial reaches this window's terminals.

## Where it runs

VS Code 1.75 or later and Cursor, each in its default profile. VS Code Insiders, VSCodium and Windsurf are not covered.
On Linux, in Cursor, a tap shows the terminal; swipe and scroll do not follow.

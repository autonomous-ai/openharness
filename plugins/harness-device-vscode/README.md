# Harness Device for VS Code

Lets the Harness dial reach Claude Code and Codex running in VS Code's integrated terminal, on this computer.

## What it does

- **Tap** a session on the dial: VS Code comes forward with the window that holds that session's terminal, and shows
  it. On VS Code before 1.128, a window behind another shows its terminal without coming forward.
- **Swipe** and rest on a session while VS Code is in front: VS Code switches to that terminal.
- **Scroll** on the dial while VS Code is in front: that terminal scrolls, line by line.

Each window tells the devices process on this computer which shells its terminals run, and shows or scrolls the
terminal the devices process names, raising itself when the show is a tap's. It asks `harness device vscode link` (`~/.local/bin/harness`, then `harness` on `PATH`) where
that process listens.

## What it never does

- It types nothing into a terminal and reads nothing from one.
- It starts nothing but `harness device vscode link`.
- It shows no panel, status bar item, notification or command of its own.
- Nothing leaves the computer: it talks only to the Harness daemon's devices process on it, and sends only its
  terminals' shell pids, which one is active and whether the window is focused.
- In a remote window (SSH, WSL, a container) or on Windows, it does nothing.

## Turn it on and off

On: **Turn on VS Code** in Harness's menu-bar menu, or:

```
harness device vscode enable
```

Off: uninstall it in VS Code's Extensions view. Harness then leaves it alone.

## Its output channel

**Harness Device** in VS Code's Output panel names its state:

- `noHarness`: no Harness CLI found.
- `notRunning`: the Harness daemon or its devices process is not running.
- `unplugged`: no dial is plugged in.
- `connected`: the dial reaches this window's terminals.

## Where it runs

VS Code 1.75 or later, its default profile. Cursor, VS Code Insiders and VSCodium are not covered.

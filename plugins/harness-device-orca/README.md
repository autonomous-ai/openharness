# Harness Device plugin for Orca

Shows the Harness dial's state inside Orca: whether a dial is attached, and which agent it shows.

## What it does

A panel, "Harness Device", in Orca's right sidebar shows one state at a time:

- "Dial attached." while a dial is attached and shows no agent.
- The agent's name while it shows one, with the app it runs in on a second line ("Orca", "Claude", "Harness", …).
- "Dial unplugged." while no dial is attached.
- "Harness isn't running." while the Harness daemon is not running.
- "Harness isn't installed." and a **Get Harness** button, which opens `https://harness.autonomous.ai/desktop`, when
  there is no Harness CLI.
- "Open in another Orca." while another Orca on this account shows the dial.

A status bar item shows `Dial`, or the agent's name, while a dial is attached, and nothing otherwise. The panel and the
item change as the dial moves, with no refresh.

## What it never does

- It types nothing, starts no agent and moves no dial.
- Nothing leaves the computer, and nothing is kept: it reads only whether a dial is attached and the name and app of
  the agent it shows, from the Harness daemon on this computer.

## Install

```
orca plugin install <this repository>/plugins/harness-device-orca
```

It needs Orca 1.4.248 or later, on macOS or Linux. On Windows the panel reads "Not on Windows yet."

## The access Orca asks for

Its worker is a Node process with your own access, which Orca asks you to approve at install. It uses that to run
`harness device orca link` (`~/.local/bin/harness`, then `harness` on `PATH`) and to read one local socket, the one
that command names. While no dial is attached, it watches the folder that holds that socket (the Harness daemon's data
folder) for the socket to appear. It declares no capability.

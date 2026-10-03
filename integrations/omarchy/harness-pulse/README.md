# Harness Pulse (pi.harness-pulse)

An [Omarchy](https://omarchy.org) bar widget: one ring per coding agent this computer's Harness
daemon runs, on the bar. Written by Fred Nix ([@nixfred](https://github.com/nixfred)) in his fork,
[github.com/nixfred/openharness](https://github.com/nixfred/openharness) (MIT).

It shows the agents the Harness app shows — the daemon's own agents — and nothing else.

State language on the bar (every animation sits behind the `reducedMotion` setting, and every state
also has a glyph so colour is never the only signal):

- working: a comet with a fading three-step trail and a glowing head circles clockwise (1.8 s a turn)
- waiting on you: the ring breathes (1.0 to 1.08, 1.2 s), a soft halo swells out of it in the theme
  yellow, and a dot travels along the bar toward it
- permission: the same breath and halo in theme red, plus a repeating red strobe (three flashes) and a
  chromatic glitch
- failed: two strobes and a glitch on entry, then a steady thin red ring with one glitch tick every 6 s
- done, unreviewed: the core fills to a solid dot with an overshoot and a shockwave ring, then holds
- offline: a dim dashed ring, no motion
- idle: the ring shrinks to a dot, no motion
- spend: the outer arc, 0 to 100 percent of the per-agent cap (`harness spend set`); theme yellow from
  80 percent, red at the cap

Rings never change the row height or width; all motion is scale, opacity, rotation or a translate
inside a fixed slot. Animations use Shape paths and render-thread animators, not Canvas, and nothing
runs in idle, offline or a settled done ring.

The daemon glyph at the left is a hexagon: outline when the daemon is up, filled when it is not.
**Hold it 2 s to stop every agent on this machine** (`harness stop-all`); a red ring drains while held
and releasing early cancels.

Left-click a ring to focus the Harness window (Hyprland's Lua dispatcher on 0.56+, `focuswindow` on
older versions; change `focusWindowClass` if the class differs). Hover for name, engine, machine,
lane, state, spend and detail.

## Fleet view (right-click, or IPC)

Right-click the widget, or run `qs ipc call harness-pulse toggle` (also `open`, `close`). Escape
closes it. The popup has a fixed size and never scrolls; only the activity ticker scrolls, in place.

- Orbit field: one hexagon hub per machine, its agents riding a dashed orbit as the same rings as the
  bar. The orbit turns only while something works. The hub glows and a tether reaches out to every
  agent that waits on you, needs permission or failed.
- State chips: a count per state with its glyph.
- Spend: one 270 degree gauge per agent with a cap. Gauges sweep up from zero each time the popup
  opens, and one at or over its cap pulses red.
- Activity ticker: every state change, newest on top. Bounded at 40 rows.
- Hold-to-stop hexagon: press and hold. The six edges light one by one; release early and it drains.
- Idle and connecting: the chosen logo (see `logo`), breathing while the daemon is not answering.

All popup motion stops while the popup is closed.

## Settings

All settings are in the bar's widget settings (manifest `schema`), stored in
`~/.config/omarchy/shell.json` under the widget.

| Setting | Default | What it does |
|---|---|---|
| `reducedMotion` | `false` | Stops every animation on the bar and in the fleet view. |
| `ringSize` | `18` | Ring diameter in logical px, 12 to 28. |
| `maxAgents` | `8` | Rings on the bar, most urgent first (1 to 24). |
| `refreshIntervalSec` | `1` | How often `pulse-feed` polls the daemon (1 to 30 s). |
| `showMachine` | `true` | Show `@machine` in ring tooltips. |
| `focusWindowClass` | `com.autonomous.harness` | Window class a left-click focuses. |
| `avatar` | `Auto` | The face inside a ring that waits on you. `Auto`: `avatarPath` when set, else `~/.face`, else initials. `Initials`: always initials. `None`: a plain ring. |
| `avatarPath` | empty | Picture for `Auto`, round-cropped. `~/` is expanded. |
| `avatarInitials` | empty | One or two letters for the initials disc. Empty uses the first letter of `$USER`. |
| `logo` | `Harness` | Idle and connecting logo in the fleet view: `Harness`, `Omarchy` (read from `/usr/share/omarchy/logo.svg` at runtime; nothing is bundled), `Custom` (`logoPath`) or `None`. |
| `logoPath` | empty | Image for `logo: Custom` (SVG or PNG). `~/` is expanded. |

## Data

`pulse-feed` (python3, no dependencies) polls `GET /api/attention` on the local daemon, over its Unix
socket `~/.harness/cli/data/daemon-18473.sock` first and 127.0.0.1:18473 second, once per
`refreshIntervalSec`, and prints one JSON line per poll. Nothing leaves the machine. Exit 3 means the
daemon was unreachable for a minute; the widget restarts the feed every 5 s. `HARNESS_PORT` and
`HARNESS_SOCKET` override the defaults. The hold-to-stop calls `POST /api/stop-all` the same way.

## Install

From a checkout of this repository, on the Omarchy machine:

```
cp -r integrations/omarchy/harness-pulse ~/.config/omarchy/plugins/pi.harness-pulse
omarchy restart shell
```

Never `omarchy refresh`: that is a factory reset of the bar. Add the widget with the bar's own IPC if
it does not appear:

```
omarchy-shell shell putBarWidget pi.harness-pulse '{"section":"right","index":1}'
```

`Super + Shift + Space` shows the bar if it is hidden.

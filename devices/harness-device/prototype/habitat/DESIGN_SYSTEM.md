# Harness device: charcoal and lilac

One companion, one surface, one accent. The screen should belong to the same
desk as the Harness terminal. Its character provides personality; the surrounding
interface stays quiet and readable.

## Color

The source of truth is [theme.h](../../firmware/main/ui/habitat/theme.h).

| Role | Color | Use |
| --- | --- | --- |
| Canvas | `#181818` | Every screen; the desktop pane and command-dialog charcoal |
| Primary text | `#EFE7DE` | Session name, recap, active status, ordinary list labels |
| Secondary text | `#ADA6AD` | Hints, metadata, unavailable controls |
| Accent | `#C6AAEF` | Octopus, inbox action, selected destination, pressed feedback |
| Selection | `#392C4A` | Flat terminal-style selection behind a row or pressed control |
| Error | `#E7A6AD` | Actual failures and the final Stop action |

The canvas follows the **pane**, not the tab or workspace surface. The desktop's
`NewHarnessForm._surface` and `SwarmScreen._buildSearchOverlay` both use
`terminalTheme.background`, the same fill as the terminal. Its Graphite/Dusk
match-app value is `#181818`. There is no live desktop palette sync yet.

All six values survive RGB565 conversion without a further color shift when
expanded with the usual bit replication. At full software brightness, primary
text, secondary text, and accent have calculated full-ink contrast ratios of
14.51:1, 7.47:1, and 8.79:1 on the canvas. Antialiased edges, saved software
brightness, and the physical panel affect what the eye sees; these figures are
not physical-display measurements. Saved brightness remains in effect. Its control
advances through 25%, 50%, 75%, and 100%; byte/percentage conversion rounds so a
chosen level survives a save and reload. The dimmed canvas snaps to neutral
RGB565 grays (`#080808` at 25%, `#101010` at 60%, `#181818` at 100%) so the
extra green bit cannot give the charcoal a green cast. Other inks keep the same
brightness scaling.

Purple remains the creature's identity through working, listening, completion,
and requests for help. Expressions and words carry those states. A routine
question does not turn the creature gold; a completed turn does not turn it green.
Errors never recolor the whole companion.

## Type and hierarchy

Use the existing **Geist Mono 20 px**, with a fixed 12 × 28 cell, for all interface
text. It is rasterized at build time. The character keeps its separate ASCII
glyph atlas. No runtime font engine, extra font family, gradients, or shadows.

- The curved session name identifies the recipient in primary text. Position,
  rather than a different size or bright color, separates it from the recap.
- During work, the large octopus is central. Native activity uses primary text
  on the bottom arc; an actionable unread count uses the accent. Show `[1]`,
  or `[1] Working` when there is native activity. Use the existing text glyphs,
  with no emoji asset. Keep the broad bottom touch target independent of label width.
- On completion, a smaller companion supports the recap. It sits lower beneath
  the curved title, with 24–26 px between its frame and the prose. Brief results
  use a 162 px portrait and three rows; long results use 108 px and six tapered
  rows ending above the footer. The prose remains primary text, even while a
  notification is pressed. The action responds.
- Lists use ordinary primary text and one flat lilac selection. Back remains
  readable and neutral. Disabled choices use secondary text.
- Quiet mode stops motion without adding another layer of dimming.

## Behavior belongs to the same system

Reading a notification does not switch the desktop. Opening it explicitly focuses
that pane and returns to the large companion after the host acknowledges it. Its
already-read recap stays dismissed across tab/history refreshes; a new live result
can appear when the next turn finishes. Opening a question does not answer it.

The theme uses constant color tokens and the existing bounded text compositor.
It adds no allocated theme objects, animation tasks, or artwork frames. The
working layout, gesture thresholds, and approved octopus poses remain the same.
Reading touch regions follow the lowered content, keeping voice on the portrait
and local dismissal on the summary.

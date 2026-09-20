---
name: craft-the-viewer
description: Build the harness's viewer pane — the work in progress shown stage by stage as the agent writes, an interaction bar per artifact type, delightful to look at and touch — reusing or upgrading a shared viewer before building a new one. Use at the viewer stage and whenever a proof shows the pane lagging, blank, broken or dull.
---

# Craft the viewer

The person chats on the right; **your viewer is the left two thirds**, and it is most of what they
experience. They watch it while the agent works, and keep working in it after. Four failures to avoid
above all: a pane blank until the end; a pane that shows the result as a flat picture; a pane that is
empty until the first prompt; and a pane they can look at but never touch.

```bash
"$BUILDER" stage viewer active --note "<reuse|upgrade|new>: <why>"
```

## Choose: reuse, upgrade, or new

Look at the shared viewers in `$BUILDER_REFERENCE/store/viewers/` first (read each README):

| Viewer | Shows |
|---|---|
| `autonomous/cad-viewer` | STEP, GLB, STL, 3MF, DXF, URDF: orbit, section, measure |
| `autonomous/model-viewer` | glTF as a Blender-style viewport: outliner, shading, measure |
| `autonomous/doc-viewer` | PDF: thumbnails, outline, find, zoom, spreads |
| `autonomous/video-viewer` | renders: every version, chapters, frame-accurate scrubbing |
| `autonomous/game-viewer` | playable web games, build progress, versions, last good build kept |
| `autonomous/mujoco-viewer` | live physics, actuators on sliders, replay |
| `autonomous/film-viewer` | storyboards, a film player, notes on the timeline |
| `autonomous/web-viewer` | static HTML projects over loopback, with live reload |
| `autonomous/isolated-web-viewer` | HTML, CSS, JS, data and WebAssembly previewed in isolation |
| `autonomous/studio-viewer` | a host for specialist studios: bounded file access, live state, validated controls, one job at a time with cancellation, run history, artifact downloads |

- **Reuse** (`"viewer": { "use": "autonomous/<viewer>" }`) when a shared viewer already shows this
  artifact at the bar below *and* can show this domain's stages.
- **Upgrade** when a shared viewer is close: build the upgrade as your own viewer in this package,
  starting from a copy of that viewer (keep its licence notices), and note in `.builder/decisions.md`
  what should flow back to the shared one.
- **New** when the domain's artifact deserves its own experience: a score you can hear, a map you can
  pan, a chart whose points you can hover. Most harnesses worth building land here.

## The interaction bar, by artifact type

Meet every item for your type. Then add the one thing that makes this domain delightful.

| Artifact | The bar |
|---|---|
| Chart / plot | hover tooltips with values, zoom and pan on continuous axes, legend toggles, crisp at any size, the data table one click away |
| Document / page | pages as thumbnails, zoom, fit width, find, current page follows the edit |
| Score / notation | pages, play and pause with the playing note highlighted, tempo, jump to a bar |
| Map | pan and zoom, layers toggle, click a feature for its attributes, scale bar, basemap switch |
| 3D model | orbit, pan, zoom, fit, select a part, measure, wireframe or section |
| Diagram / graph | pan and zoom, select a node to see its details, fit to screen |
| Image / render | fit and 1:1, zoom, compare with the previous version |
| Audio | waveform or piano roll, play, scrub, loop a section |
| Animation / video | play, scrub frame-accurately, loop, the list of renders |
| Simulation | play, pause, step, reset, the parameters on controls |
| Interactive app / game | runs in the pane, keyboard and mouse, restart |

## It works before the first prompt

The template alone opens something real: the craft, already running, with the controls live. A person
who installs the harness and opens a tab sees what they just gained before they have typed anything,
and the agent's first save changes something that was already there rather than filling a void.

- Ship a small, complete, honest example in `template/` — an eight-bar phrase, a two-part assembly,
  a map of one neighbourhood — authored by you, not a stub.
- Say in the pane that it is an example and that their brief replaces it. It is a starting point, and
  it must never become a style the next brief cannot escape.
- Seed the first verdict in `workspace.init` so the header has a state before the first prompt, with
  `ready:false`: nothing has been checked yet.

## They work in it, and their changes survive

Looking is not enough. Give the person the craft's controls, and, where the domain allows, direct
editing that **saves back into the workspace**, so the agent's next turn continues from what they
changed. `$BUILDER_REFERENCE/store/agents/creative-direction` and `voxel-worlds` are the standard.

- Name the two or three edits that matter most in this craft (from the brief) and make those direct:
  drag the layer, retune the note, move the wall, change the label.
- **Save writes the source**, not a private format: the same file the agent reads next turn.
- **Never lose their work.** Keep the previous complete version (`.harness/history/`), and when the
  file on disk changed while they were editing, say so and offer both — never overwrite silently.
- A browser draft has not reached the source until they save; the pane should make which is which
  obvious.
- Deliverables are downloadable from the pane in the formats the brief names, and they open
  elsewhere.

## Progressive: the stages from the brief

The brief lists the domain's stages. The viewer shows each one the moment its first file exists:

- **Before the first save** the pane is not blank: it shows the harness's name, what it is about to
  make, and the stages as an empty track.
- **Each stage has a look.** The data table before the chart; a bare staff before the notes; the base
  map before the analysis layers. Transition smoothly between them (fade, morph) rather than flashing.
- **Errors never blank the pane.** Keep showing the last good render, dim it, and overlay the error with
  the file and line it points at. The game viewer's "uninterrupted last working game" is the model.
- **Follow the work.** Scroll to or highlight what just changed: the slide just edited, the bar just
  added, the layer just styled.
- **The verdict's phases** drive a stage track in the pane that matches the pane header.

## The protocol (every viewer)

- A long-running server started by `viewer.command` with `HARNESS_VIEWER_PORT`, `HARNESS_WORKSPACE`,
  `HARNESS_DSH_DIR`; listen on `127.0.0.1:$HARNESS_VIEWER_PORT` only.
- Serve the page and files from the workspace and nothing outside it (resolve, then check the prefix;
  bad percent-encoding is a 400, not a crash).
- Watch the workspace recursively, ignore `.harness/`, `.git/`, `node_modules/`, `.claude/`,
  `.agents/` and output folders you write yourself, debounce (about 150 ms), and push a change event
  (server-sent events are simplest).
- **Re-run the check on every change and write the verdict**, so the pane header moves without the
  agent running anything. `$BUILDER_REFERENCE/store/agents/marp/toolchain/viewer.mjs` does all of this
  in about 130 lines of Node with no dependencies: start from it.
- No network at runtime: vendor every script and font into the package (pinned in the lockfile), and set
  a Content-Security-Policy that keeps fetches on the page's own origin.
- **Answer `/favicon.ico`** — the harness's mark, or a 204. Every browser asks for it unprompted, and
  an unanswered one puts a console error in every frame of every proof, which is exactly the signal
  the review uses to tell a healthy pane from a broken one. Keep the console clean so an error means
  something.
- Dark and light: follow `prefers-color-scheme`, and design both on purpose.
- `?snapshot=1` renders deterministically (no animation, final state of the current files) so
  `"$BUILDER" snapshot` and proofs can take clean pictures — and shows the result **whole**: a
  picture cannot be scrolled, so what a person would scroll to must fit the frame, scaled down only
  as far as it stays legible.

## Delight checklist

- The first thing on screen is the artifact, large; chrome is quiet and minimal.
- The artifact follows the theme. A renderer that paints its own white background (a chart, a page,
  a canvas) gets the theme's colours in dark mode, or sits on a deliberate paper surface the design
  calls for; never a stray white box inside a dark pane.
- Type and spacing are deliberate; nothing overflows at 900 px wide or at 2560 px.
- The artifact is legible at the size it is shown: it uses the pane's width, text inside it is never
  below about 11 px, and a tall result scrolls rather than shrinking to fit the first screen. Scale
  down only what is wider than the pane.
- Motion is smooth and short (150–300 ms), and there is none under `prefers-reduced-motion`.
- Every control has a visible hover state and a keyboard shortcut for the important ones.
- Nothing says "TODO", "placeholder", "Lorem", or shows a raw stack trace.

## Try it like a person

```bash
"$BUILDER" proof open viewer-check      # a workspace with the viewer running, shown live in the Studio
"$BUILDER" snapshot viewer-check        # a picture of what the pane shows right now
```

Write the domain's files by hand into that workspace in stages and watch each stage appear. Look at
every snapshot yourself (read the PNG). Then check both themes and a narrow width.

## Done

Reuse, upgrade or new decided and written down; the template opens something real before the first
prompt; the bar met for the artifact type; the craft's edits are direct and save back without losing
work; every stage visible as it lands; errors keep the last good render; deliverables downloadable;
snapshots good in dark and light.

```bash
"$BUILDER" stage viewer done --note "<viewer>: <what a person can do in it>"
```

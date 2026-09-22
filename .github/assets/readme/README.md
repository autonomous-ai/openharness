# README animations

| File | What it shows | Made by |
|---|---|---|
| `agents.gif` | Four agents on three machines, working at once | `render.mjs` |
| `machines.gif` | A new box set up in four commands, linked, and running an agent | `render.mjs` |
| `keyboard.gif` | Open, zoom, answer a waiting agent and split, keyboard only | `render.mjs` |
| `e2ee.gif` | A session beside the ciphertext the relay carries | `render.mjs` |
| `beyond-code.gif` | Eight recorded hands-on sessions, cross-faded | `build.py` |

The first four are scripted scenes in `scenes/index.html`, drawn in the desktop app's design:
the tab bar, pane headers with machine, project and branch, and the fzf-style command box.
Open the file with `#agents`, `#machines`, `#keyboard` or `#e2ee` to watch a scene live.
Shortcuts, commands and dialog text follow `docs/keyboard.md`, `docs/cli.md` and the app's strings;
encryption facts follow `docs/architecture.md`. Keep them that way when editing a scene.

`beyond-code.gif` uses the unedited recordings in `docs/images/*-demo.mp4`.

Regenerate from the repository root:

```sh
(cd store/tools/experience-tests && npm ci)   # once, for playwright-core
node .github/assets/readme/render.mjs            # all four scenes, or name one
node .github/assets/readme/render.mjs --stills 2,6 keyboard   # review stills in .cache/
python3 .github/assets/readme/build.py           # beyond-code.gif
```

`render.mjs` needs Google Chrome and FFmpeg. It renders at twice the scene size and scales down,
so text stays sharp at README width. `build.py` needs Pillow, FFmpeg and SF Pro, and keeps its
output under 9 MiB.

# README animations

Two full-width GIFs lead the root README. Both share one look: a caption band with the slide title,
a short tag, slide dots and a progress rule.

| File | Slides | Source |
|---|---|---|
| `coding-tour.gif` | Every coding agent, Every machine, Keyboard first, End-to-end encrypted | The [original coding video](https://cdn.autonomous.ai/development/ecm/260910/Thumb-harness-app.mp4) for the first two. The keyboard and encryption slides are drawn by the script from `docs/keyboard.md` and `docs/architecture.md`. |
| `beyond-code.gif` | Eight hands-on sessions | The recordings in `docs/images/*-demo.mp4`, with titles matching `store/hands-on.json` |

Regenerate from the repository root:

```sh
python3 .github/assets/readme/build.py            # both
python3 .github/assets/readme/build.py coding     # one
```

It needs Python 3 with Pillow and NumPy, FFmpeg, and the macOS system fonts SF Pro and SF Mono.
The coding video downloads once into `.cache/`, which git ignores.

Keep the slides honest. Video slides are unedited clips of real sessions. The drawn slides may
state only shortcuts that ship by default and encryption facts from the architecture guide.
Keep `beyond-code.gif` under about 9 MiB so the README stays quick to load.

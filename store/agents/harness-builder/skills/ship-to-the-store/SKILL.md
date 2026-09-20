---
name: ship-to-the-store
description: Package the proved harness for the Harness Store — store.json with examples made from the proof runs, credit and licences, a README, no private data — and pass builder check. Use at the store stage.
---

# Ship to the Store

```bash
"$BUILDER" stage store active --note "Packaging for the Store"
```

## Examples from the proofs

The Store page leads with prompt → output examples. Make them from the passed proofs, never from a
mock-up:

```bash
"$BUILDER" showcase easy medium hard
```

That writes a 1600×1000 JPEG of each proof's final frame to `package/showcase/<id>.jpg` (under
350 KB) and an `examples` list into `store.json` with each proof's prompt and a caption you then
edit: one line naming what came out and one fact that makes it concrete ("Seattle rainfall ·
12 months · wettest month highlighted").

The pictures ship inside the package; the Store reads them from an **https URL**, and a path is the
same as no picture. Pass where they will be served from when you know it — for the built-in shelf,
`--base-url https://raw.githubusercontent.com/autonomous-ai/openharness/main/store/showcase/<name>`
— and leave the URLs out until then; `"$BUILDER" check` says the page has no pictures yet.

Look at each picture. It shows the viewer's final state: no error overlay, no half-rendered frame, no
empty pane. If a proof's final frame is not Store-worthy, the proof did not pass: go back.

## `store.json`

```json
{ "homepage": "https://…", "upstream": "https://github.com/…", "license": "MIT",
  "tagline": "Turn your business brief into an editable brand and complete launch kit",
  "evaluation": [{ "method": "tool", "by": "…" }],
  "examples": [{ "prompt": "…", "image": "…", "caption": "…" }] }
```

- **`tagline`** (≤ 80 characters) is the line under the name in the picker and the Store: what a
  person can now finish, in their words, not the tool's feature. "Turn a recording into an engraved
  score you can print", not "LilyPond engraving front end". The brief's section 1 is the source.
- **`evaluation`** is what the evaluation stage declared (`design-the-evaluation`): the methods the
  proofs' verdicts actually reported, worded to finish "Verified by …", "Checked against …",
  "Reviewed against …". Never a method the harness does not run.
- **`examples`** are the proofs' real briefs and their real pictures — including the one where the
  person brought their own material. The caption names the deliverable and one concrete fact
  ("Lead sheet · 16 bars, printed PDF and MIDI").
- **`listed: false`** keeps a package in the repo and out of the Store. Ship it that way if the
  proofs did not meet the bar: an honest shelf is worth more than one more tile.

## `brand/`

The tile needs a face: `brand/logo.svg`, and `icon.png` at 128 px for the app's picker.

- **A wrapper wears the project's own logo**, taken from its repository, its trademark guidance
  respected and the file left untouched. If the project publishes none, the tile draws its initial —
  better than a mark invented for someone else's project and put on their name.
- **An original workflow gets a mark of its own**, designed for the work it does, as the other
  Autonomous harnesses have. The tools underneath keep their names in the README, not on the tile.

Either way, say in the README where the mark came from.

## Credit and licences

Two kinds of package, named differently:

- **A wrapper** brings one upstream project into Harness (Marp, MuJoCo, Typst). The folder and the
  harness `name` are **the project's own name**, and `author` is its author or organization, as the
  project credits itself. The person is choosing that project by name.
- **An original workflow** uses several tools to do a job that is the harness's own (Creative
  Direction, Data Studio, Voxel Worlds). Name it **for the work**, `author` is Autonomous, and the
  tools it stands on are credited in the README and `THIRD_PARTY_NOTICES.md` rather than on the tile.
  A workflow named after its loudest dependency tells the person the wrong thing about what they get.

Then, either way:
- `LICENSE` for the harness itself (MIT unless the upstream licence requires otherwise).
- The upstream licence beside anything of theirs the package vendors (`LICENSE-<project>`), and a
  `THIRD_PARTY_NOTICES.md` listing every vendored component with its licence and version.
- `README.md`: what the harness does in two sentences, how to install
  (`harness dsh install <id>` / `harness dsh install "$PWD" --link`), how its evaluation works, and a
  **Credit and stewardship** section: whose project it wraps, that the wrapper was written on the
  project's behalf, and that the maintainers are welcome to own it.

## No private data, anywhere

No home paths (`/Users/<name>`, `/home/<name>`), usernames, hostnames, email addresses, tokens or API
keys in any file, and none visible in any picture (check the proof frames: terminal text, file paths in
viewer chrome). `"$BUILDER" check` scans text files; you check the pictures by looking at them.

## Done

```bash
"$BUILDER" check
```

No errors, warnings read and either fixed or explained in `.builder/decisions.md`.

```bash
"$BUILDER" stage store done --note "<id> ready: <N> examples"
```

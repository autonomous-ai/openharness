# Daemons: eggs that crack, and individuals with traits (spec, 2026-09-27)

Approved by the user in review:
- Eggs are drawn as filled plates like drop init, crack as you EARN them, and crack open when you
  OPEN them. (Reviewed as a private lookbook page.)
- A species (tim, the octopus) is a TYPE. Every hatch is its own INDIVIDUAL: a server-rolled seed and
  traits, a serial, and a name the user gives it at the hatch. Duplicates of a species are allowed and
  normal (two identical individuals are practically impossible). People collect species AND traits.
  Traits read as command-line flags: `tim -c coral --spots --glasses --fidgety`. A card shows how rare
  the rolled combination is: `1 in 2,130`.

The prototypes this spec was written against were ported into the repo in step 1 (see "Step 2
protocol" below): the shader's material channel is in `daemons/tools/plate.mjs`, the egg model is
`daemons/plates/egg.mjs`, the trait-aware species models are `daemons/plates/<id>.mjs`, and the
catalogues and one-liners are in `daemons/roster.json`.

## Eggs

- **Model** `daemons/plates/egg.mjs`.
- **Stages while earning**: `p0` whole, `p1` a crack part way, `p2` all the way with a chip, `p3`
  split with light inside, `p4` ready (rocks, two eyes peek from the chip). Opening: `rock` (two big
  rocks), `burst` (the top lifts, light pours out), `tumble` (the top breaks in two, the halves land
  either side, bits scatter), `open` (the bottom half; the hatchling then rises out of it).
- **Which stage** (reference `eggStage(done, need, ready)` in render.mjs, fixtures in frames.json):
  ready (the egg is earned and waits in the nest) -> p4; else done/need = 0 -> p0; < 1/3 -> p1;
  < 2/3 -> p2; else p3. The status line shows the one egg nearest to hatching: a waiting earned egg
  (p4) if any, else the earning egg with the highest done/need (first egg habits, setup habits, turn
  turns toward `earn.turn.every`, week days, night nights, marathon turns).
- **Colour**: each kind has `rules.eggs[kind].gradient { top, bottom }` (first cream #ffffd7->#d7d7af,
  setup lavender #d7d7ff->#8787d7, turn white #eeeeee->#a8a8a8, week robin's egg #afffff->#5fafaf,
  marathon orange #ffd7af->#d7875f, night #8787d7->#3a3a78 with pale #ffffd7 stars, easter pink
  #ffafd7->#af5faf, history sepia #d7af87->#875f5f; snap every hex to xterm-256 and validate like the
  daemons). Glow cells (`g`) are `rules.plate.light.plain` (#ffffd7) while earning and the rarity's
  light when opened (`rules.plate.light.{common #eeeeee, rare #5fd7ff, legendary #ffd75f, secret
  #af87ff}`); `p` (peek) is white. A secret's opening dims the shell and the stage goes dark.
- **One-liners** (8 cells, status line, `rules.eggLine`): `p0` `\_({k} )_/`, `p1` `\_({k}')_/`,
  `p2` `\_(/\)_/`, `p3` `\_(*')_/`, `p4` `\_(oo)_/` with a blink frame `\_(--)_/`; opening `burst`
  `'*(oo)*'`, `tumble` `')_^^_('`, `open` `)\_^^_/(`, then the hatchling's 0.1 sprite between shells,
  `)` + sprite + `(`, when that fits 8 cells, else the sprite alone. `{k}` is the kind's
  `rules.eggs[kind].mark`: first ' ', setup '$', turn '.', week '7', marathon '@', night '*', easter
  '?', history '#'. These REPLACE `rules.eggs[kind].look`, `rules.egg` and `rules.nest` (and
  `nestStage`, which becomes `eggStage` over the first egg's habits). Check every line against
  printable ASCII, 8 cells and `rules.ligatureUnsafe` in generate.mjs.
- **Baked** into plates.json under `eggs[kind].{portrait,reveal}[stage] = [{ rows, mats }]` (portrait 28
  cols, reveal 56 cols; p0 and p4 8 frames, p1-p3 1, rock 8, burst 6, tumble 8, open 1; one crop per
  kind and size so nothing jumps).

## Individuals and traits

- **Catalogue in roster.json**, per plate species: `traits: { colours: [[name, weight, top, bottom]],
  marks: [[name|null, weight]], extras: [[name|null, weight, hex]], props: { key: [lo, hi] },
  accents: [hex], oddEye: 0.02, fidgety: 0.3 }`, taken from the approved prototypes. The first
  colour is the species' gradient. Validate hexes (xterm), weights, ranges.
- **The roll** is one deterministic function of (species, seed): reference `rollTraits(roster, id,
  seed)` in render.mjs using the prototypes' `rng` (mulberry32 on `seed`) and draw order (colour,
  marks, extra, oddEye, then props in catalogue key order, then temper). Each prototype's `roll` may
  differ in order: normalise to ONE order for all species, re-run each species' samples, and keep the
  models consuming the resulting traits object. `individualFlags(roster, id, traits)` and
  `oneIn(roster, id, traits)` too. frames.json gets `traitRolls` (a spread of seeds per species with
  the expected traits, flags and oneIn) that every port (the server's TypeScript) must match exactly.
- **Models** `daemons/plates/<id>.mjs` become the trait-aware ones: `model({ t, mood, age, traits })`,
  where missing traits = DEFAULT = exactly today's look (all baked species plates stay byte-identical).
  Keep growth (`age`) working with traits.
- **Species plates** (plates.json) stay the DEFAULT look, used where no individual art exists yet.
  Clients paint an individual's colour family on the species plate as the fallback.
- **Individual art**: rendered on the user's machine by harnessd with the same shader and models (the
  models and shader are copied into the cli by generate.mjs), cached per individual under the adapter
  data dir, and served on request; the apps fall back to the recoloured species plate until it
  arrives. Frames carry mats so marks (`m`, in `traits.accent`), extras (`a`, the extra's hex) and the
  odd eye (`e`) are painted.

- **Status line** (8 cells, the bar's own colour, so traits show in characters): an individual with
  a rare extra uses that extra's one-line variant: `traits.extras[i]` carries `sprites { 0.1, 1.0,
  2.0 }` and `work [...]` in the species' exact sprite contract (now in roster.json).
  generate.mjs checks them like every sprite (width, printable, ligatures after every eye and blink,
  distinct from other species). A fidgety individual animates its work frames at half `workMs`.
  Colour, markings and the odd eye do not show in the status line. Reference
  `renderIndividualSprite(roster, id, traits, versionIndex, mood, { t, lid })` in render.mjs; frames.json
  gets fixtures for it.

## Server (backend/src/lib/zoo.ts, routes/zoo.ts)

- A zoo holds INDIVIDUALS: `{ uid, id (species), seed, serial, name?, shiny, xp, bond, version,
  hatched, egg }`; `paired` names a uid. A hatch mints the species serial (DaemonMint, per species),
  draws `seed` with crypto, stores it (traits are derived from seed, never stored as truth).
- Draw: species weights as today; duplicates allowed; the first 4 hatches of an account are always a
  species it does not own; after 8 hatches in a row with no new species, the next is a new one (when
  an unowned released regular exists). Secrets as today.
- Ops by uid: `pair { uid }`, `zoo.nickname { uid, name }` (the name at the hatch). Old zoos (one
  record per species, `dupes`) read as individuals with seed 0 = DEFAULT traits, one per record.
- Limit: 256 individuals.

## Order of work

1. Contract (this spec into daemons/README.md, roster, render.mjs references, generate.mjs checks and
   bakes, frames.json fixtures, card.mjs cards show flags + `1 in N`), on branch `daemons`.
2. In parallel after 1: server; harnessd (render + cache + frames); desktop; phone; hn.

## Step 2 protocol (fixed so the five parts can be built in parallel)

The contract (step 1) is on branch `daemons` (commits 5483f911..9707a57f): read daemons/README.md
"Eggs" and "Individuals", render.mjs (`eggStage`, `eggLine`, `habitProgress`, `rollTraits`,
`individualFlags`, `oneIn`, `individualDaemon`, `renderIndividualSprite`), plate.mjs (`bakeModel`),
frames.json fixtures (`eggStages`, `firstEgg`, `eggLines`, `eggColors`, `traitRolls`,
`individualSprites`, `individualColors`, cards with `seed`/`name`), plates.json `eggs`.
Removed: `rules.nest`, `rules.egg`, `rules.eggs[kind].look`, `nestStage`, frames.json `nests`.

- **Zoo shape** (`GET /api/zoo`, `zoo_changed`): `daemons: [{ uid, id, seed, serial?, name?, shiny,
  xp, bond, version, hatched, egg }]`, `paired: uid|null`, eggs and progress as before. `uid` is a
  server-made id (24 hex). `seed` is a positive 32-bit integer; 0 = the species' default traits. Ops:
  `pair { uid }`, `zoo.nickname { uid, name }` (1-24 printable chars, trimmed), `zoo.hatch { eggId }`
  returns the new individual (and `levelUps` as before; no more `dupes`/merge xp: a same-species hatch
  is a new individual). A zoo stored in the old shape (records by species id with `dupes`) is read as
  individuals: each record becomes one individual with `uid` derived deterministically from userId +
  species id, `seed` 0; `paired` maps to that uid. Limit 256 individuals.
- **Individual art from the harness background process** (cli; the docs call it harnessd):
  it renders an individual's plates with the generated models (`cli/src/pair/plates/*.g.ts`,
  `bakeModel`), caches them on disk under the adapter data dir keyed by
  `(PLATE_SOURCE, species, seed)`, and pre-renders the new individual's reveal/portrait at the version
  it hatched when it sees a hatch. Requests:
  - local (Unix socket, like the other `daemon_*` frames): `daemon_plate_get { requestId, uid, id,
    seed, size: 'portrait'|'reveal', version, mood }` -> `daemon_plate { requestId, uid, size, version,
    mood, frames: [{ rows, mats }], frameMs }` or `{ requestId, error }`.
  - phone (sealed application frames over the relay, in applicationFrames.ts, never core.ts):
    `pair_plate_get` / `pair_plate` with the same fields.
  Apps show the species plate painted in the individual's colour family (and its gradient) until the
  individual art arrives, and when the harness process is not reachable.
- **Everywhere an individual shows**: its one-liner in the status line (`renderIndividualSprite`,
  fidgety = half workMs), its plate (individual art or recoloured species plate), its name
  (`pip the tim`, or `tim #0042` when unnamed), its flags and `1 in N` on the card and in the zoo, and
  the zoo lists individuals grouped by species with a trait log per species (colours, markings and
  extras seen, of how many). The hatch asks for a name (optional, skippable) after the card.
- **Eggs everywhere**: the status line shows `eggLine` for the egg nearest to hatching; panels show
  each earning egg's plate at its `eggStage`; the hatch plays rock -> burst (rarity light; a secret
  dims) -> tumble -> open -> the hatchling rising out of the bottom half, then the card; Reduce Motion
  goes straight to the card.

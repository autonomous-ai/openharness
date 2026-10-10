# Walking into the brain: Memories prototypes

2026-10-10. The Memories viewer works, but it is a list: groups to open, rows to click. The agent chat
beside it already answers questions, so the viewer's job is something a list cannot do: let a person
**walk into their own memory** and find things the way one finds a memory, by place, by association
and by time. These are experiments toward that, built on the viewer's real data.

## How to open them

```bash
node docs/research/2026-10-10-memory-brain/serve.mjs 47611
open http://127.0.0.1:47611/            # an invented person
open "http://127.0.0.1:47611/?real"     # your own memories on this computer
```

`?real` reads what the Memories viewer reads (`store/agents/memories/lib`): agents' memory files,
About You and your messages from the session index. It is read on each request, only on loopback,
and never written anywhere. Every page also opens straight from the file system on invented data.

## What films do with a mind

| Film | How it shows a mind | What we take |
|---|---|---|
| Inside Out (2015) | Memories are glowing orbs on endless shelves of Long Term Memory; core memories power Islands of Personality; recall tubes fetch an orb; faded orbs crumble in the Memory Dump | memory as an object you can hold; color by feeling; forgetting as fading |
| Inside Out 2 (2024) | The Sense of Self: memories send up belief strings that weave into a glowing structure | **About You is exactly this**: each line is a belief, each is held up by the memories it cites |
| Eternal Sunshine of the Spotless Mind (2004) | Walking through memory scenes that collapse while you are in them; books lose their words, faces blur, lights go out | age as decay: old memories lose letters at the edges |
| Inception (2010) | Dream levels stacked inside each other; architecture that folds; the secret in the deepest level | depth as abstraction: About You, then memories, then conversations, then your words |
| Sherlock, "The Hounds of Baskerville" (2012) | The mind palace: words float in the air and are swept aside with a hand | typing makes memories float up around you |
| Interstellar (2014) | The tesseract: one bookshelf at every moment in time, laid out as space; a pulled string reaches across time | time as a place you move through |
| Harry Potter (Pensieve) | Silver strands of memory in a basin; lean in and fall into the moment | diving into one memory |
| The Cell (2000), Lucy (2014) | Flying through a mind's own landscape; neurons firing | the connectome as a place; activity as light |
| Westworld (2016) | The maze: consciousness is a journey inward, to the center | the center of the brain is "you" |
| Black Mirror, "The Entire History of You" (2011) | Rewinding and replaying any moment | scrubbing through time |
| Severance (2022) | Macrodata Refinement: a terminal of drifting numbers sorted by how they feel | the terminal can feel alive |

Recall in cognitive science is **spreading activation**: a cue lights one memory, and the light spreads
to what is associated with it. That is a better search than a filter box.

## Four concepts

1. **Synapse** (`synapse.html`). Fly into a brain built from your data. Every message is a neuron, memories
   are bright engrams, projects are regions, About You sits at the core with axons to what it cites. Type,
   and recall spreads through the brain as light; the camera follows it to the memory. Scrub time and watch
   the brain grow from your first message to today.
2. **Sense of Self** (`self.html`). Inside Out 2's belief strings, literally. About You hangs above as a
   luminous structure, one strand per line; below is the lake of memories; threads rise from each memory to
   the beliefs it holds up. Pluck a belief and see why your agents believe it.
3. **Mind Palace** (`palace.html`). Walk the halls in first person, vector-drawn like an old arcade game.
   About You is carved in the atrium; each project is a wing; old rooms gather dust and lose letters. Type,
   and words float up around you, Sherlock-style.
4. **Tesseract** (`tesseract.html`). Your months unrolled as a corridor of days. Each day is a frame holding
   what you said and what your agents wrote down; strings tie a memory to every day it came up. Fly through
   time; pull a string.

Each is keyboard first (the person this is for works like vim and tmux), runs without libraries or network,
and renders memory text as text only: it is written by models and may hold anything.

## What was built (2026-10-10)

All four run in both modes and from `file://`. In headless Chromium at 1360×900 none logged an error
or fetched anything from outside, and all respect reduced motion. Recall starts as soon as you type;
where a letter is also a command, start with `/`.

| | Keys | Notes |
|---|---|---|
| [Synapse](synapse.html) | type · ←→ orbit · ↑↓ fly · ⏎ dive · esc · `[ ]` time · `\` replay | WebGL point cloud. About You is a gold arch between the hemispheres; `\` replays the brain growing from the first message |
| [Sense of Self](self.html) | type · ←→ branch · ↑↓ belief · space pluck · tab thread · ⏎ into the lake | Canvas. About You as a tree of light whose roots run to the memories below the water; old orbs sink, crack and lose letters |
| [Mind Palace](palace.html) | type · ↑↓ walk · ←→ turn · ⏎ go in or read · tab map · `~` home | WebGL vector halls with bloom. About You on standing stones; a wing per project; recalled memories fly in as cards and you glide to their room |
| [Tesseract](tesseract.html) | type · ↑↓ days · ⇧ weeks · ←→ messages · space pull · tab follow · `~` About You | Canvas corridor of days. A pulled string ripples through every day a memory came up |

## Found on the way

- **Sessions Harness launched are indexed without their folder.** `externalFields` in
  `cli/src/lib/sessionSearch/indexer.ts` records `cwd` only for sessions started outside Harness, so on
  one real machine 165 of 328 sessions, and 98% of messages, have no folder. Memories' Projects and
  every project-shaped view here undercount because of it. The transcripts know the folder (Claude
  Code's project directory, Codex's `session_meta`); the indexer should keep it.

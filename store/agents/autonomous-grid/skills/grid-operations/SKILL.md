---
name: grid-operations
description: "Look after the models on the user's machines — one laptop or a fleet: recognise their private grid, pick the model and settings that fit this machine for coding without asking, start it with the longest context the machine can give (never under 64K), say what it costs in memory, prove it answers with one bounded call, change or stop a running one, and use Grid routing, usage, media and training commands."
---

# Grid operations

`$GRID_FLEET` and `$GRID_CLI` are executable paths, not directories. Quote them. Start with
`"$GRID_FLEET" config` and `"$GRID_FLEET" status`. `status` reads the viewer's published snapshot
without opening a socket or launching Grid. Check `fresh`, `status` and `observedAt`; use fresh live
observations to answer ordinary inventory questions. A downloaded weight file or a catalog entry
is not a serving model. The viewer reads actual CLI data, and the
runner records operation start/completion without recording prompts, credentials or full argv.

This harness runs without Codex's sandbox, so these commands run as they would in a terminal —
`join` gets the GPU, every call reaches the network. Never request escalation, and never read a
failure as a sandbox problem: the command's own error is the answer. Never diagnose an engine with
`ps`, `lsof`, `sysctl` or logs; report the error after two failed attempts and wait.

## Targets and access

`grid-fleet.json` holds the mode (`local` or `remote`), grid selector, controller machine, managed
machines and user preferences. A null grid means the workspace is not connected; the viewer must not
fall through to an old CLI default. **The CLI's selection (`use`) is the one source of truth for
which grid this is.** The viewer reads it on every poll and follows a change, so what the person
selected — in a terminal, or by asking you — is what the screen shows; `connect` selects too, so
the two never disagree. A fresh sign-in has no selection yet: then the workspace reuses the
remembered fleet, else the **user's own private grid**, recognised rather than asked for — Harness
mints it at sign-in as the email's local part from `~/.grid/credentials.toml` (lowercased, runs of
non-alphanumerics → `-`, trimmed), then `-` and eight hex, of type `permissioned-public`; exactly
one row of `ls --json` matches — and selects it, so the CLI agrees from the first minute. A person
who asks to "switch to", "use" or "work on" another grid they are in (`ls`) gets `connect` with
that name: it verifies the grid answers, then selects it. Pass the selected grid to every command
that takes one. **Shared grids** are every other row of `"$GRID_FLEET" run -- ls --json` — a
company's, a team's, a community one. A request that names one ("on the team grid", "on the
company grid") goes to that row's exact `grid` name; a request that names none goes to `grid` in
`grid-fleet.json`. Read the names from `ls`, never from memory.

**"My grid", "my personal grid", "my private grid" all mean `personalGrid` in `grid-fleet.json`**
(also `$HARNESS_PRIVATE_GRID`). Harness put it there from the account that is signed in, so it is
the answer, not a guess: pass that exact name to `join`, `leave`, `engines` and `models`, and do not
ask the person which grid is theirs. It can differ from `grid` (the workspace's selected fleet) —
a request that says "my grid" goes to `personalGrid`, whatever is selected, and so does a request that
names no grid at all ("run a model on my Mac"). The `type` column of
`ls --json` is what kind of grid a row is, not a permission to ask about: `permissioned-public` is
a person's own grid, `private-domain` a company's, `domain-restricted` a team's, `os-community` a
public one. Only when `personalGrid` is null: run `harness grid setup` (it makes the account's grid)
and `"$GRID_FLEET" init` (it records it); still null → say in one line that this account's grid could
not be found — never pick one from `ls`.
Connect with
`"$GRID_FLEET" connect --mode remote --grid NAME --remember` to select a verified grid and reuse it
in future workspaces. `--remember` writes this controller's `~/.harness/grid-fleet/default.json`;
existing workspace selections remain independent. Changing this workspace's mode never requires
changing Grid's global mode.

The default machine is this computer. Use `"$GRID_FLEET" discover` to list the user's Harness machines,
and `discover --add` to add them when fleet management is requested. Paired Harness links need no SSH
setup; the runner checks the target's Grid fleet protocol before any command. An older Harness must
be updated before this transport works. An offline or unlinked machine stays unavailable.
Alternatively, add a known SSH target using an established SSH config alias
or `user@host`; do not infer SSH access from a display name in Grid. Grid lists serving engines,
which are not necessarily distinct physical machines. See [fleet configuration](references/fleet.md).
An engine can be observed through the relay without having permission or a transport to administer its host.

```sh
"$GRID_FLEET" run -- ls --json
"$GRID_FLEET" run -- engines GRID --json
"$GRID_FLEET" run --machine MACHINE -- device-info --json
"$GRID_FLEET" run --machine MACHINE -- catalog --json
```

`run` passes every argument after `--` to the real Grid CLI and applies the workspace's mode.
It supports Grid's entire CLI, including nested commands. Local and SSH execution accept interactive
input; Harness transport is noninteractive, so sign-in prompts belong in that machine's terminal. The controller is
the default execution machine. Model files and `join`/`leave` operations belong on the machine
that runs the engine; listing, routing and requests can run on the controller.

## First local model: help from this conversation

The Models panel normally handles discovery and Start/Stop directly. If the user asks this
conversation to help set up a local model, begin inspecting this computer immediately and follow
**Start a model** below — the same defaults, no setup questions. Keep setup on this computer;
other machines are available when the user asks for them.

Use the tracked fleet runner for hardware checks, downloads, and startup, so the viewer retains
progress while the conversation is closed or interrupted. The setup ends at a usable model: on
success, say **"Your model is running. Select it from the model picker in a session."**

## Start a model

Slow steps are a real stop: a download or an engine build is asked about through the question tool
and runs in the **next** turn, never in the message that asks. Every model you offer comes from
something you looked up — the grid, a machine's disk (step 0), the catalog, or Hugging Face — never
from memory. The pick is made once; that is the model through the download and the start, unless it
fails (won't fit, won't pull, won't answer) or the person asks for a different one.

**0. Scan first — what the grid serves, and what every machine already holds.**

- *The grid:* `"$GRID_FLEET" run -- models GRID --json` for the grid it will go on. A model already
  served there needs no start at all — say "use it from the model picker now".
- *This computer:* `skills/run-local-model/SKILL.md` — it takes stock (`fleet models`), sizes, picks
  file and engine, starts and verifies. This skill adds only the grid parts below.
- *An SSH machine in `grid-fleet.json`:* `"$GRID_FLEET" models --machine M --summary` runs the same
  finder on that machine with its own Node — its disk, engines, ports and memory [run]. Without Node
  18+ there it prints a file list only and says so.
- *A Harness-linked machine:* its disk cannot be listed from here yet. Read its hardware
  (`run --machine M -- device-info --json`) and say in one line that its downloaded files are not
  visible, so a model for it comes from the catalog.

**1. What they need — decided for them, not asked.** Harness is a coding tool: the model is for a
coding agent unless the person says otherwise. Do **not** ask them to choose an engine,
quantization, context size, concurrency or vision — pick what fits this machine best, say what you
picked and what it costs, and change one thing only when they ask for something different ("make it
two at once", "turn vision off", "a smaller one"). The defaults:

  - **Context: the longest this machine can give, and never under 64K tokens.** Codex, Claude Code
    and OpenCode each open a session with thousands of tokens of instructions and tools and grow
    from there; below 64K a session survives a few turns and then fails. A model that cannot get
    64K on this machine is not offered — pick a smaller model or quant instead. There is no 32K
    option.
  - **One at a time** (`--max-concurrency 1`): one agent. Every extra slot reserves its own full
    context up front, so a second one halves what each can hold.
  - **Vision on** when the model has a projector (it reads screenshots) and the context still clears
    64K with it; otherwise text only, said in one line.
  - **The quant the catalog fits** (`fit.version`), or the file already on disk.

**Say it in pages, and say what it costs.** A page is about 650 tokens (≈500 words), so 64K is
about 100 pages, 128K about 200 and 256K about 400 — tokens ÷ 650, rounded. Never shown as bare
token counts. The cost in memory is the weights (the file size) plus the context's reservation:
before the start say "the model takes W GB, and its context uses the rest of the U GB this computer
can give models" (`usable_bytes` from `device-info`); after the start, give Grid's measured figure
when `engines --json` reports one. Never invent a number.

**2. Another machine's hardware.** `run --machine M -- device-info --json`: `usable_bytes` is its
ceiling, per machine, never summed. Its llama.cpp is installed when `~/.grid/bin/llama-server --version`
prints a version. ⚠️ `engine status` reports the **media** engine (ComfyUI) and says `Installed: no`
on a host whose llama.cpp is fine. Only when the binary is missing, ask and run
`engine install llama.cpp [--from-source]` in the next turn.

**3. What is already on disk comes first.** Step 0's table lists every model file on that machine,
from every app, with its context and whether it reads images — a file under 64K is skipped. A
suitable file already there is the pick ("already on this computer, no download"); fetch something
new only when none is.

**4. The catalog, then Hugging Face.** `catalog --json` is sized for the host: keep entries that are
`runnable`, whose `fit.ctx` is at least 65536, and that are good at code; pull `fit.version`'s
`pull_spec`. Pick the best one for coding yourself and name it with the download size in GB, how
much it can hold in pages and whether it reads images; offer a shortlist of 2–3 only when the person
asks for other options. No speed figure (`fit.est_tok_s` only orders the list for "fast"), no quant
name, no token count as the whole answer.

When the person names a model the catalog lacks, the catalog is not a wall — `pull` takes any
`<repo>:<file>.gguf` on Hugging Face and fetches its projector too:

    curl -sf "https://huggingface.co/api/models?search=<name>&filter=gguf&sort=downloads&limit=8" \
      | python3 -c 'import json,sys; [print(m["id"], m.get("downloads")) for m in json.load(sys.stdin)]'
    curl -sf "https://huggingface.co/api/models/<repo_id>" | python3 -c '
    import json,sys
    for f in json.load(sys.stdin)["siblings"]:
        if f["rfilename"].endswith(".gguf"): print(f["rfilename"], f.get("size"))'

Prefer the model's own publisher, or a quantizer that publisher's model card or the catalog names,
over an unknown uploader, then downloads; say which in half a line. Pick the quant by size against
`usable_bytes` (or ≈0.6 bytes per parameter for Q4_K_M), leaving room for context. A model outside
the catalog has been sized by nobody but you — say the fit is your estimate.

**Vision is not in the catalog** (every entry's `task` is `text-generation`). Before pulling, the
same `siblings` list answers it: any top-level `mmproj*.gguf` means the model reads images — print
the file names, and put "reads images" or "text only" on each option; for "Reading images" offer
only repos with an mmproj. After the pull, the disk proves it:
`test -f ~/.grid/models/<stem>.mmproj.gguf`.

**5. The context, then the start.** `--ctx-size` is per request and the engine reserves context ×
slots up front (4 slots at 64K is 256K tokens of KV cache before the first request). **Always pass
it** — start from the most the model is sized for: a catalog model's `fit.ctx` (capped at
`fit.max_ctx`), or for a file the catalog never sized, what `ctx FILE --json` says it was trained
for. ⚠️ Never leave it off. Left to the engine, a 35B model took its whole trained 256K on a 64 GB
Mac whose GPU could hold 128K: it loaded, then failed its very first request with `Insufficient
Memory (kIOGPUCommandBufferCallbackErrorOutOfMemory)` and every request after with `Compute
error.`; the catalog's fit is optimistic the same way. So **step down when it does not run**: if
the first request after the join (step 6) answers `Compute error`, out of memory, or the join itself
fails, `leave`, `sync`, and join again at half — 256K → 128K → 64K. If 64K fails too, stop and say
this computer does not have the memory for this model with a 64K context; offer a smaller model. *Vision:* on by default when the projector is
on disk. When the person asks for text only, rename the projector yourself
(`mv <stem>.mmproj.gguf <stem>.mmproj.gguf.off`) before the join and say so in one line.
Sizing (weights + context × cache per token within free memory) is `run-local-model` §3.

    "$GRID_FLEET" run --machine MACHINE -- pull OWNER/REPO:EXACT_FILE.gguf
    "$GRID_FLEET" run --machine MACHINE -- join GRID --serve EXACT_FILE.gguf --advertise-as MODEL_ALIAS \
      --max-concurrency N --ctx-size CTX --endpoint-port PORT

A GGUF **already on that machine** in another folder (step 0 found it) is linked, never pulled again:
`"$GRID_FLEET" link --machine MACHINE FILE NAME.gguf [--projector MMPROJ_FILE]`, then `join … --serve
NAME.gguf` — FILE is the full path `fleet models --machine MACHINE` (JSON, `path`) printed. `link`
says `NOT READY` when that machine's Grid engine is missing or does not start: ask, then `run
--machine MACHINE -- engine install llama.cpp` in the next turn.

`--advertise-as` is the name the person will see in their model picker. **Don't pass `--name`:**
the runner sets it on every `join` to the machine's name as Harness Machines shows it right now, and
replaces any you give — it is the label under the model in every picker, and a name made up here
(a machine name joined to a model name) or Grid's host-name default read as a different computer.
Say the machine by that same name. `--max-concurrency N` is 1 unless they asked for more; don't pass
`--parallel` (grid derives the slot count from it) and don't pass `--jinja` (on by default in the
engine grid ships). Never pin `--ctx-size` under 65536 — a window that small cannot hold a coding
agent's own prompt (a 32K engine here refused an agent's first request of 59,561 tokens). Use
explicit ports when several instances share a host. An existing Ollama, vLLM, MLX or LM Studio
engine joins with `--at http://HOST:PORT/v1 -m MODEL --advertise-as ALIAS` (the runner names it too) — the
`/v1` is required, `fleet models` prints the exact URL, and the matching `skills/engine-*/SKILL.md` has
its start and ready checks; do not install a second engine needlessly.

Thinking: for everyday use `fleet run --thinking off -- join … --reasoning-budget 0`. `--thinking off`
sets `enable_thinking:false` at startup — needed, because a zero budget alone still let a model spend
every token thinking [run]. `--thinking on` enables it; either applies only to a new start.

**6. Prove it answers — once, bounded.** A successful `join` means *starting*, not ready. First wait
for the relay to list it (a call before that answers `No providers available for this model`, which
is "not yet", not "broken"):

    # engine on this computer: its own checks first, then the relay
    "$GRID_FLEET" verify --at http://127.0.0.1:PORT/v1 --model MODEL_ALIAS --kind llama.cpp --grid GRID --alias MODEL_ALIAS
    # engine on another machine: the relay only
    "$GRID_FLEET" verify --grid GRID --alias MODEL_ALIAS
    # once it passes: the receipt the Models panel shows
    "$GRID_FLEET" verify --grid GRID --model MODEL_ALIAS

A `verify` that fails with a compute or out-of-memory error is the context not fitting — step down
as step 5 says rather than retrying the same size. Then read the window it actually got:
`engines GRID --json`, this machine's row, `model_capabilities[<model>].context_length`. Under
65536, `leave` it, say in one line it could only get N pages here, and move to a smaller model or
quant. A null means Grid did not say; report the context you passed.

Every step prints its elapsed time and every wait has a deadline (listing: every 10 s up to 300 s;
the relay answer: up to 420 s with a "still waiting" line every 15 s) — never a bare `until … sleep`
loop, which waits forever on an engine that never registers. Relay the progress lines to the person.

Never `chat` for this check: it has no output limit, and a small model that runs away holds the only
slot for minutes. Right after a join, grid probes the new engine with ~5K tokens (3–5 minutes on a
host without a GPU): tell the person it is warming up, run `verify` once, and leave it alone. It fails
within its deadline: `leave`, say so in one line, and offer the next model up, or stop. Then
`"$GRID_FLEET" refresh`.

**7. Say where it is, and what it costs.** "<alias> is running on <machine> with room for about
N pages (<K>K tokens), one at a time, vision on/off; it uses about M GB of memory. Pick it from the
model dropdown at the top of any agent's pane, and that agent switches to it." In the Models
panel, **Use** returns to the person's session or opens one when needed. Don't offer to wire it into an agent's
config or add a provider — the picker is the whole hand-off.

## Change a running model

The person names the one thing they want different; everything else stays. Read the current
settings from the viewer or `stats GRID --verbose --json` (model, context, slots) so you change only
that and can say what changed. Context, concurrency and vision all mean a restart — `leave` that
instance, then the same `join` with the one flag (or the projector file) changed; check the fit
first as in step 5. A different model is step 4 onward, keeping the context and concurrency they
already have; stop the old one only when the new one is about to serve. Stop is `leave` and one
line. A restart drops the model from the picker for the seconds it takes and any agent mid-turn on
it loses that turn: say so in one line, and ask first only when `stats` shows requests in flight.

## Undeploy and move

`leave GRID --engine SELECTOR` on the serving machine stops/unregisters that instance. Match an
exact unique engine identity from `engines` first. `leave --all` affects other workloads; use it only
for a user-requested whole-grid teardown. `rm MODEL --yes` deletes downloaded weights and is a
different action from undeploying; retain files unless deletion is requested.

Verify the engine disappears from discovery after `leave`, with bounded polling. Local Grid can retain
a stopped engine until its 60-second heartbeat TTL expires; remote grids have their own convergence
delay. A successful exit alone is not proof of removal. If it persists beyond the deadline, inspect
the named process/logs and report a failed or incomplete undeployment, not a successful one.

For a move: verify the destination can answer the same model alias, check whether the source has
active work when that telemetry exists, then remove the source instance and verify routing again.
Do not promise seamless draining or conversation migration: the CLI does not guarantee either.
If the destination fails, keep the source serving. Keep a rollback command in the plan.

## Placement and model discovery

Use user needs (latency, coding quality, vision, privacy, power, quiet hours, concurrency) to compare
placements. `stats GRID --verbose --json` and `usage GRID --by model --json` are remote-grid reads.
Local grids expose a smaller surface; `device-info` gives hardware inventory, not a complete live
GPU sensor feed. Missing sensor values cannot justify moving a workload.

`throughput_tok_s` is the last measured decode estimate for one engine. Do not sum engines' rates
or present it as a simultaneous fleet benchmark. Compare candidates using the same representative
task and context; preserve the observed timings, output and model/quantization in `plans/`.

The shipped catalog is curated, not a live feed of every new release. For newly released models,
check primary model cards/release sources and offer a measured trial. Automatic replacement needs
the user's explicit standing policy (`allowAutomaticChanges` plus a concrete scope); a suggestion
does not authorize an unrequested fleet-wide upgrade. Existing authorization for a deployment or
move is enough to carry it through without asking again.

## When something fails

Say what failed and stop; translate every message, never repeat a raw line that names the CLI.

  - **`You're not signed in`** or **`Grid is not installed`** → yours, never the person's: `harness grid
    setup` (installs Grid when missing and signs this computer in with its Harness account, no browser),
    then `"$GRID_FLEET" init`, then the step again. Never `grid login`: it is a second sign-in. Only
    `harness grid setup` saying this computer is not signed in to Harness is theirs: `harness login`,
    the only command ever theirs.
  - **`No providers available for this model`** right after a join → not registered yet; wait as
    step 6 says.
  - **`exceeds the available context size`** (an agent may show it as a garbled "expected array
    `choices`") → served with too small a window: leave, and join again with the longest context
    that fits (step 5) — never under 64K.
  - **`Jinja Exception: System message must be at the beginning`** → the model's template refuses a
    system message after the first turn; the relay now hoists system/developer messages to the
    front, so the relay this machine talks to predates that fix. The model is fine; nothing to
    change here.
  - **The user says it isn't in the picker** → it is there only while served: `stats GRID --verbose`;
    not listed → start it again (the weights are still on disk); listed → the picker refreshes on
    open.

## The rest of Grid

Use `"$GRID_FLEET" run -- --help`, then a command's `--help`, to discover the installed surface.
See [command routes](references/commands.md) for the main families. Routing, training, media,
projects and agents are available through the same runner. Do not change credentials, memberships,
pricing, external API billing or training jobs as a side effect of an ordinary local deployment.

Keep failures visible. A timeout or dropped SSH session leaves the remote result uncertain; inspect
the engine before retrying a mutation. Exit zero and the operation record alone do not prove service
health: verify through `engines`, `models` and an actual request.

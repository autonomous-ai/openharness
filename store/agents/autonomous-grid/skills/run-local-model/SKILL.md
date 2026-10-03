---
name: run-local-model
description: "Details behind AGENTS.md's 'Starting a model on this computer' flow: reading `fleet models`, sizing a start, choosing file and engine, picking a model for an engine with none, what `fleet verify` checks, and where to read when unsure. Open it when a step of that flow needs more than the flow says."
---

# Run a local model — details

The flow itself is in AGENTS.md. Tags: `[run]` seen on a real machine (M1 Pro 32 GB, macOS 26.6,
2026-09-29), `[doc]` official docs (see the `engine-*` skill), `[code]` read in the tool's source.

## Purpose → settings (the only thing asked)

*Coding · Chat and writing · Reading images · Just something fast.* **Context is never below 64K**:
every model here is used by an agent whose own prompt fills a small window; Ollama's docs set the same
floor for agents [doc]. When 64K does not fit, take a smaller model, never a smaller window.

| Purpose | Context | At once | Also needs |
|---|---|---|---|
| Coding | 128K when it fits, else 64K | 1 | tool calls |
| Chat and writing, or fast | 64K | 1 | — |
| Reading images | 64K | 1 | a projector beside the file |

Thinking is off for everyday use.

## Reading `fleet models`

- `machine.accelerators[]`: a GPU counts only with `active: true` (its own tool answered). `active: false`
  comes with an `error` (e.g. no driver): say it in one line; plan no GPU engine on it.
- `machine.engines[]`: installed engines, running or not. `machine.canRun`: the kinds this hardware can
  run at all — never propose one outside it.
- `machine.memory.availableBytes`, `swapUsedBytes`: room right now. Metal and `device-info` do not see
  other apps (Metal said 25 GiB free while macOS was 11 GB into swap [run]).
- `machine.accelerators[].totalBytes`: the GPU ceiling, below total RAM on a Mac — read it here, never assume it; `device-info` reports a different figure
  there [run] — use the smaller.
- `engines[]`: answering engines and their exact `--at` URL. `openai-compatible` whose "models" are not
  models is another app: leave it alone.
- `models[]`: one entry per real file (`alsoAt` = other apps holding the same file), with `format`,
  `bytes`, `projector`, and for GGUF `contextLength`, `kvBytesPerToken`, `toolCalls`, `unsupportedTensorTypes`.

## Size

    need = weights + context × kvBytesPerToken × slots + 0.5 GB (+ projector when vision is on)

`kvBytesPerToken` matched what llama.cpp allocated exactly [run]; files of similar size needed from
20 KiB to 160 KiB per token, so never skip this. Null (latent attention): start at 64K and read the
engine's memory report. Fits when `need ≤ availableBytes + 3 GB` and ≤ the GPU ceiling (macOS moves
idle pages to swap once; swap still climbing a minute after start means too big). Too big: a smaller
file, or ask the one trade-off — "close other apps first, or a lighter model beside your work?".

## Choose the file, then the engine

Drop: `unsupportedTensorTypes` not empty (llama.cpp refuses them [run]); context below 64K; no tool
calls for coding; no projector for images; anything that does not fit. Prefer newer families, more
parameters at 4-bit over fewer at 8-bit, and mixture-of-experts models when memory allows.

| The file | Mac (Apple silicon) | Linux + active NVIDIA/AMD GPU | CPU only |
|---|---|---|---|
| served by an engine already answering | `join --at URL/v1 -m ID --advertise-as ALIAS` | same | same |
| GGUF from any app | Grid's engine (link into `~/.grid/models`) | same | same |
| MLX folder | mlx-lm (`engine-mlx-lm`) | — | — |
| Hugging Face safetensors | mlx-lm | vLLM or SGLang from the model's recipe | find a GGUF |

Grid only serves from `~/.grid/models`: its launcher keeps just the file name of `--serve` and looks
there; a projector must sit beside it [code: grid `shared/engine/launcher.py`]. A symlink costs no disk.
Never `ollama create` to reuse a file (it copies it [run]); never vLLM or SGLang on a Mac (CPU-only /
no macOS build [run]); never download a second copy only to switch engines. On Apple silicon, when a
*new* download is needed and mlx-lm or LM Studio is installed, an MLX build is sound — Ollama itself
moved its Apple engine to MLX [doc: ollama.com/blog/mlx].

On Apple silicon with mlx-lm (or LM Studio) installed, **MLX first**: when the same model exists as an
MLX folder and as a GGUF and the MLX one fits, serve the MLX one. The choice is still model-first —
never a bigger MLX model that does not fit over a smaller GGUF that does. The report names what was
passed over and why, one line each ("<model> (<format>): needs <N> GB, <M> GB free"), so "why not MLX?"
is answered before anyone asks.

## An engine installed, nothing to serve

Offer 2–3 that fit (plain name, GB, what it is good at) plus "none of these"; the download waits for
the go-ahead.
- Mac with mlx-lm or LM Studio: `"$GRID_FLEET" candidates mlx [--search WORDS] [--sort downloads|trending|recent]`
  — mlx-community models sized from their real files, cache at 64K, `fits` against the GPU ceiling.
- Linux GPU with vLLM or SGLang: pick families from [recipes.vllm.ai/llms.txt](https://recipes.vllm.ai/llms.txt)
  or the SGLang cookbook, then `fleet recipe` each; `vramMinimumGb` against the GPU decides.
- Grid's engine or Ollama with nothing: Grid's catalog (`grid-operations` step 4), pulled into Grid.
- The person names an engine outside `canRun`: say why in one line (no active GPU, not a Mac).

## This computer already on that grid

In remote mode a computer joins a grid as one identity, and Grid's `--serve` engine cannot share it: a
second model is refused with "can't join a multi-engine identity. Run `grid leave`, then re-join every
engine as external `--at <url> -m <model>`" [run]. Ask *Replace X with Y · Keep X*; never leave an
engine the person did not agree to.

## What `fleet verify` checks

Engine: **ready** (`/models` within 180 s, every 3 s), **listed**, **answer** (max_tokens 16, thinking off;
reasoning-only output fails), **tool call** (`read_file` must come back as `tool_calls`), **speed**. With
`--grid`: **relay listed** (every 10 s up to 300 s) and **relay answer** (up to 420 s, a "still waiting"
line every 15 s). Exit 0 only when all pass. Seen end to end: an mlx-lm engine joined a local grid with
`--at …/v1` in 6 s and passed all seven in 10 s; a Grid-engine GGUF passed at 19 tok/s [run].

## When unsure: read, never guess

1. `"$GRID_FLEET" recipe vllm|sglang ORG/NAME` — the official recipe for that exact model (exit 3: none).
2. `"$GRID_FLEET" model-facts ORG/NAME|DIR` — architecture, context, sampling defaults, the template's
   tool-call syntax, the authors' serve commands, and whether each engine lists the architecture
   (`listed: null` = cannot tell).
3. Agent indexes: [docs.ollama.com/llms.txt](https://docs.ollama.com/llms.txt),
   [lmstudio.ai/llms.txt](https://lmstudio.ai/llms.txt), [recipes.vllm.ai/llms.txt](https://recipes.vllm.ai/llms.txt),
   [docs.sglang.io/llms.txt](https://docs.sglang.io/llms.txt); vLLM and mlx-lm docs as raw markdown on GitHub.
4. Nothing says it: tell the person this model cannot be set up reliably here and offer the next one.

`fleet models` reads this computer only; a Harness-linked machine's disk is not visible yet.

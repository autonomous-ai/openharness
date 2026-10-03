---
name: engine-sglang
description: "Serve a Hugging Face model with SGLang on a Linux machine with an NVIDIA or AMD GPU, configured from the model's SGLang cookbook page — or, when it has none, from the model's own files — and join it to the person's fleet. Load before installing, configuring, starting or stopping SGLang."
---

# SGLang (Linux + NVIDIA CUDA or AMD ROCm)

Official sources, read 2026-09-29. Agent index: [docs.sglang.io/llms.txt](https://docs.sglang.io/llms.txt)
(every page is available as `.md`). [Cookbook](https://docs.sglang.io/cookbook/intro) ·
[Models](https://www.sglang.io/models) · [Quickstart](https://docs.sglang.io/docs/get-started/quickstart.md) ·
[Server arguments](https://docs.sglang.io/docs/advanced_features/server_arguments.md) ·
[Tool parser](https://docs.sglang.io/docs/advanced_features/tool_parser.md) ·
[Separate reasoning](https://docs.sglang.io/docs/advanced_features/separate_reasoning.md) ·
[Native API](https://docs.sglang.io/docs/basic_usage/native_api.md) ·
[Transformers fallback](https://docs.sglang.io/docs/supported-models/transformers_fallback.md) ·
source: [github.com/sgl-project/sglang](https://github.com/sgl-project/sglang)
Tested: not runnable on macOS (below); no GPU run yet. Tags: `[doc]` official source, `[run]` seen on a machine, `[?]` unverified.

## When to use it

- Linux with an NVIDIA GPU of compute capability 8.0 or newer (A10, A100, L4, L40S, H100), Python ≥ 3.10 [doc];
  AMD GPUs, Intel Xeon CPUs and TPUs have their own guides [doc]. Hugging Face models, many requests at once,
  several GPUs.
- **Never on macOS.** The current release ships Linux wheels only and requires CUDA builds of its kernels;
  on a Mac the installer falls back to an old release whose server does not import [run].
- A GGUF file for one person: Grid's own engine serves it with nothing to install.

## 1. The cookbook page — `"$GRID_FLEET" recipe sglang ORG/NAME`

Finds the model family's page through `llms.txt` (the most specific family name the model name starts
with) and prints: `source` (the page), `installation` (its version requirement — some families need a
release or the main branch — and install commands), `serveCommands` (the page's own launch commands per
GPU type), `toolCallParsers`, `reasoningParsers`, and `configurationTips`. Read the page itself for
anything else. Exit code 3 means no page: go to step 2.

## 2. No cookbook page — read the model: `"$GRID_FLEET" model-facts ORG/NAME`

1. `support.sglang.listed: true` means SGLang's model registry has the architecture; `null` means this
   check cannot tell. SGLang can run most decoder models through `--model-impl transformers` [doc] — a test,
   not a promise.
2. `modelCard.serveCommands` and parsers: the model authors' own SGLang command. Use it when present.
3. Otherwise `--tool-call-parser auto` and `--reasoning-parser auto`: SGLang detects both from the model's
   chat template [doc]. Then the tool-call acceptance check decides; if it fails, say so and stop — do not
   cycle through parser names.
4. `contextLength` must be ≥ 65536.

## Install and version

- Slow step, ask first. `uv pip install --prerelease=allow sglang` [doc]; a family whose cookbook page asks
  for the main branch: `uv pip install --prerelease=allow 'git+https://github.com/sgl-project/sglang.git#subdirectory=python'` [doc].
  `OSError: CUDA_HOME environment variable is not set` → `export CUDA_HOME=/usr/local/cuda-<version>` [doc].
- Docker: `lmsysorg/sglang:latest` (NVIDIA), `lmsysorg/sglang-rocm:<tag>` (AMD, tag per GPU generation on
  the cookbook page) [doc], run with `--gpus all --shm-size 32g --ipc=host -p 127.0.0.1:P:30000
  -v ~/.cache/huggingface:/root/.cache/huggingface` [doc].

## Common configs (the cookbook's flags win)

Each adds the parsers from step 1 or 2, `--host 127.0.0.1 --port P` and `--context-length` of at least 65536
(the default is the model's own maximum [doc]).

| Case | Add |
|---|---|
| One GPU, one agent | `--max-running-requests 4` |
| One GPU, many people | leave `--max-running-requests` to SGLang |
| Several GPUs, one machine | `--tp-size <GPU count>` [doc] |
| Out of memory | lower `--mem-fraction-static` (weights plus KV pool share) [doc]; `--kv-cache-dtype fp8_e4m3` [doc] |

## Start, ready, join

    "$GRID_FLEET" serve sglang-P --env HF_HUB_OFFLINE=1 -- ~/.grid/envs/sglang/bin/sglang serve \
      --model-path <model id or snapshot dir> --served-model-name <id> --host 127.0.0.1 --port P <flags>

(`python3 -m sglang.launch_server` takes the same arguments [doc].) Defaults are 127.0.0.1 and port 30000 [doc].
Install into `~/.grid/envs/sglang` so `fleet models` finds it; `fleet serve` keeps it alive after your shell
returns (log `run/sglang-P.log`).

- Verify: `"$GRID_FLEET" verify --at http://127.0.0.1:P/v1 --model <id> --kind sglang` (bounded, narrated).
- Ready: the log says `The server is fired up and ready to roll!` [doc]; `GET /health` → 200;
  `GET /health_generate` generates one token [doc]; `GET /v1/models` lists `<id>`; one bounded answer; one tool call.
- Join: `"$GRID_FLEET" run -- join GRID --at http://127.0.0.1:P/v1 -m <id> --advertise-as ALIAS`. Grid's detector has
  no SGLang probe and would mislabel it on 8000 or 8080 [run], so always `--at`, always with `/v1`.
- Thinking off per request: `"chat_template_kwargs": {"enable_thinking": false}` where the cookbook page shows it [doc].

## Stop

`"$GRID_FLEET" stop sglang-P` (or `docker stop` your container); confirm the port is free.

## Known failures → what to do

| Sign | Do |
|---|---|
| out of memory while serving | lower `--mem-fraction-static` [doc] |
| no `tool_calls` | the cookbook's `--tool-call-parser`, else `auto` [doc]; still none → report |
| a CUDA crash, a multi-GPU hang, a production incident | read SGLang's own maintainer skills: `.agents/skills/debug-cuda-crash`, `debug-distributed-hang`, `sglang-prod-incident-triage` (`SKILL.md` in each) at `https://raw.githubusercontent.com/sgl-project/sglang/main/` |
| 404 on `/models` | the `--at` URL lacks `/v1` |

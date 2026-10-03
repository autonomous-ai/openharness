---
name: engine-vllm
description: "Serve a Hugging Face model with vLLM on a Linux machine with an NVIDIA or AMD GPU, configured from the model's official vLLM recipe — or, when it has none, from the model's own files — and join it to the person's fleet. Load before installing, configuring, starting or stopping vLLM."
---

# vLLM (Linux + NVIDIA CUDA or AMD ROCm)

Official sources, read 2026-09-29. Agent index: [recipes.vllm.ai/llms.txt](https://recipes.vllm.ai/llms.txt).
Reference docs as raw markdown under `https://raw.githubusercontent.com/vllm-project/vllm/main/docs/`:
[OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/) (`serving/online_serving/openai_compatible_server.md`) ·
[Tool calling](https://docs.vllm.ai/en/latest/features/tool_calling/) (`features/tool_calling.md`) ·
[Reasoning outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/) (`features/reasoning_outputs.md`) ·
[Supported models](https://docs.vllm.ai/en/latest/models/supported_models/) (`models/supported_models.md`) ·
[GPU install](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/) · [Docker](https://docs.vllm.ai/en/latest/deployment/docker/) ·
[Optimization](https://docs.vllm.ai/en/latest/configuration/optimization/) · [Conserving memory](https://docs.vllm.ai/en/latest/configuration/conserving_memory/)
Tested: only vLLM 0.11.0 on an Apple-silicon Mac (CPU backend), 2026-09-29 — no GPU run yet.
Tags: `[doc]` official source above, `[run]` seen on the tested machine, `[?]` unverified.

## When to use it

- Linux with an NVIDIA GPU of compute capability 7.5 or newer [doc], or an AMD GPU with ROCm [doc], and a
  Hugging Face model (safetensors, FP8, AWQ…). vLLM is built for many requests at once and for models split
  across several GPUs.
- A GGUF file for one person on one GPU: Grid's own engine serves it with nothing to install.
- **Not on a Mac.** There it runs on the CPU only, slowly (26 tokens in 2.3 s for a 0.5B model), and needed
  pinned `transformers<5`, `--dtype float32` for JSON output and a batched-token limit to start [run].

## 1. The recipe — `"$GRID_FLEET" recipe vllm ORG/NAME`

Reads [recipes.vllm.ai](https://recipes.vllm.ai/) live (`models.json`, then `<ORG>/<NAME>.json`) and prints:

| Field | Use |
|---|---|
| `minVersion` | the installed `vllm --version` must be at least this |
| `baseArgs`, `baseEnv` | always |
| `features.tool_calling.args`, `features.reasoning.args` | always for an agent |
| `features.*` with `optIn: true` | only on purpose (faster decoding, text only to free memory, longer context) |
| `variants.<name>` | pick by `vramMinimumGb` against the GPU; a variant can carry its own `modelId` and `extraArgs` |
| `recommended` | the site's reference command and Docker image for its reference hardware |
| `install` | the recipe's own install steps, including any pinned extras |
| `guide` | prose; its **Troubleshooting** holds model-specific fixes |

The recipe beats the generic docs: a family's generic parser entry and a model's recipe can name different
parsers [doc]. Exit code 3 means there is no recipe: go to step 2.

## 2. No recipe — read the model: `"$GRID_FLEET" model-facts ORG/NAME`

1. `support.vllm.listed` must be `true` (its architecture is in vLLM's supported-models list). `false`:
   the Transformers backend (`--model-impl transformers`) may still run it [doc] — a test, not a promise.
2. `modelCard.serveCommands` / `toolCallParsers` / `reasoningParsers`: the model authors' own vLLM command.
   Use it when present.
3. Otherwise match `chatTemplate.toolSyntax` against the parser descriptions in `features/tool_calling.md`
   (each parser documents the output format it reads) and, when `chatTemplate.thinking`, pick the reasoning
   parser from the table in `features/reasoning_outputs.md` [doc]. Quote the doc line you matched.
4. `contextLength` must be ≥ 65536. Sampling defaults come from the model's `generation_config.json`
   automatically [doc]; leave them.
5. No match in the docs: say so and stop — do not cycle through parsers until one passes.

## Install and version

- Slow step, ask first. Venv: `uv venv && uv pip install -U vllm --torch-backend=auto` [doc]; pin with
  `"vllm==X.Y.Z"` at or above the recipe's `minVersion`. Wheels target CUDA 12.9 by default, builds for 12.8
  and 13.0 exist, Blackwell needs CUDA ≥ 12.8 [doc]. AMD: `--extra-index-url https://wheels.vllm.ai/rocm`
  (Python 3.12, ROCm 7.0, glibc ≥ 2.35) [doc]. Check the GPU and driver with `nvidia-smi`.
- Docker: `vllm/vllm-openai` (NVIDIA), `vllm/vllm-openai-rocm` (AMD) [doc], with
  `--gpus all --ipc=host -p 127.0.0.1:P:8000 -v ~/.cache/huggingface:/root/.cache/huggingface` [doc].

## Common configs (the recipe's flags win)

Each adds the recipe's (or step 2's) tool and reasoning flags, `--host 127.0.0.1 --port P` and a
`--max-model-len` of at least 65536.

| Case | Add |
|---|---|
| One GPU, one agent | `--max-model-len 131072 --max-num-seqs 4 --enable-prefix-caching` |
| One GPU, many people | `--max-model-len 65536 --enable-prefix-caching` (`max-num-seqs` left to vLLM) |
| Several GPUs, one machine | `--tensor-parallel-size <GPU count>` [doc] |
| Memory is tight | the recipe's FP8 variant, `--kv-cache-dtype fp8`, fewer `--max-num-seqs` [doc] |

## Start, ready, join

    "$GRID_FLEET" serve vllm-P --env HF_HUB_OFFLINE=1 -- ~/.grid/envs/vllm/bin/vllm serve <model id or snapshot dir> \
      --served-model-name <id> <flags>

(Install into `~/.grid/envs/vllm` so `fleet models` finds it; `fleet serve` keeps it alive after your shell
returns; log `run/vllm-P.log`.)

- Verify: `"$GRID_FLEET" verify --at http://127.0.0.1:P/v1 --model <id> --kind vllm` (bounded, narrated).
- Ready: PID alive; log shows `Application startup complete.` [run] (minutes for a big model); `GET /health`
  → 200 and `GET /v1/models` lists `<id>` [run]; one bounded answer; one tool call.
- Join: `"$GRID_FLEET" run -- join GRID --at http://127.0.0.1:P/v1 -m <id> --advertise-as ALIAS`. `/v1` is required —
  without it `/models` and `/chat/completions` answer 404 [run]. `--api-key` guards only `/v1` routes [doc].
- Thinking off for everyday use: the recipe's guide names the flag when there is one
  (`--default-chat-template-kwargs '{"enable_thinking": false}'` in the recipes that document it [doc]).

## Knobs

`--gpu-memory-utilization` (share of GPU memory pre-allocated for weights plus cache), `--max-model-len`,
`--max-num-seqs`, `--max-num-batched-tokens`, `--kv-cache-dtype fp8`, `--enforce-eager` (fastest start,
slower serving), `--tensor-parallel-size` [doc].

## Stop

`"$GRID_FLEET" stop vllm-P` (or `docker stop` the container you started); confirm the port is free.

## Known failures → what to do

| Sign | Do |
|---|---|
| "preempted … not enough KV cache space" | raise `--gpu-memory-utilization`, lower `--max-num-seqs`, or more tensor parallel [doc] |
| CUDA out of memory at start | FP8 variant, `--kv-cache-dtype fp8`, fewer sequences — context stays ≥ 65536 |
| "max_num_batched_tokens … smaller than max_model_len" | raise `--max-num-batched-tokens` to at least the context [doc][run] |
| an error the recipe's guide names | apply the guide's fix exactly [doc] |
| tokenizer `AttributeError` after install | transformers newer than that vLLM supports (0.11.0 needed `transformers<5` [run]); use a vLLM at or above the recipe minimum |
| no `tool_calls` | `--enable-auto-tool-choice` plus the recipe's parser [doc][run] |
| 404 on `/models` | the `--at` URL lacks `/v1` [run] |
| "CUDA error: an illegal memory access" | read vLLM's own maintainer skill `.agents/skills/debug-ima/SKILL.md` at `https://raw.githubusercontent.com/vllm-project/vllm/main/` |

---
name: engine-mlx-lm
description: "Serve an MLX or Hugging Face safetensors model already on this Mac with mlx-lm's server and join it to the person's fleet. Load before installing, starting or stopping mlx-lm, or when `fleet models` lists an `mlx` or `safetensors` model on Apple silicon."
---

# mlx-lm server (Apple silicon)

Official docs, read 2026-09-29:
[SERVER.md](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md) ·
[server.py (flags, routes)](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py) ·
[README](https://github.com/ml-explore/mlx-lm/blob/main/README.md) ·
[Hugging Face cache variables](https://huggingface.co/docs/huggingface_hub/package_reference/environment_variables) ·
[Hugging Face cache layout](https://huggingface.co/docs/huggingface_hub/guides/manage-cache)
Tested: mlx-lm 0.31.3 (the latest on PyPI that day), uv venv with Python 3.12, MacBook Pro M1 Pro 32 GB,
macOS 26.6, 2026-09-29. Tags: `[doc]` official source above, `[run]` seen on the tested machine, `[?]` unverified.

## When to use it

- `fleet models` lists a model with `format: mlx` (an MLX-converted folder: `config.json` with a `quantization` block) on
  a Mac: this is its engine. Grid's own engine reads only GGUF.
- `format: safetensors` (a plain Hugging Face model) on a Mac: mlx-lm served one directly [run]; vLLM and
  SGLang are for NVIDIA/AMD servers.
- If LM Studio is installed and already holds the MLX model, LM Studio can serve it with nothing new
  installed (`engine-lm-studio`). If a GGUF of the same model exists, prefer Grid's engine.
- The docs call the server "not recommended for production" (basic security only) [doc]: bind 127.0.0.1.
- A GGUF of the same model already on disk is served by Grid's engine; do not download an MLX copy of it.
- mlx-lm installed and no MLX model yet: `"$GRID_FLEET" candidates mlx` (see `run-local-model`).
- Verified end to end [run]: started offline on a local snapshot, `fleet verify` passed ready, answer,
  tool call and speed; `grid join … --at http://127.0.0.1:P/v1 -m <snapshot path> --advertise-as NAME`
  joined in 6 s and the relay answered through the grid.

## Where its models live / how to list them

- Hugging Face cache: `$HF_HUB_CACHE`, else `$HF_HOME/hub`, else `~/.cache/huggingface/hub` [doc].
  Layout `models--<org>--<name>/snapshots/<commit>/` with files linked into `blobs/` [doc].
- An MLX folder has `config.json` with a `quantization` block (`bits`, `group_size`) or sits in an
  `mlx-community` repo; a plain model has `config.json` and `*.safetensors` without it. `fleet models`
  reports both, including folders outside the cache (`~/models`, LM Studio's folder).
- Server side: `GET /v1/models` lists every cached repo as `org/name` plus the served path [doc][run].

## Installed? Running?

- Installed: `fleet models` lists `mlx-lm` under installed engines — on `PATH` or in `~/.grid/envs/mlx-lm`.
  Install there and nowhere else, never into the system Python (a slow step: ask for the go-ahead first):
  `uv venv --python 3.12 ~/.grid/envs/mlx-lm && uv pip install --python ~/.grid/envs/mlx-lm/bin/python mlx-lm`
  [run] (`pip install mlx-lm` or `conda install -c conda-forge mlx-lm` [doc]). ENV below is that folder.
- Running: `fleet models` → an engine on 8080 labelled `openai-compatible` (it has no `owned_by`) whose
  models are Hugging Face ids [run].

## Start an already-downloaded model (never downloads)

Port P from outside `machine.listeningPorts` (8090 was taken by another app during testing [run]):

    "$GRID_FLEET" serve mlx-P --env HF_HUB_OFFLINE=1 -- ENV/bin/mlx_lm.server \
      --model <snapshot dir or cached org/name> --host 127.0.0.1 --port P --max-tokens 32768 \
      --chat-template-args '{"enable_thinking":false}'

- `fleet serve` starts it in its own session, so it outlives your shell; log in `run/mlx-P.log`, PID in
  `run/mlx-P.pid`. Under the agent's shell a plain `nohup … &` died with an empty log when the command
  returned, while a `fleet serve` process was still alive in a later command [run]. Never `launchd`.

- `HF_HUB_OFFLINE=1`: no HTTP calls, cached files only, an error if missing [doc]. Without it an uncached
  model is downloaded from Hugging Face [doc].
- `--max-tokens` defaults to 512 [doc]: a request without its own limit would stop mid-answer.
- Sampling defaults are greedy (`--temp 0.0`, `--top-p 1.0`) [doc]; set `--temp`/`--top-p`/`--top-k` from
  the model card's recommended settings.
- Ready log: `Starting httpd at 127.0.0.1 on port P...` [run].
- There is no context size to set: the cache grows with the conversation, up to the model's
  `max_position_embeddings`. Check that it is ≥ 65536 and that weights + 64K of cache fit before starting.

## Ready means

Run `"$GRID_FLEET" verify --at http://127.0.0.1:P/v1 --model <path or id> --kind mlx-lm` right after
`serve` — it waits for loading itself; no `sleep`, `curl` or log reading first. What it checks:

1. The PID is alive. 2. `GET /health` → `{"status": "ok"}` [run] (in the source, not in SERVER.md [doc]).
3. `GET /v1/models` → 200 [doc]. 4. One bounded `/v1/chat/completions` request, `max_tokens` 16, `model`
   = the path or id you started with → non-empty `content` [run].

## Join Harness Compute

    "$GRID_FLEET" run -- join GRID --at http://127.0.0.1:P/v1 -m <path or id you started with> --advertise-as ALIAS

`/v1` is required: `/models` without it answers 404 (only chat accepts both) [doc][run]. Without
`--advertise-as` the picker shows the whole snapshot path, and `verify --alias` waits five minutes for a
name that never appears [run]. Grid's detector labels anything on 8080 as `mlx`, whatever it is [run].

## Tool calls, JSON output, thinking

- Tools: passed to the chat template; when the tokenizer has no tool-calling support the server logs
  "Received tools but model does not support tool calling" and answers without calls [doc]. Grid's probe
  reported no tool calls for a 0.5B 4-bit model whose template does mention tools [run]: run the tool
  check before offering a model for coding.
- Thinking: `--chat-template-args '{"enable_thinking":false}'` at start, or `chat_template_kwargs` per
  request [doc]. Reasoning text comes back in `message.reasoning` [doc].
- JSON: Grid's probe reported JSON object and schema modes as supported [run].

## Memory and speed knobs

| Flag | Default | Use |
|---|---|---|
| `--decode-concurrency` | 32 | requests decoded together [doc] |
| `--prompt-concurrency` | 8 | prompts prefilled together [doc] |
| `--prefill-step-size` | 2048 | lower it if prefill spikes memory [doc] |
| `--prompt-cache-size` / `--prompt-cache-bytes` | 10 caches / unlimited | cap memory kept for reuse [doc] |
| `--kv-bits 4\|8` | off | smaller cache for long context, but one request at a time [doc]; newer than 0.31.3 [run: absent from its help] |
| `--draft-model`, `--num-draft-tokens` | none, 3 | speculative decoding [doc] |

## Stop

`"$GRID_FLEET" stop mlx-P`, then confirm P is gone from `fleet models --summary` (ports in use).

## Known failures → what to do

| Sign | Do |
|---|---|
| `OfflineModeIsEnabled` or file-not-found at start | the model is not fully cached; offer the download as a slow step [doc] |
| answers stop around 512 tokens | start with `--max-tokens` [doc] |
| empty `content`, text in `reasoning` | disable thinking in the chat template [doc] |
| "Received tools but model does not support tool calling" | not a coding model; pick another [doc] |
| address already in use | pick another port; never stop the other process [run] |

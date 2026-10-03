---
name: engine-ollama
description: "Reuse what Ollama already has on this computer: adopt a running Ollama server into the person's fleet, or serve an Ollama-downloaded model without Ollama. Load before touching Ollama, its models or its settings."
---

# Ollama

Official docs, read 2026-09-29 (source files in github.com/ollama/ollama/tree/main/docs):
[FAQ](https://docs.ollama.com/faq) · [Context length](https://docs.ollama.com/context-length) ·
[OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) ·
[Thinking](https://docs.ollama.com/capabilities/thinking) · [CLI](https://docs.ollama.com/cli) ·
[macOS](https://docs.ollama.com/macos) · [Linux](https://docs.ollama.com/linux) · [Import](https://docs.ollama.com/import) ·
[API reference](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml)
Tested: Ollama 0.34.4 (`brew install ollama`), MacBook Pro M1 Pro 32 GB, macOS 26.6, 2026-09-29.
Tags: `[doc]` official page above, `[run]` seen on the tested machine, `[?]` unverified.

## When to use it

- **A model in Ollama's store** (`fleet models` → START WITH `ollama`): Ollama runs it. It downloaded the
  file and ships its own engine for new architectures, which Grid's engine can refuse [?].
  - **Answering**: adopt it as it is; it is the person's app, so never restart or reconfigure it.
  - **`(start it)`**: start one yourself (below). An Ollama that is off is the normal case, not a reason
    to switch engines [run].
- **Ollama not installed**: its blobs are GGUF files, so `fleet models` names Grid's llama.cpp — link the
  blob into `~/.grid/models` and `join --serve` [run].
- A GGUF from another app enters Ollama only by `ollama create` (a `Modelfile` with `FROM <file>`), and
  that **copies the whole file** into Ollama's store (+624 MB for a 640 MB GGUF) [run]. So never do it
  unasked; when the person wants Ollama and it has nothing suitable, offer it with the size it adds on
  disk, beside the no-copy choice (the file with its own app). Never `ollama pull` without the
  go-ahead: it downloads.

## MLX inside Ollama (Apple silicon)

Since 0.19 Ollama has its own MLX engine on Apple silicon, announced as a preview on 2026-03-30
([blog](https://ollama.com/blog/mlx)) [doc]. It runs on MLX only the architectures registered in its
source — read the list live, never from memory:
`https://raw.githubusercontent.com/ollama/ollama/main/mlxrunner/model/architectures/architectures.go`
(one import per architecture folder under `mlxrunner/model/`) [doc]. Compare with `model_type` from
`fleet model-facts`. Everything else keeps running on Ollama's GGML engine. The announced models are
Ollama-library tags in their own quantization, and the post asks for more than 32 GB of unified memory [doc];
importing other MLX models is not yet documented [?].

## Where its models live / how to list them

- Default dir: macOS `~/.ollama/models`, Linux service `/usr/share/ollama/.ollama/models`, Windows
  `C:\Users\%username%\.ollama\models`; `OLLAMA_MODELS` moves it [doc].
- Layout: `manifests/registry.ollama.ai/library/<model>/<tag>` (a JSON file) and `blobs/sha256-<hex>`;
  the manifest layer `application/vnd.ollama.image.model` names the weights blob, a GGUF [run]. Model id is
  `<model>:<tag>`; other namespaces are `<user>/<model>:<tag>` [?].
- `fleet models` already reads the manifests: entries with `source: ollama`, the blob path, and
  `alsoAt` when another app links the same file [run].
- From a running server: `GET /api/tags` (downloaded), `GET /api/ps` (loaded, with `context_length` and
  `size_vram`) [doc], `GET /v1/models` (`owned_by` is the Ollama user, `library` by default) [doc][run].
  `POST /api/show {"model":ID}` lists `capabilities` (completion, tools, thinking, vision) [doc].

## Installed? Running?

- Installed: `command -v ollama` or `/Applications/Ollama.app`. `ollama --version` with no server prints
  "Warning: could not connect to a running Ollama instance" and the client version [run].
- The macOS app starts the server at login (a login item) [doc]; `brew install ollama` starts nothing [run];
  the Linux installer creates a systemd service `ollama` [doc].
- Running: `fleet models` → `engines[]` with `kind: ollama`. Default bind is 127.0.0.1:11434 [doc].

## Start an already-downloaded model (Ollama not running, or running with too small a window)

Port P from outside `machine.listeningPorts`, and never 11434: that is the Ollama app's own, and it must
still start when the person opens it [run]. The port is set only through `OLLAMA_HOST` (no `--port`) [doc]:

    "$GRID_FLEET" serve ollama-P --env OLLAMA_HOST=127.0.0.1:P --env OLLAMA_CONTEXT_LENGTH=65536 -- ollama serve

(`fleet serve` keeps it alive after your shell returns; log `run/ollama-P.log`, PID `run/ollama-P.pid`.)

- Foreground process; the log says `Listening on 127.0.0.1:P (version …)` when ready [run].
- Every other `ollama` command must carry the same `OLLAMA_HOST`, or it talks to 11434 [run].
- Nothing downloads unless you pull; the model loads on its first request [run].
- Context: the default depends on GPU memory — 4K below 24 GiB, 32K at 24–48 GiB, 256K at 48 GiB or
  more [doc] (the FAQ still says 4096 [doc]). Agents need at least 64000 [doc], and every model here is
  used by an agent: always set `OLLAMA_CONTEXT_LENGTH` to 65536 or more. The OpenAI API cannot set
  context per request [doc].

## Ready means

Run `"$GRID_FLEET" verify --at http://127.0.0.1:P/v1 --model <model>:<tag> --kind ollama` — it performs
these checks with deadlines and prints each one. What it checks:

1. The PID is alive. 2. `GET /` answers "Ollama is running" [run]. 3. `GET /api/version` → 200 [run].
4. One bounded request through `/v1/chat/completions` with the model id, `max_tokens` 16 and
   `"reasoning_effort":"none"` for a thinking model → non-empty `content` [doc][run].
5. `GET /api/ps` shows the model with `context_length` ≥ 65536 [doc]. `FAIL context` means this Ollama
   runs every model with that window [run]: `leave` the grid, then leave their Ollama as it is and start a
   second one with `OLLAMA_CONTEXT_LENGTH` (above) [run].

## Join Harness Compute

    "$GRID_FLEET" run -- join GRID --at http://127.0.0.1:P/v1 -m <model>:<tag> --advertise-as ALIAS

`/v1` is required: without it `/models` and `/chat/completions` answer 404, and Grid's capability probe
records JSON output as unsupported without any error [run]. Grid's own detector finds Ollama only on
11434 [run].

## Tool calls, JSON output, thinking

- `/v1/chat/completions` supports `tools`, `response_format` and `reasoning_effort` [doc].
  `reasoning_effort: "none"` asks for no thinking; the native API uses `"think": false` [doc].
- A model's thinking values and default: `/api/show` → `thinking.values`, `thinking.default` [doc].
- Tool support is per model: check `capabilities` contains `tools` before offering it for coding [doc].

## Memory and speed knobs (server environment, apply to all models)

| Variable | Default | Effect |
|---|---|---|
| `OLLAMA_CONTEXT_LENGTH` | by GPU memory (above) | context for every model [doc] |
| `OLLAMA_NUM_PARALLEL` | 1 | requests at once per model; memory scales with parallel × context [doc] |
| `OLLAMA_KV_CACHE_TYPE` | `f16` | `q8_0` ≈ half the KV memory, `q4_0` ≈ a quarter; needs flash attention [doc] |
| `OLLAMA_FLASH_ATTENTION` | automatic | `1` forces on, `0` off [doc] |
| `OLLAMA_KEEP_ALIVE` | 5m | how long an idle model stays loaded [doc] |
| `OLLAMA_MAX_LOADED_MODELS` | 3 × GPUs (3 on CPU) | models loaded at once [doc] |

`brew services start ollama` sets `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` [run: brew caveat].
`ollama ps` → `PROCESSOR` must read `100% GPU`; a CPU/GPU split is slow [doc].

## Stop

- A server you started: `"$GRID_FLEET" stop ollama-P`.
- Unload one model but keep the server: `OLLAMA_HOST=… ollama stop <model>` [doc].
- The person's app or service: ask first. macOS app: quit from the menu bar; Linux: `sudo systemctl stop ollama` [doc].

## Known failures → what to do

| Sign | Do |
|---|---|
| 404 on `/models` or `/chat/completions` | the URL lacks `/v1` [run] |
| `content` empty, `thinking` full | add `reasoning_effort: "none"` [doc] |
| `/api/ps` context below 65536 | the person's Ollama runs its default (4K or 32K); start a second Ollama with `OLLAMA_CONTEXT_LENGTH` instead of changing their app |
| 503 "server is overloaded" | queue full (`OLLAMA_MAX_QUEUE`, default 512) [doc]; wait, do not retry in a loop |
| `PROCESSOR` shows CPU share | model plus context does not fit the GPU; smaller context or model [doc] |
| model not found | not downloaded; offer the download as a slow step, never pull silently |

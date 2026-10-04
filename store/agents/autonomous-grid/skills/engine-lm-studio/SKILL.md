---
name: engine-lm-studio
description: "Reuse what LM Studio already has on this computer through its `lms` CLI: adopt its running server into the person's fleet, serve its MLX models, or serve its GGUF files without it. Load before touching LM Studio, its models or its server."
---

# LM Studio (`lms` CLI, no clicks)

Official docs, read 2026-09-29 (source files in github.com/lmstudio-ai/docs):
[App, llmster and lms](https://lmstudio.ai/docs/app/basics/lmstudio-vs-llmster-vs-lms) ·
[Headless](https://lmstudio.ai/docs/developer/core/headless) · [lms server start](https://lmstudio.ai/docs/cli/serve/server-start) ·
[lms server stop](https://lmstudio.ai/docs/cli/serve/server-stop) · [lms load](https://lmstudio.ai/docs/cli/local-models/load) ·
[lms import](https://lmstudio.ai/docs/cli/local-models/import) · [lms daemon up/down](https://lmstudio.ai/docs/cli/daemon/daemon-up) ·
[Idle TTL](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict) · [OpenAI compatibility](https://lmstudio.ai/docs/developer/openai-compat) ·
[Tools](https://lmstudio.ai/docs/developer/openai-compat/tools) · [Structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output) ·
[Import models](https://lmstudio.ai/docs/app/advanced/import-model) · [Server settings](https://lmstudio.ai/docs/developer/core/server/settings)
Tested: LM Studio 0.4.25 (`brew install --cask lm-studio`), MacBook Pro M1 Pro 32 GB, macOS 26.6, 2026-09-29.
Tags: `[doc]` official page above, `[run]` seen on the tested machine, `[?]` unverified.

> ⚠️ **`lms` commands are writes, not probes.** Every `lms` command — `lms ls --json`, `lms server status`,
> `lms ps`, `lms get`, `lms load`/`lms unload`, as well as `lms server start` / `lms daemon up` — wakes
> LM Studio's service if it is stopped and runs it as `LM Studio --run-as-service` (`Waking up LM Studio
> service...`) [doc][run]. The person may have closed it on purpose, so never run an `lms` command just to
> look. To read what LM Studio has, or whether its server is up, use `"$GRID_FLEET" models` (it reads the
> folders on disk and lists an answering server by its port, starting nothing) and, to confirm an already-up
> server, `"$GRID_FLEET" verify`. Only run `lms` when the task deliberately starts, loads or unloads LM
> Studio, and say what you are about to wake.

## When to use it

- **A model in LM Studio's folder**, GGUF or MLX (`fleet models` → START WITH `lm-studio`): LM Studio runs
  it, because it downloaded it and loads it.
  - **Its server answering**: adopt it, but load the model yourself with a 64K+ context (below) — a model
    it loads on demand gets 8192 [run], too small for an agent.
  - **`(start it)`**: start its server yourself (below); an LM Studio that is off is the normal case, not
    a reason to switch engines.
- **An MLX model elsewhere and mlx-lm not installed**: LM Studio runs MLX on Apple silicon (its
  structured output uses Outlines for MLX [doc]), so use it instead of installing anything.
- Never install LM Studio just to serve a model: Grid's engine covers GGUF, mlx-lm covers MLX.

## Where its models live / how to list them

- `~/.lmstudio/models/<publisher>/<model>/<file>` — it keeps Hugging Face's layout [doc]. The folder can be
  moved in the app's My Models tab [doc]; no documented setting file or env var [?]. Older versions used
  `~/.cache/lm-studio/models` [?]. `fleet models` scans both.
- **To read it without waking it, run `"$GRID_FLEET" models`** (the same command you already use for every
  engine). It reads `~/.lmstudio/models` on disk and, for a server already answering, lists it as
  `kind: lm-studio` on its port. Nothing is started.
- `lms ls --json` → `modelKey`, `path`, `format` (gguf/mlx), `sizeBytes` [run] — **only when its service is
  already running**; the `lms` command itself wakes LM Studio when it is stopped (see the warning above),
  never run it just to look. Keys prefix-match: a short key matched two downloaded models and loaded "the
  first one" [run] — always pass the exact key.
- A fresh install holds only an embedding model, no chat model [run].

## Installed? Running?

- App: `/Applications/LM Studio.app`. `lms` lives in `~/.lmstudio/bin` and appears only after the app ran
  once [run]. Headless servers use **llmster** instead of the app: `curl -fsSL https://lmstudio.ai/install.sh | bash` [doc].
- **To tell whether it is running, read `"$GRID_FLEET" models`, not `lms`.** A running server answers its
  port and is listed as `kind: lm-studio` (its `owned_by` is `organization_owner` [run]); an installed-but-
  off one shows its `lm-studio` engine row and its model files, but no server row. `fleet models` never
  starts anything.
- `lms server status` → "The server is not running." or its port [run] — but it is an `lms` command and
  wakes the service when it is stopped, so run it only when you intend the service to be (or become)
  running. Launching the app does not start the server [run].

## Start an already-downloaded model

Port P from outside `machine.listeningPorts`. Always `--port`: without it the last used port is reused [doc].

    export PATH="$HOME/.lmstudio/bin:$PATH"
    lms server start --port P --bind 127.0.0.1           # starts LM Studio in the background if needed [doc][run]
    lms load <exact key> --estimate-only --context-length 65536 --gpu max -y   # fits? [doc][run]
    lms load <exact key> --context-length 65536 --gpu max --identifier <id> -y

- With the app closed, `server start` printed "Waking up LM Studio service..." and was up in 4 s; it runs
  the app as `LM Studio --run-as-service`, with no window [run]. It returns at once (not a foreground process).
- `--estimate-only` prints GPU and total memory for that context and whether guardrails allow it [doc][run].
- A model loaded with `lms load` has no idle timer and stays until unloaded [doc]; on-demand loads unload
  after 60 minutes idle [doc]. Nothing downloads on load [run].

## Ready means

The service is either already up (a port answers, listed by `"$GRID_FLEET" models` as `kind: lm-studio`) or
you just started it. Run `"$GRID_FLEET" verify --at http://127.0.0.1:P/v1 --model <id> --kind lm-studio` —
it performs the request checks with deadlines and prints each one. The `lms`-free confirmations (they talk
straight to `/v1` and never wake anything):
1. `GET http://127.0.0.1:P/v1/models` lists `<id>` [doc][run]. 2. `GET http://127.0.0.1:P/api/v0/models`
reports `<id>` loaded with ≥ 65536 [run]. 3. One bounded `/v1/chat/completions` request with `model: <id>`,
`max_tokens` 16 → non-empty `content` [run].
Only once you deliberately opened the service, `lms server status` shows port P [run] and `lms ps` shows
`<id>` with CONTEXT ≥ 65536 [run].
A 401 means the person turned on "Require Authentication" [doc]: do not change their setting; say so and
serve the file with Grid's engine instead.

## Join Harness Compute

    "$GRID_FLEET" run -- join GRID --at http://127.0.0.1:P/v1 -m <id> --advertise-as ALIAS

`/v1` is required: with the bare root, Grid's capability probe records structured output as unsupported [run].
Grid's own detector finds LM Studio only on 1234 [run].

## Tool calls, JSON output, thinking

- Tools: `tools` on `/v1/chat/completions` and `/v1/responses`, OpenAI format [doc]. Grid's probe: tools yes [run].
- Structured output: `response_format` with `json_schema` [doc]; GGUF uses llama.cpp grammars, MLX uses
  Outlines [doc]. Grid's probe: json_schema yes, json_object no [run].
- Thinking control through the OpenAI endpoint: not documented [?]. Check `content` in the ready request.

## Memory and speed knobs

`--context-length` (≥ 65536 here), `--gpu max|off|0–1` (automatic when omitted) [doc], `--ttl <seconds>` [doc],
`--parallel <n>` (default 4 on this build [run]), `--speculative-draft-mtp` for models with MTP layers [run: in help].

## Stop

- Your model: `lms unload <id>` [doc]. Your server: `lms server stop` [doc] — the background service keeps running [run].
- The service you woke: `lms daemon down` stops llmster only, not the app [doc]; the app service ends with
  `osascript -e 'quit app "LM Studio"'` [run].
- If LM Studio was running before you came, unload only your model and leave the rest as it was.

## Known failures → what to do

| Sign | Do |
|---|---|
| "2 models match the provided model key" | use the exact `modelKey` from `lms ls --json` [run] |
| CONTEXT 8192 in `lms ps` | the model was loaded on demand; unload it and `lms load` with `--context-length 65536` [run] |
| `lms get … -y` shows a spinner forever | it downloads in the background [run]; never start a download without the go-ahead |
| a foreign GGUF must appear in LM Studio | `lms import -l -y --user-repo <user>/<repo> FILE.gguf`: **without `-l` it moves the file** [doc]; the file name must end in `.gguf` and the link must point at the real file, not a temp copy [run] |
| 401 from `/v1/models` | authentication is on in the person's settings [doc]; do not turn it off |
| a model already on disk is not in `lms ls` | no download: an **MLX folder** is symlinked as `~/.lmstudio/models/<publisher>/<name>` → the folder, then `lms ls` lists it [run]; a **GGUF** goes in with `lms import -l` (row above). Neither copies |
| answers come back as reasoning only; no request switch turns thinking off | some models keep thinking under LM Studio whatever the request says [run]. That is not a failure: `fleet verify` asks once more with room to think and passes, noting it. Never hand-test switches with `curl` (it cost minutes [run]); tell the person replies will be slower, and offer a model that can switch it off if they want that |

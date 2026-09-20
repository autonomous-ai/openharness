# Local AI harnesses

Talk to Codex to deploy and use local language models. The viewer beside the conversation
shows which models are on disk, which are in memory, deployment progress, and measured speed.
Three working harnesses are available: **Ollama** (this root package), **[MLX-LM](../mlx-lm/README.md)** and **[vLLM](../vllm/README.md)** using Metal on this Mac.
They share the queue, agent runner, inventory layout and performance charts. Each has its
own framework identity, native adapter and workspace; this is not an aggregate multi-runtime dashboard.

The [revised product direction](../../../docs/research/local-ai-harnesses/architecture.md) prioritizes direct control of MLX-LM
and llama.cpp, plus advanced vLLM/SGLang serving capabilities. vLLM Metal now has a working initial integration. Harness plus the agent is
the management interface; further wrappers are added when they bring a distinct capability.
New language-model harnesses should declare `"category": "Local AI"` in their manifest.

## Try Ollama in Harness

Install with `harness dsh install autonomous/ollama`. In OpenHarness,
choose **Local AI → Ollama**, then create a workspace on your Mac.
The package opens its dashboard in the viewer on the left; Codex is the operator.
No Ollama CLI knowledge is required.

Try saying:

- “Run a lightweight model.”
- “Find a small model for coding.”
- “Run gemma3:1b.”
- “Ask Qwen to explain this code.” (Codex interprets the request and calls the model.)
- “Compare Qwen 3 0.6B and Gemma 3 1B on this Mac.”
- “Unload Qwen but keep its files.”

A standalone viewer is also served at `http://127.0.0.1:4310/?view=grid` while `./viewer.sh`
is running. Omit the query string for the optional browser command panel. That panel
supports the explicit phrases above via a bounded intent parser; general free-form
model management is handled by Codex in Harness, not a hidden second language model.
If Harness launches its own viewer, it assigns a port and records it in
`.harness/endpoint.json`. Opening the same workspace in Harness reuses an already running workspace service
through a loopback relay, so its queue and recorded history stay shared. If the original
service stops, reopen the native viewer to establish a new service.

## What it does

- Starts the installed Ollama runtime using its native CLI, on loopback with cloud disabled.
- Uses Ollama's local API for discovery, streamed downloads, loading/unloading, and chat.
- Checks download size and available storage before pulling. Downloads larger than 80%
  of physical RAM are rejected by this conservative pilot heuristic; this is not a full
  model-fit estimator. It reserves 2 GiB of disk headroom when the cache volume is readable.
- Verifies residency after load/unload. Files remain in Ollama's existing model cache.
- Streams generated text; records token rates, first token and first visible output time.
- Runs repeatable benchmarks with raw samples, model digest, runtime version and hardware.
- Serializes jobs in one workspace service, supports cancellation and resumable download retries,
  and preserves interrupted/failed jobs as such across restarts.
- Exports benchmark data as JSON. No cloud hosting, paid API key or npm packages are needed.

Chat enables reasoning for models that support it. GPT-OSS uses its supported `low`
reasoning level. Chat has a 4,096-token context, an output budget of 512 tokens including
reasoning, and a 15-minute idle keep-alive. Long reasoning may exhaust that budget before
visible output; the viewer reports the output limit. The small catalog models are examples,
not claims about current best model quality.

## Native controls and agent runner

The adapter uses `ollama serve` to start the service and native `/api/tags`, `/api/ps`,
`/api/show`, `/api/pull`, `/api/generate`, and `/api/chat` endpoints for structured operations.
The agent-facing runner exposes these shared actions so its operations appear in the viewer:

```sh
./toolchain/local-ai status
./toolchain/local-ai action deploy qwen3:0.6b
./toolchain/local-ai action chat qwen3:0.6b 'Explain how a bicycle works.'
./toolchain/local-ai action benchmark qwen3:0.6b gemma3:1b
./toolchain/local-ai action unload qwen3:0.6b
./toolchain/local-ai 'run a lightweight model'
```

This CLI is for agents and development. The user interface is the conversation and viewer.
The adapter never turns model-generated text into a shell command. Direct Ollama commands
remain available for advanced diagnosis; discovery observes their effects on the next poll.

## Measurements

A benchmark uses one discarded 32-token warm-up, then three runs of the same prompt at
2,048-token context, at most 128 generated tokens, seed 42 and temperature 0. Thinking is
disabled when supported; the actual setting is recorded per sample. Reported speed is
`eval_count / eval_duration`, with Ollama's nanoseconds converted to seconds. Time to first
token is observed at the harness, including the first reasoning token when reasoning is on.
Time to first visible output is stored separately. Repeated prompts may use prefix caching.

These are **warm inference measurements**, not cold-start tests, quality scores, or isolated
lab comparisons. Other applications and resident models may affect results. The two demo
models were loaded together during the comparison. Ollama allocation is not total process
RSS; Apple Silicon's CPU and GPU share unified memory.

## Local data and lifecycle

- `.harness/state.json`: up to 200 benchmarks, 200 generation metric records and 40 recent
  jobs. Job records include generated output; chat prompts are not persisted by this harness.
- Browser conversation context is kept in page memory (last six turns, bounded); reloading
  resets it. The selected model uses session storage.
- `.harness/ollama.log`: the native runtime log if this harness started Ollama.
- `.harness/endpoint.json` and `verdict.json`: local viewer discovery and Harness readiness.
- Existing model files stay in `~/.ollama/models`, or the runtime's configured model directory.

Stopping the viewer stops its requests but leaves Ollama running. The runtime is shared with
other local clients; this pilot does not kill unrelated services or delete model files. Views of the same workspace share its queue; separate workspaces and external
Ollama clients still have independent requests. No remote-machine controls are
implemented. Local model names and `/api/show` are checked to reject cloud models and aliases.
The harness binds only to loopback, validates Host/Origin and requires a per-process control
token on JSON mutations. Downloads require network access; generation uses the local service.
Codex itself still uses its configured provider; the harness does not make Codex's reasoning local.

## Development and checks

Prerequisites: Node.js 22+ and Ollama installed. GUI launch can use Harness's managed Node.
The setup/doctor checks dependencies without downloading a model.

```sh
./viewer.sh
harness dsh check .
harness dsh doctor autonomous/ollama
# Shared-source development, from store/tools/local-ai:
npm run build
npm run check
npm test
npm run test:live # opt-in; unloads/reloads qwen3:0.6b and performs inference
```

To register another checkout: `harness dsh install /absolute/path/to/checkout --link`.
The conformance tool's optional skills warning is expected: the pilot ships a single agent
instruction file, rather than duplicating its operations guide as a separate skill.

`test:live` records fresh evidence in the shared development folder’s ignored `evidence/` directory. Fixture tests are isolated
from real model files; HTTP tests bind a temporary loopback port. The viewer exposes two
feature-detected WebMCP tools, inventory and start action. No supported WebMCP execution
context was available in this session, so that optional integration is not verified.

## Research and next decision

- [Framework research and original shortlist](../../../docs/research/local-ai-harnesses/recommendation.md)
- [Machine-readable candidate list and current decision](../../../docs/research/local-ai-harnesses/shortlist.json)
- [vLLM Metal findings and concurrency measurements](../../../docs/research/local-ai-harnesses/vllm/findings.md)
- [What the Ollama pilot taught us](../../../docs/research/local-ai-harnesses/pilot-findings.md)
- [Raw measured benchmark samples](../../../docs/research/local-ai-harnesses/pilot-benchmarks.json)
- [Real deployment and chat check](../../../docs/research/local-ai-harnesses/pilot-verification.json)

The package uses OpenHarness's existing `harness.json`/viewer contract, also used by the
Grid package. The Ollama model adapter is framework-specific; the control plane and viewer logic are shared with MLX-LM. Grid's fleet collector
was not reused because its engine and telemetry contract differs from Ollama's local API.

## Credit and stewardship

The native framework and official mark belong to [Ollama](https://github.com/ollama/ollama).
OpenHarness contributors maintain this independent integration, its agent instructions
and viewer. The harness is MIT-licensed; see [LICENSE](LICENSE). Upstream notices
and license texts are recorded in [THIRD_PARTY.md](THIRD_PARTY.md) and `licenses/`.
Model weights are downloaded separately under their respective model licenses.

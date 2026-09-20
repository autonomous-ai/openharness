# vLLM harness

One **vLLM** harness, using **vLLM Metal** as its Apple Silicon backend. Install with
`harness dsh install autonomous/vllm` in **Local AI**, alongside Grid, Ollama and MLX-LM. The agent operates
the native framework; the branded viewer shows live state and actual measurements.

Open **Local AI → vLLM → New project** in Harness. Try:

- “Run a lightweight model and ask it why bicycles need brakes.”
- “Use a 4,096-token context and allow four parallel requests.”
- “Compare one request at a time with four concurrent requests.”
- “Turn prefix caching off and measure again.”
- “Unload the model but keep its files.”

The shared viewer adds serving settings, active/waiting requests, KV cache usage,
server process RSS, concurrent throughput, median/p95 latency, error counts and raw
samples. It uses the official vLLM icon. The embedded view leaves conversation to
the host agent; the standalone command panel has a bounded phrase parser.

## Native integration

The adapter starts the official `vllm serve` CLI, with a workspace-owned process
group, local cached weights, and the vLLM Metal platform plugin. It consumes native
OpenAI-compatible streaming responses and `/metrics` telemetry. A separate small
Python helper inventories and downloads safetensors snapshots through Hugging Face.
No generated shell code or model-provided commands are executed.

One server/model is active per workspace. Switching models or serving settings
restarts that server. Cancellation, viewer shutdown, parent death and the 15-minute
idle timeout stop owned processes. Other applications are outside its ownership.
Each native API route is authenticated and restricted to loopback Host/Origin;
the transient inference key is never exposed in viewer state or command arguments.

The Mac runtime is pinned to vLLM **0.29.0**, vLLM Metal **0.29.0**, MLX **0.32.1**
and MLX-LM commit `9e6acca691e64d6d8bb808c328fcdea459099cca`. The official core
wheel is labeled `0.29.0+cpu`; MetalPlatform selects GPU inference. The doctor tests
an actual native Metal cache kernel. Do not upgrade MLX independently of the plugin.

## Serving controls

| Setting | Default | Supported range |
| --- | --- | --- |
| Context | 4,096 tokens | 512–16,384 |
| Parallel sequences | 4 | 1–8 |
| Metal memory budget fraction | 0.1 | 0.05–0.8 |
| Prefix caching | On | On/off |

The memory fraction uses **Metal's recommended working-set limit**, not physical
RAM. It covers the plugin's model/cache memory planning. Large models may need a
larger explicit budget. `VLLM_METAL_MEMORY_FRACTION=auto` makes this pinned release
honor the native `--gpu-memory-utilization` flag.

`serve` merges supplied settings with the current configuration. Chat preserves
them. They reset to defaults on viewer restart; every measurement records its actual
configuration. The ordinary three-run benchmark sets context to 2,048 tokens.

## Measurements

Token rates use native completion-token counts divided by **client end-to-end time**,
including prompt processing and HTTP. They are not native decode tokens/s and should
not be ranked against Ollama or MLX-LM decode rates. Streaming chunks are never counted
as tokens. First-token and first-visible-output times are separate.

Concurrency tests use 1–8 clients and up to 32 total requests, with one discarded
warmup, a recorded prompt with numbered suffixes, temperature 0, seed 42, thinking off
when supported and up to 128 generated tokens. Aggregate throughput divides successful
output tokens by the whole measured batch time. Failures retain individual error
samples. p95 uses nearest rank; these short tests are exploratory, not capacity claims.
Repeated prefixes can be cached. Compare identical model, context and cache settings.

Server RSS sums owned processes and may count shared pages more than once; it is
not Metal allocation or physical VRAM. Server gauges may lag requests. Missing values
remain unknown. Exports include hardware, runtime/backend versions, revisions and samples.

## Setup and development

Requirements: Apple Silicon, macOS 15+, native arm64 Python 3.12 and Node 22+.
Dependencies live in this package's `.venv`; model files stay in the standard Hugging
Face cache. `requirements.lock` pins all dependencies and hashes the official wheels.

```sh
# From this package directory:
./toolchain/setup.sh
./toolchain/doctor.sh
./viewer.sh
./toolchain/local-ai status
./toolchain/local-ai action-json '{"type":"serve","model":"mlx-community/Qwen3-0.6B-4bit","maxSequences":4,"prefixCaching":true}'
./toolchain/local-ai action-json '{"type":"load_test","model":"mlx-community/Qwen3-0.6B-4bit","concurrency":4,"requests":8}'
```

The standalone viewer is `http://127.0.0.1:4312/?view=grid`. Native Harness assigns its
own port. Commands must use that workspace's `HARNESS_WORKSPACE`; discovery verifies
both workspace and framework. Shared code changes are packaged with
`npm run build:vllm` from `store/tools/local-ai`. `npm test` runs isolated checks;
`npm run test:vllm-live` exercises this package workspace with the cached demo model.

This first version qualifies Qwen3 0.6B 4-bit on this M2 Max. Other cached text models
are candidates; model support depends on the pinned backend. No CUDA parity, remote
serving, training, multimodal inference or model deletion is claimed.

See [findings and sources](../../../docs/research/local-ai-harnesses/vllm/findings.md),
[live verification](../../../docs/research/local-ai-harnesses/vllm/verification.json) and
[raw benchmarks](../../../docs/research/local-ai-harnesses/vllm/benchmarks.json).

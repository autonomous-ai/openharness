# MLX-LM harness

Operate MLX-LM directly by talking to Codex. The viewer shows cached models, the active
model, memory allocation, live jobs, generated text and measured performance. It shares
the Ollama pilot's control plane and viewer logic, with MLX-specific identity and behavior.

Install with `harness dsh install autonomous/mlx-lm` in **Local AI**. Open MLX-LM in Harness and create a
workspace, or start `./viewer.sh` for the standalone viewer at
`http://127.0.0.1:4311/?view=grid`. Omit `?view=grid` to see the optional bounded command
panel. General natural-language operation comes from the Harness agent.

Try “run a lightweight model”, “benchmark it”, “compare it with Qwen 2.5 0.5B”, or
“free up memory”. No vendor CLI knowledge is required.

## Direct integration

The harness owns a private Python worker using official `mlx_lm.load` and `stream_generate`
APIs. Its isolated environment pins MLX-LM 0.31.3 and MLX 0.32.2, with all dependencies in
`requirements.lock`. It runs locally on Apple Silicon macOS. No other model-management
application or inference API key is needed.

The agent uses `toolchain/local-ai`; `toolchain/mlx-lm` exposes the vendor CLI for diagnosis.
The viewer uses a loopback-only control service with Host, Origin and control-token checks.
It does not expose an OpenAI-compatible serving endpoint. Codex itself continues to use
its configured provider; this harness does not make the operator's reasoning local.

## Models and lifecycle

- Hugging Face `owner/repository` IDs identify models. We reuse the existing HF cache and
  keep a workspace revision registry; other applications' cache references are untouched.
- Downloads are pinned to the fetched repository revision, use safetensors and tokenizer/
  configuration files, and never enable remote model Python. Partial downloads can resume.
- The first demonstration model is `mlx-community/Qwen3-0.6B-4bit`, about 351 MB including
  tokenizer/configuration data at the verified revision. Small models have limited quality.
- The worker keeps one model loaded at a time. Switching releases the old model; a
  15-minute idle timeout or closing the viewer also releases it. Downloaded weights remain.
- Cancelling a running request stops this workspace's worker and frees its model. The
  worker restarts automatically for subsequent requests. Other applications are unaffected.
- Discovery lists complete cached MLX-community text snapshots, MLX-named repositories,
  and repositories explicitly downloaded by this workspace. It is not an inventory of
  every possible MLX-compatible model or of other applications' resident models.
- This pilot does not delete models, fine-tune, quantize, load adapters, serve multiple
  concurrent requests, or run multimodal models. These require deliberate future work.

Downloads larger than 80% of physical RAM are rejected and require 2 GiB of disk headroom.
This is a conservative download check, not a complete model-fit estimator.

## Measurements

Chat uses a 4,096-token context budget and up to 512 generated tokens including reasoning.
Benchmarks discard one 32-token warm-up, then measure three runs with a 2,048-token context,
128-token output budget, seed 42, temperature zero and thinking disabled where supported.
The model stays warm; each sample uses a fresh prompt cache.

Generation speed is MLX-LM's native token rate. First-token time is observed by the harness
and includes local IPC. First visible answer time excludes hidden reasoning and leading
whitespace. Native prompt rate, generated token count, finish reason and peak allocation
are retained. MLX allocation is neither process RSS nor a separate physical VRAM pool.

The included measurements are short warm inference samples on this M2 Max, not quality
scores or controlled cross-engine rankings. Ollama benchmarks can reuse the prompt cache
and use different timing definitions. See [raw results](../../../docs/research/local-ai-harnesses/mlx-lm/benchmarks.json)
and [live validation](../../../docs/research/local-ai-harnesses/mlx-lm/verification.json).

## Development

Shared sources live in `store/tools/local-ai/src`, `bin` and `dist`. Run `npm run build:mlx` from
`store/tools/local-ai` to regenerate this package's copies and its branded viewer. Edit `worker.py`,
assets, manifest, agent instructions and toolchain here. Do not edit generated copies.

Run `toolchain/setup.sh` to install, `toolchain/doctor.sh` to inspect readiness,
`npm test` from `store/tools/local-ai` for regression checks, and `npm run test:mlx-live` for opt-in
GPU checks against this package's running standalone viewer. Live checks load and unload
the two small baseline models, benchmark them and exercise cancellation.

`.harness/` stores endpoint discovery, jobs, generated output, measurements, the diagnostic
log and selected HF revisions. Chat prompts are not persisted by the controller, but model
output is. Benchmarks and logs belong to the workspace. Framework workspaces must remain
separate; their common state format does not authorize concurrent writers.

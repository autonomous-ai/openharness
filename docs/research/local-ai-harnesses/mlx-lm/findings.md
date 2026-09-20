# MLX-LM pilot findings

Verified 2026-09-20T04:38:50.327Z on Apple M2 Max, 64 GiB unified memory.
MLX-LM 0.31.3, MLX 0.32.2, isolated Python 3.12 environment.

## What is working

The agent runner reaches MLX directly through a private Python worker. Native load and
streaming APIs provide real inventory, text, native token rates and peak allocation.
Download of Qwen3-0.6B-4bit succeeded into the existing Hugging Face cache, pinned to
`73e3e38d981303bc594367cd910ea6eb48349da8`; selected files total 351,383,618 bytes.
Cached Qwen2.5-0.5B was reused without downloading a second copy.

The shared viewer is branded for MLX-LM with the official MLX wordmark. The native app
registers `local/mlx-lm` under Local AI alongside Grid and Ollama. A dedicated native
workspace was opened at `<home>/harnesses/mlx-lm-2026-09-20-00-44`.

Verified operations: actual download, load, streamed chat, native measurements, two-model
benchmarks, one-model-at-a-time switching, unload, active cancellation, worker restart and
reload. Cancellation also releases the resident model. The package doctor and manifest
checks pass. Seventeen shared regression tests and fifteen targeted native tests pass.

## Measurements

| Model | Median generation tokens/s | Median first-token time, ms |
| --- | ---: | ---: |
| Qwen2.5-0.5B-Instruct-4bit | 425.5 | 96 |
| Qwen3-0.6B-4bit | 411.9 | 89 |

These are the recorded standalone verification results: a discarded 32-token warm-up,
three measured runs, fresh prompt cache each time, 2,048-token context, 128-token output
budget, seed 42, zero temperature, thinking off. These are short warm generation samples,
not quality rankings or isolated cross-framework comparisons. Native app demonstration
runs may differ and retain their own timestamps and samples.

Native generation speed is distinct from client-observed first-token time. Visible-output
timing excludes hidden reasoning and leading whitespace. Memory is MLX allocation, not RSS.
The same base model with different quantization formats does not establish identical weights.
Ollama's possible prefix-cache reuse differs from this measurement protocol.

## Decisions for later

Use the [engine-first product direction](../architecture.md). This second adapter proved
that we can reuse the queue, agent runner, inventory schema and viewer while preserving
engine-specific metrics and behavior. The current bundle is deterministic: parent shared
sources are copied by `scripts/build-mlx.mjs`, with MLX branding and measurement copy.

One model per workspace keeps initial ownership and cancellation clear. Concurrent serving,
quantization/conversion, LoRA, configurable context/KV cache, memory-fit tuning and structured
output are possible later slices, not currently exposed features. Do not claim parity with
MLX-LM's full CLI or every model supported by upstream.

The tiny model produces real text but has limited reasoning and factual accuracy. This
validation proves operation and measurement, not useful answer quality for difficult tasks.

Evidence: [live checks](verification.json), [raw benchmarks](benchmarks.json),
[versions](versions.json), [package guide](../../../../store/agents/mlx-lm/README.md).

# vLLM Metal qualification and harness

September 20, 2026 · Apple M2 Max · 64 GiB · macOS 26.6.2.

## Product decision

The user chose to build vLLM after clarifying the overlap between frameworks and
management applications. **One harness per framework** is the accepted structure:
vLLM Metal is the Mac backend within **vLLM**, not another harness or store entry.
MLX is Apple's array framework, MLX-LM is a language-model library, and vLLM Metal
uses MLX underneath vLLM's serving machinery. They expose different operational
capabilities despite sharing lower layers. SGLang remains future work.

The working vLLM harness exposes useful serving complexity: context, parallel
sequences, Metal memory budget, prefix caching, concurrent requests and measurements.
The queue, commands, inventory and base viewer are shared with the earlier harnesses;
the adapter, serving panels, branding and metric definitions belong to vLLM.

## Qualified runtime

- Official vLLM 0.29.0 macOS arm64 Python 3.12 core wheel (`0.29.0+cpu`).
- Official vLLM Metal 0.29.0 macOS 15 arm64 wheel.
- MLX/MLX Metal 0.32.1, required by the compiled plugin ABI.
- MLX-LM from commit `9e6acca691e64d6d8bb808c328fcdea459099cca` (reports 0.32.0).
- Isolated environment with 159 pinned dependencies. Existing MLX-LM and system Python
  are unchanged. Official wheel hashes are retained in requirements and lock files.
- Runtime selection confirms **MetalPlatform**. The doctor executes and evaluates
  a native reshape-and-cache Metal operation; real inference also succeeded.

The `+cpu` core-wheel suffix is packaging, not the selected inference device. The
plugin supplies native Metal paged-attention kernels and MLX execution. This avoids
a local vLLM source build for the tested stable release.

Pinned 0.29.0 still supports `VLLM_METAL_MEMORY_FRACTION`, although newer main-branch
configuration documentation describes its removal. Set it to `auto` so the CLI
`--gpu-memory-utilization` controls memory planning. The budget is a fraction of
Metal's recommended working set, not a percentage of total system RAM. Default 0.1
worked for the small demo model; larger models are not implied to fit that budget.

## Real evidence

Tested model: `mlx-community/Qwen3-0.6B-4bit`, existing cached snapshot
`73e3e38d981303bc594367cd910ea6eb48349da8`. We reused its weights; no duplicate model
download was needed. Live checks verified an actual answer, three measured warm
requests, concurrent serving, applying 1,024/2/no-prefix-cache and 2,048/4/prefix-cache
configurations, preserving settings during chat, cancellation, recovery and unloading.

The latest completed integration run recorded:

| Workload | Throughput | p95 complete-request latency | Errors |
| --- | ---: | ---: | ---: |
| 8 requests, concurrency 1 | 179.0 aggregate tokens/s | 742 ms | 0 |
| 8 requests, concurrency 4 | 586.3 aggregate tokens/s | 911 ms | 0 |

Both used 2,048 context, four allowed sequences, 0.1 memory fraction, prefix cache on,
up to 128 output tokens, seed 42, temperature 0 and reasoning disabled. An earlier
pair measured 199.3 and 590.8 tokens/s. These are exploratory warm tests on a working
Mac; native app build work and other applications were active. Prefix-cache history
was not reset between tests. Do not infer an isolated 3.3× scaling guarantee.

Single-request benchmark in the latest run: **204.0 client end-to-end tokens/s**, with
**21 ms** median time to first token, across three warm samples. This includes prompt
processing and HTTP; it is not comparable to MLX-LM's native generation rate. The
small model's answers establish functionality, not quality.

Raw samples, timestamps, settings, model revision and hardware are in
[benchmarks.json](benchmarks.json); checks and a real answer are in
[verification.json](verification.json). Earlier successful measurement records are
preserved even when a later lifecycle check in that development run failed.

## Validation and limits

- 21 Node checks cover shared behavior, bounded controls, prompt/operation separation,
  split UTF-8 SSE, native token counts, partial stream errors, real request overlap,
  failure samples and persisted concurrency records.
- Native API checks reject missing credentials, cross-origin requests and hostile
  Host headers, including health and metrics routes. Every native route is guarded.
- Viewer, scripts, stylesheet, official icon and favicon returned HTTP 200.
- Manifest conformance, isolated setup, installed doctor and native Metal check passed.
- 15 targeted native category/identity tests passed. The icon build was compiled,
  locally signed, verified and installed with the previous app preserved.

The backend inference and control path were tested. Browser visual/interaction QA
was not requested. Native desktop control failed to start in this session, so a new
native vLLM workspace could not be opened automatically. The local viewer remains
available on port 4312 with its measured results. Native app navigation is
**Local AI → vLLM → New project**.

Only the named Qwen3 model has live qualification here. Uncached download/resume,
other architectures, large-model memory fitting, remote/GPU servers, structured
generation and training remain outside this qualification. Settings persist while
the viewer runs and reset on its restart; recordings retain the settings used.

Additional handoff check: cancellation was exercised after **4 of 32 measured
requests** completed at concurrency 4. The server returned to idle, then a fresh
server produced a real answer. This checks overlapping-request cancellation beyond
the earlier warmup cancellation. [handoff.json](handoff.json) records the evidence
and the native app handoff limitation. The agent-facing `serve` command also passed.

## Primary sources

- [vLLM Metal installation](https://docs.vllm.ai/projects/vllm-metal/en/latest/installation/)
  — hardware, Python and prebuilt installation path.
- [vLLM Metal repository](https://github.com/vllm-project/vllm-metal)
  — platform integration, Metal kernels and serving architecture.
- [Pinned 0.29.0 package metadata](https://github.com/vllm-project/vllm-metal/blob/v0.29.0/pyproject.toml)
  — ABI pins and exact MLX-LM dependency.
- [vLLM 0.29.0 release](https://github.com/vllm-project/vllm/releases/tag/v0.29.0)
  and [vLLM Metal 0.29.0 release](https://github.com/vllm-project/vllm-metal/releases/tag/v0.29.0)
  — downloaded official wheels.
- [Model support matrix](https://docs.vllm.ai/projects/vllm-metal/en/latest/supported_models/)
  — architecture support is backend-specific.
- Installed 0.29.0 `vllm_metal/config.py`, `v1/cache_policy.py`, and the native CLI/API
  sources were used to verify behavior where current main documentation differs.

Public release metadata is preserved in the parent research directory. Refer to the
primary source links above for upstream installation and configuration files.

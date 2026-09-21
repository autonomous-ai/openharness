**Local AI harness shortlist — September 19, 2026**

**Original pilot decision (superseded September 20): build one Ollama pilot, try the experience, and decide the rest afterward.** The user explicitly chose this smaller first step rather than locking the entire list. The pilot uses the installed Ollama CLI and local API, a natural-language agent, and a live Harness viewer. See [pilot findings](pilot-findings.md) for implementation and measurements.

The original proposed list is preserved for later: **Ollama, llama.cpp, LM Studio / llmster, MLX-LM, oMLX, and vLLM Metal**, plus **vllm-mlx and SGLang's MLX backend** as experiments. Ollama and MLX-LM are now implemented. The others remain research candidates, not commitments or tested compatibility claims. The [updated architecture and priorities](architecture.md) supersede the original order below.

The user confirmed that the first release should cover language models and target this Mac. Read-only system inspection identified an **Apple M2 Max with 64 GiB unified memory, running macOS 26.6.2**. Ollama, llama-server, and the LM Studio CLI were already on PATH; their presence does not establish that their servers are running or that their installed versions have the latest features.

The research combines official repositories, project documentation, release notes, and a dated GitHub API snapshot. Stars indicate public interest, not installed users, reliability, or speed. Repository creation dates are not necessarily product launch dates. GitHub's `/releases/latest` identifies the release designated latest by GitHub, and can differ from package registries, nightlies, or current source. Some capabilities below are documented on the main branch and must be verified against the version selected for implementation. No comparative inference benchmarks were run for this research.

**The proposed build order follows practical value on this Mac.**

| Order | Harness | Interest signal | Why include it | Integration and qualification |
| --- | --- | --- | --- | --- |
| 1 | [Ollama](https://github.com/ollama/ollama) | 181,281 stars | Broad ecosystem; approachable model discovery and downloads; the most familiar starting point in this shortlist. | Native model-management API and streamed inference. Compute generation speed from reported token counts and timing; distinguish downloaded from resident models. |
| 2 | [llama.cpp](https://github.com/ggml-org/llama.cpp) | 128,863 stars | Direct GGUF execution with Metal and detailed controls; valuable as a baseline beneath several higher-level products. | Current server supports model routing, loading/unloading, download events, request timings, and optional Prometheus metrics. Detect installed version because commands and management endpoints have evolved. |
| 3 | [LM Studio / llmster](https://lmstudio.ai/docs/developer/core/headless) | Desktop product; SDK stars are not a valid product comparison | Strong model-management experience and access to both GGUF and MLX engines. Headless operation makes it suitable for automation. | Use llmster to run without the desktop UI. Native REST v1 supports download, load, unload, and status; chat responses include performance statistics. |
| 4 | [MLX-LM](https://github.com/ml-explore/mlx-lm) | 7,069 stars; underlying [MLX](https://github.com/ml-explore/mlx) has 28,484 | Direct access to Apple's MLX ecosystem and a useful reference for measuring the overhead or benefit of other MLX servers. | Manage an isolated process/environment, model downloads, and local inference server. Use its generation/benchmark statistics and client observations. Server functionality is version-dependent; it already has batching support. |
| 5 | [oMLX](https://github.com/jundot/omlx) | 21,930 stars; repository created February 2026 | The strongest newer Mac-specific candidate by the combination of public interest and relevant operations features. It offers persistent prompt caching, concurrent requests, and memory-aware model management. | CLI plus OpenAI-compatible inference; admin code exposes model load/unload, downloads, statistics, and benchmark routes. Treat admin routes as version-sensitive rather than assuming a stable external contract. |
| 6 | [vLLM Metal](https://github.com/vllm-project/vllm-metal) | 1,749 stars; parent vLLM has 92,191 | Brings the upstream vLLM server and scheduler to Apple Silicon, creating a path toward later Linux/GPU support. | A community-maintained plugin in the vLLM organization. Current installation supports macOS 15+ and native arm64 Python 3.12. Qualify supported model families; several features remain experimental. |
| 7 — experimental | [vllm-mlx](https://github.com/waybarrios/vllm-mlx) | 1,587 stars; repository created December 2025 | An independent Mac server with OpenAI/Anthropic compatibility, batching, prompt caching, metrics, and a built-in serving benchmark. Useful for comparing agent workloads. | It is a separate project from upstream vLLM and vLLM Metal. Keep a separate adapter and runtime identity; do not imply upstream compatibility from its name. |
| 8 — experimental | [SGLang with MLX](https://github.com/sgl-project/sglang/releases/tag/v0.5.10) | 36,178 stars for SGLang overall | A major serving project whose newer Apple Silicon path makes it relevant to a Mac-first evaluation. | MLX support was included in v0.5.10. Installation, feature coverage, cache behavior, and telemetry must be verified on the Mac backend rather than inferred from CUDA support. |

The first three targets already have command-line executables on this machine, which should shorten initial integration. MLX-LM then establishes a direct Apple Silicon reference. oMLX adds practical model residency and cache management. vLLM Metal connects the Mac experience to a major server ecosystem. The experimental pair gives the product room to compare newer approaches without presenting unverified combinations as fully supported.

**Several recent developments materially affect the choice.**

LM Studio introduced its standalone llmster daemon in the January 28, 2026 release of 0.4.0. Its current API reference recommends `/api/v1/*` and documents model download/load/unload operations. That changes its suitability for an automated harness: we can drive a service directly instead of depending on desktop interaction. [Announcement](https://lmstudio.ai/blog/0.4.0), [current native API](https://lmstudio.ai/docs/developer/rest).

llama.cpp's current server includes a router with model lifecycle operations and server-sent events. A separate swapping proxy is therefore optional for our first release. Some installations still expose the older `llama-server` executable, while the current top-level README also documents `llama serve`; the adapter should probe capabilities. [Server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [current quick start](https://github.com/ggml-org/llama.cpp).

oMLX's repository was created on February 13, 2026, and its latest designated release was 0.6.4 on August 29. Its cache moves reusable attention state between RAM and SSD; this is different from streaming the model's weights from disk. Current source also documents experimental multi-Mac inference, which should remain outside our initial single-Mac scope. [Project](https://github.com/jundot/omlx), [release](https://github.com/jundot/omlx/releases/tag/v0.6.4).

vLLM Metal and vllm-mlx both appeared as repositories in December 2025, but use different integration approaches. vLLM Metal plugs into upstream vLLM; vllm-mlx is an independent MLX serving system. vllm-mlx released 0.5.0 on September 17, 2026, with conversation-cache and streaming improvements. Feature and throughput claims from either project need reproduction on this M2 Max. [vLLM Metal architecture](https://github.com/vllm-project/vllm-metal), [vllm-mlx release](https://github.com/waybarrios/vllm-mlx/releases/tag/v0.5.0).

SGLang's published v0.5.10 release notes explicitly include native MLX execution on Apple Silicon. The latest designated release in the snapshot is v0.5.20, published September 18. It would be outdated to describe the project as categorically unavailable on Macs, but its overall maturity does not establish feature parity for the newer backend. [MLX introduction](https://github.com/sgl-project/sglang/releases/tag/v0.5.10), [recent release](https://github.com/sgl-project/sglang/releases/tag/v0.5.20).

**The broader popularity comparison explains the candidates we would postpone.**

| Candidate | GitHub stars in snapshot | Distinctive value | Recommendation for the agreed Mac/language-model scope |
| --- | ---: | --- | --- |
| [vLLM core](https://github.com/vllm-project/vllm) | 92,191 | Large serving ecosystem, scheduling, batching, and observability | Cover this family through vLLM Metal first; add Linux CUDA/ROCm deployment when that hardware is in scope. |
| [LocalAI](https://github.com/mudler/LocalAI) | 49,177 | Broad local API platform for text, vision, audio, images, and other modalities | Strong later addition when breadth matters; much of its distinctive value is outside the first text-only release. |
| [exo](https://github.com/exo-explore/exo) | 47,531 | Device discovery, model sharding, and local clusters | Highest-interest later experiment. A second suitable Mac is needed to validate the distinctive clustering experience. |
| [Jan](https://github.com/janhq/jan) | 44,564 | Open-source desktop assistant with local model downloads and an OpenAI-compatible server | Later compatibility adapter. First-wave engine coverage overlaps, and its desktop experience duplicates some of our proposed surface. |
| [llamafile](https://github.com/mozilla-ai/llamafile) | 25,997 | Portable execution and model distribution in a single file | Later portable-deployment target. Much of the inference functionality overlaps llama.cpp. |
| [MLC-LLM](https://github.com/mlc-ai/mlc-llm) | 23,169 | Compilation-based deployment across devices and platforms | Revisit for mobile, browser, or embedded deployment. Adds compilation/package work to this desktop-first project. |
| [KTransformers](https://github.com/kvcache-ai/ktransformers) | 19,522 | Heterogeneous CPU/GPU execution for large mixture-of-experts models | Revisit for compatible Linux hardware and larger-model experiments; not the default path for this Mac. |
| [TensorRT-LLM](https://github.com/NVIDIA/TensorRT-LLM) | 14,673 | NVIDIA-specific serving optimizations | Defer until NVIDIA hardware is in scope. |
| [KoboldCpp](https://github.com/LostRuins/koboldcpp) | 11,804 | Accessible GGUF runner and established interactive-fiction ecosystem | Later if that workflow matters; substantial overlap with the GGUF harness. |
| [GenieX, formerly Nexa SDK](https://github.com/qualcomm/GenieX) | 8,380 | Current project targets Qualcomm devices across NPU/GPU/CPU | Hardware mismatch for the current scope. The old Nexa repository redirects here; older comparisons can be misleading. |
| [mistral.rs](https://github.com/EricLBuehler/mistral.rs) | 7,709 | Independent Rust runtime, quantization, Metal support, dynamic model management | Best next independent single-Mac engine after the initial set. A credible alternative if we prefer another architecture over two MLX serving experiments. |
| [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) | About 6.5k, GitHub page | Google's edge deployment framework | Later for edge/mobile deployment. Exact API count was unavailable after rate limiting. |
| [Lemonade](https://github.com/lemonade-sdk/lemonade) | 5,748 | Local server with hardware-specific backends; substantial AMD GPU/NPU emphasis and current Mac support | Add when AMD/Windows machines or broader modalities become priorities. |
| [llama-swap](https://github.com/mostlygeek/llama-swap) | 5,700 | Routes requests and starts/stops upstream model servers; exposes monitoring and MCP integration | Treat as an orchestration integration, not an independent inference engine. First evaluate what we need beyond native runtime lifecycle controls. |
| [Flash-MoE](https://github.com/danveloper/flash-moe) | 4,145 | Streams large mixture-of-experts model weights from SSD on Apple Silicon | Research track only: narrow model support, substantial storage needs, and additional output-correctness verification. |
| [ik_llama.cpp](https://github.com/ikawrakow/ik_llama.cpp) | About 3.2k, GitHub page | llama.cpp fork with additional quantizations and optimization work | Later benchmark variant; maintain a distinct engine identity and pinned build. |
| [RamaLama](https://github.com/containers/ramalama) | 3,053 | Container-oriented model acquisition and deployment | Later for container/server workflows; overlaps the deployment layer we are building. |
| [ExLlamaV3](https://github.com/turboderp-org/exllamav3) | 1,464 | Quantized inference for modern consumer GPUs | Its documented CUDA requirements make it a later NVIDIA target. |
| [Parallax](https://github.com/GradientHQ/parallax) | 1,381 | Distributed inference across heterogeneous machines, using existing backend engines | Later multi-machine alternative; additional networking and scheduling scope. |
| [Hugging Face TGI](https://github.com/huggingface/text-generation-inference) | 10,885 | Established serving system | Exclude from new development: repository archived; README describes maintenance mode and recommends alternatives. |

Image and speech systems were considered during initial discovery, then removed from the first-release scope following the user's choice. ComfyUI and whisper.cpp remain sensible topics for a separate future research pass. Frontends and agent application frameworks should not be counted as distinct inference engines merely because they can call local servers.

**The most interesting experiments have different prerequisites.**

exo is the strongest candidate for a later visual cluster map: its documented behavior includes automatic discovery and splitting a model across machines. The current macOS app requires macOS 26.2+. Its Thunderbolt RDMA path depends on compatible Thunderbolt 5 hardware; this M2 Max MacBook Pro has Thunderbolt 4 and does not qualify for that specific path. A network-based setup is a separate configuration to test, not an equivalent speed promise. [exo setup and RDMA requirements](https://github.com/exo-explore/exo), [Apple hardware specifications](https://support.apple.com/en-us/111838).

Flash-MoE demonstrates an unusual capacity tradeoff: the project reports running Qwen3.5-397B-A17B on a 48 GB M3 Max by streaming approximately 209 GB of weights from SSD. Its reported 4-bit result is about 4.36 tokens/second, and its README notes broken tool-call JSON in a faster 2-bit configuration. These are author-reported results, not independent measurements on this Mac. The original repository's latest push in the snapshot is March 19, despite continuing attention; novelty and current maintenance are separate signals. [Project experiment](https://github.com/danveloper/flash-moe).

mistral.rs is more practical than either cluster or SSD-weight-streaming experiments when the goal is another engine on one Mac. Its documented server includes OpenAI-compatible requests, model status, unload/reload, and metrics. We can substitute it for one of the two experimental MLX adapters if independent engine diversity is more valuable than comparing Mac serving layers. [Project](https://github.com/EricLBuehler/mistral.rs), [model management](https://docs.mistralrs.dev/guides/serve/multiple-models/).

**Every accepted harness should satisfy the same user-facing contract.**

- Detect the runtime, its version, installed models, active server, and supported hardware.
- Interpret requests such as “run a small coding model,” resolve a concrete model and compatible format, and explain the selection.
- Download and start that model, expose progress, and report when inference is actually ready.
- List, load, unload, stop, and restart supported model instances; state unavailable capabilities clearly.
- Offer a common inference interface and a reproducible benchmark action.
- Emit model state, errors, logs, memory observations, and performance measurements to the viewer.

Natural-language interpretation should produce typed actions with validated arguments. The runtime adapters then perform those actions through documented APIs or explicit process arguments. A shared inference protocol helps, but OpenAI compatibility alone does not provide model installation, download, lifecycle control, or hardware measurements.

The viewer should distinguish **machine → runtime/engine → model instance**. A model downloaded in two formats or served by two runtimes is two deployments of one model family, not two unrelated models. Useful first views are a live model map, memory occupancy, request activity, and comparable benchmark results.

**Performance needs a common measurement protocol.**

| Measurement | How to make the comparison useful |
| --- | --- |
| Time to first token | Record end-to-end client time and server-reported time separately. Identify cold loading, prompt processing, and cache reuse. |
| Generation tokens/second | Prefer server token counts/timing; identify whether this is one request or aggregate throughput. Never equate stream chunks with tokens. |
| Prompt-processing speed | Report separately from generation. Record prompt length and cached-token count where available. |
| Memory | Distinguish process footprint, model allocation, cache allocation, and system pressure. Apple unified memory does not map cleanly to a discrete-GPU VRAM chart. |
| Concurrency and latency | Benchmark one request and a small concurrent batch; retain errors and p50/p95 latency instead of reporting only the fastest run. |
| Correctness | Check basic output coherence, JSON conformance, and tool-call validity alongside speed. A faster broken output is not a successful result. |
| Reproducibility | Store model revision, format, quantization, context length, prompt, output budget, sampling parameters, runtime version, and hardware. |

For the same-model comparisons, use the same base weights and tokenizer where possible. GGUF and MLX quantizations are not automatically numerically equivalent, even when both are described as 4-bit. Mark such results as matched model-family comparisons rather than identical-weight engine comparisons. Repeat cold and warm runs; avoid ranking frameworks from a vendor's best example on different hardware.

Native metrics are available in different forms: Ollama reports token counts and nanosecond timings, LM Studio reports speed and first-token/load timings, llama.cpp exposes request timings and optional Prometheus metrics, and vLLM/SGLang have Prometheus interfaces. MLX-based runtime-specific statistics need adapter normalization. Missing telemetry should appear as unavailable, not as a fabricated zero. [Ollama timings](https://docs.ollama.com/api/generate), [LM Studio statistics](https://lmstudio.ai/docs/developer/rest/chat), [llama.cpp metrics](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), [vLLM metrics](https://docs.vllm.ai/en/latest/design/metrics/), [SGLang metrics](https://docs.sglang.io/docs/references/production_metrics).

The evidence snapshots are saved beside this report in `github-snapshot.json` and `releases-snapshot.json`. Retrieval timestamps use UTC, which falls on September 20 for this September 19 evening session in New York. Rounded counts cited from GitHub pages are explicitly labeled. The broad ecosystem research is preserved. Follow the [updated architecture and priorities](architecture.md) for current implementation decisions.

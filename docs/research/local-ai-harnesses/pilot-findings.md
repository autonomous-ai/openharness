# Ollama pilot findings

Date: September 19, 2026 (America/New_York; evidence timestamps are September 20 UTC).

## Decision and scope

The user chose **one working harness first**, then a decision about the rest. Ollama was
selected because it was installed on this Mac and exposes native model lifecycle and
inference APIs. No other framework adapter was implemented or installed. The original
six core and two experimental candidates remain in [the research report](recommendation.md).

The intended product is a domain-specific Harness agent: natural-language conversation
with Codex and a model/performance viewer on the left. Each future adapter should use its
framework's supported native CLI and/or API. A CLI-only requirement would discard useful
structured streaming and timing data. For Ollama, the CLI starts the daemon; its local API
handles downloads, residency, chat, and measurement.

The pilot is registered locally as `local/ollama`. Its package passes the spec-1 checker
and dependency doctor. It appears as **Ollama, by Local** in OpenHarness's agent picker.
The same `harness.json`/viewer launch contract used by the existing Grid package is reused.
Grid's telemetry collector is not a drop-in Ollama adapter, so its fleet-specific data
schema and UI were not copied. The embedded dashboard has no duplicate chat pane. A second view of the same
workspace reuses the existing controller through a loopback relay. Its HTTP page,
shared controller, saved benchmarks and JSON export were verified.

## What actually ran

Host: Apple M2 Max, 64 GiB unified memory, macOS 26.6.2. Runtime: Ollama 0.34.0.

- Started the installed Ollama service locally with cloud disabled.
- Downloaded Qwen 3 0.6B and Gemma 3 1B through the harness, and verified their residency.
- Unloaded and reloaded Qwen, confirming both states in Ollama's inventory.
- Streamed local generation and captured native token counts/timing.
- Verified that Qwen with reasoning enabled answered the arithmetic sanity prompt with `4`.
- Ran both models through the same three-run warm benchmark; saved raw samples, model
  digests, runtime version, settings, timestamps and hardware.
- Checked cancellation, failed jobs, stream parsing, restart recovery, request boundaries,
  and metric unit conversions with 14 automated tests.

The sanity prompt is only an integration check. It is not a model-quality evaluation.

## Measured baseline

Latest matched-setting runs from 2026-09-20 02:39 UTC:

| Model | Median generation speed | Median first token | Ollama allocation |
| --- | ---: | ---: | ---: |
| qwen3:0.6b | 290.6 tokens/s | 9.1 ms | 0.74 GiB |
| gemma3:1b | 152.5 tokens/s | 22.8 ms | 0.82 GiB |

Each used one discarded 32-token warm-up followed by three measured runs of one fixed
bicycle-explanation prompt: 2,048-token context, maximum 128 generated tokens, temperature
0, seed 42. Qwen thinking was disabled for this speed baseline. Gemma does not expose
that reasoning mode. Prefix caches may be warm, so these first-token times must not be
advertised as cold-start latency. Both demo models were resident during the comparison;
other desktop workloads were not controlled. These results are observations on this Mac,
not cross-framework or hardware rankings.

Ollama's allocation is not physical dedicated VRAM, total process RSS, or peak memory.
Missing performance/temperature/utilization data is not invented. The first Qwen baseline
was 276.8 tokens/s; the later matched comparison was 290.6. The recorded variation is one
reason to retain raw samples and timestamps rather than presenting a single universal rate.

Evidence: [all benchmark samples](pilot-benchmarks.json),
[deployment and chat check](pilot-verification.json).

## Lessons from real failures

1. **A failed download needs a retry path.** The first Qwen download hit an upstream TLS
   handshake timeout. The next attempt succeeded using Ollama's cached partial download.
   The harness showed failure rather than claiming deployment. User-facing errors now
   omit signed URL query strings and offer a retry; raw daemon logs stay local.
2. **On-disk does not mean usable.** The existing `gpt-oss:20b` model appeared in inventory
   but failed to load with `tensor "blk.0.ffn_down_exps.weight" size overflow`. Its files
   were left untouched. The cause was not established; this is not evidence that all
   GPT-OSS models or all Ollama installations fail. That model was not benchmarked.
3. **Fast settings can hurt answers.** On the prompt “What is 2 + 2? Reply with just the
   number.” Qwen 3 0.6B returned `2` with reasoning disabled, including a direct native API
   reproduction. With reasoning enabled, the native API and the final harness both
   returned `4`. Chat now enables reasoning where available. Benchmarks explicitly record
   their own mode. A fast rate must never be presented as a quality score.
4. **First token and visible answer differ.** The verified reasoning chat produced its
   first token around 33 ms and first visible output around 350 ms. Both are saved.
   Generated-token counts can include reasoning even when only visible text is displayed.
5. **The conversation should remain the agent.** The embedded viewer provides observations
   and model controls beside Codex. The standalone browser command panel is optional and
   uses a bounded phrase parser; it is not a general autonomous language planner.
6. **Native packaging matters.** A browser dashboard alone does not provide the expected
   Harness experience. The package now supplies a workspace template, agent instructions,
   a workspace-aware runner, setup/doctor commands, a viewer launch command, and verdicts.
   Dependencies can use Harness's managed Node for GUI launches without relying on shell
   profiles. The pilot does not publish a hosted service or require a paid inference key.

## Validation limits

- The native package was installed and verified visible in the OpenHarness agent picker.
  The initial browser preview rendered, but Chrome later blocked the preview URL with
  `ERR_BLOCKED_BY_CLIENT`. No browser security setting was changed. The follow-up on
  2026-09-19 verified the updated viewer inside the native left pane, including the
  official Ollama logo and model-specific error explanation.
- No full browser interaction or responsive screenshot test suite was run. Backend actions
  were exercised through the same API/runner used by the viewer.
- WebMCP registration is feature-detected; no supported WebMCP execution context was
  available. Its optional tools are implemented but not verified in a host.
- HTTP behavior is local only. Multi-machine orchestration, shared queues across separate
  workspaces, peak-RAM sampling, energy, temperatures, and cold-start benchmarks are deferred.
- Starting a model service is supported; installing Ollama itself is outside this Mac's
  pilot because the official runtime was already present. On a machine without it,
  doctor/setup reports the missing runtime instead of pretending readiness.

## What to keep before adding another adapter

Keep the framework adapter separate from jobs, intent resolution, stored measurements,
and presentation. Require each adapter to expose discovery, readiness, download, load,
unload, generate, cancellation, and honest capability/missing-metric reporting. Native
CLI/API choices belong inside the adapter. Preserve failure and restart states, and verify
one real inference before declaring a first deployment successful.

The user's next decision is whether this experience feels useful. If it does, **llama.cpp**
adds a useful independent GGUF/Metal baseline; **LM Studio/llmster** adds a different model
management flow; **MLX-LM** adds a direct Apple Silicon comparison. Revisit the original
research before choosing. oMLX, vLLM Metal and the experimental engines are still candidates,
not a locked release plan.

## Follow-up: identity, category and reported error (2026-09-19)

- The viewer remains Ollama-specific; it now uses the official Ollama llama mark,
  Ollama copy, a favicon and app icon. Shared jobs and charts are reusable foundations,
  not a claim that other runtimes are already implemented.
- OpenHarness desktop adds a Local AI shelf with a brain/circuit icon. It recognizes
  older `autonomous/autonomous-grid` and `local/ollama` catalog entries that used Compute,
  and any new package tagged Local AI. Ollama and the Grid kit manifests use Local AI.
- The reported red badge belongs to the materialized workspace
  `ollama-2026-09-19-23-03`, whose GPT-OSS benchmark failed. The viewer now includes a
  visible explanation, the model name and original error; the failed job remains intact.
- The existing GPT-OSS weights match SHA-256
  `b112e727c6f18875636c56a779790a590d705aec9e1c0eb5a97d51fc2a778583`
  and the manifest size of 13,780,154,624 bytes. Ollama 0.34.0 rejects them with a
  tensor-size overflow. An isolated test with the checksum-verified official 0.34.2
  Darwin CLI also fails during `/api/show`; no inference is required to reproduce it.
  The test server was stopped. The existing runtime and model cache were not replaced.
- Next recommendation for this Mac: MLX-LM. Its Apple Silicon focus and native CLI/Python
  interfaces make it a useful independent runtime comparison, before committing to
  newer MLX server wrappers. No second harness has been started or implicitly selected.
  Source: https://github.com/ml-explore/mlx-lm

Native follow-up verification: the rebuilt app opened successfully. The Local AI shelf
visibly lists both Grid and Ollama. Ollama's real logo appears in its store card, tab,
viewer header and dashboard. The viewer displays live inventory and the preserved
GPT-OSS failure. Fifteen targeted native tests and fourteen harness tests passed.

# Local AI harness research and qualification

Research began September 19, 2026 with language models on Apple Silicon. The first
three implementations are [Ollama](../../../store/agents/ollama/README.md),
[MLX-LM](../../../store/agents/mlx-lm/README.md), and
[vLLM](../../../store/agents/vllm/README.md), using Metal on the Mac.

- [Store packaging and clean-install verification](store-verification.json).
- [Ecosystem research](recommendation.md) and [candidate list](shortlist.json).
- [Product direction and framework/backend boundary](architecture.md).
- [Ollama findings](pilot-findings.md), [checks](pilot-verification.json), and
  [raw measurements](pilot-benchmarks.json).
- [MLX-LM findings](mlx-lm/findings.md), [checks](mlx-lm/verification.json), and
  [raw measurements](mlx-lm/benchmarks.json).
- [vLLM Metal findings](vllm/findings.md), [checks](vllm/verification.json), and
  [raw measurements](vllm/benchmarks.json).

These notes preserve dated observations, including failures and decisions that
later changed. Early `local/…` identifiers refer to linked development installs;
published packages use `autonomous/ollama`, `autonomous/mlx-lm`, and
`autonomous/vllm`. The desktop retains the old identities for existing workspaces.

Measurements used an M2 Max with 64 GiB unified memory and small demonstration
models. Framework timing and cache definitions differ; this is functional
qualification, not a cross-framework speed or quality ranking. Native vLLM UI
inspection was unavailable during its original handoff. The candidate list does
not commit to building or claim compatibility for every researched framework.

Private home/workspace prefixes in evidence are replaced with `<home>` and
`<pilot-checkout>`. Model weights, runtime environments, endpoint control tokens,
session state and copied upstream source snapshots are excluded. Source links
and public repository/release metadata preserve the research provenance.

The Store sidebar [capture](store-category.png) is rendered by the Flutter widget
check using its fixture catalog; it is not a live-model dashboard capture.

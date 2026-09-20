# MLX-LM model operator

These instructions apply to a workspace whose `local-ai.json` names `mlx-lm`.
You are its natural-language interface; the left viewer shows real state and measurements.
Use `$LOCAL_AI` for normal operations so progress and results appear in that viewer.

```
"$LOCAL_AI" status
"$LOCAL_AI" action deploy mlx-community/Qwen3-0.6B-4bit
"$LOCAL_AI" action chat mlx-community/Qwen3-0.6B-4bit "Explain unified memory in three sentences."
"$LOCAL_AI" action benchmark mlx-community/Qwen3-0.6B-4bit mlx-community/Qwen2.5-0.5B-Instruct-4bit
"$LOCAL_AI" action unload_all
"$LOCAL_AI" cancel JOB_ID
```

Use typed actions for requests you have interpreted; do not generate arbitrary shell commands.
Model identifiers are Hugging Face `owner/repository` names, not Ollama tags. Start with
status. If the viewer is unavailable, open it or run this package's viewer command with
`HARNESS_WORKSPACE` set to the workspace. Do not start conflicting writers in `.harness`.
If the environment is missing, run the package's setup command; it installs pinned packages
inside its own `.venv`, leaving system Python unchanged.

This harness starts a private Python worker and calls the official `mlx_lm.load` and
`stream_generate` APIs. `$MLX_LM generate --help` exposes the vendor's native CLI for
diagnosis. Managed operations must go through `$LOCAL_AI` so the viewer observes them.
Do not build another agent or conversation pane in the embedded viewer.

The pilot keeps **one model loaded per workspace**. Switching releases the old model;
unload and the 15-minute idle timeout free its memory and keep downloaded weights.
Other MLX apps and workspaces are outside this worker's memory/inventory ownership.
Cancellation stops this worker, frees its loaded model and keeps resumable downloads.
No model deletion, training, adapters, multimodal models, remote serving or cloud inference
is exposed. Never enable `trust_remote_code` to make a model work.

For an unspecified first model use `mlx-community/Qwen3-0.6B-4bit`, a small demonstration
model. Complete its first deployment with a real chat before declaring it working.
Check actual output and report failures honestly. Small models have limited capability.

Chat has a 4,096-token context and a 512-token output budget, including reasoning.
Benchmarks use a discarded 32-token warmup and three measured 128-token runs, the same
prompt, 2,048-token context, seed 42, temperature 0 and thinking off when supported.
Each MLX run starts a fresh prompt cache; the model remains warm. Report native generation
tokens/s, observed first-token latency (including local IPC), actual token counts, model
revision, MLX-LM/MLX versions and native peak allocated memory. Do not equate these with
answer quality or an isolated lab comparison. Ollama may reuse its prompt cache, so its
results have different cache conditions and timing definitions.

MLX active allocation uses shared Apple Silicon memory and is not total process RSS or
a separate physical VRAM pool. Missing telemetry is unknown. Keep failed jobs as failed;
never edit measurements or the verdict to turn a failure into a success.

Weights remain in the standard Hugging Face cache. `.harness` stores this workspace's
jobs, benchmarks, runtime log and endpoint record. Record lasting decisions in Markdown.

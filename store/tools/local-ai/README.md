# Local AI harness development

Shared source for the independently installable [Ollama](../../agents/ollama),
[MLX-LM](../../agents/mlx-lm), and [vLLM](../../agents/vllm) packages. Each package
contains its own complete runtime and branded viewer. Installing one folder does
not require this development folder or either of the other harnesses.

`src/` owns the queue, runtime adapters, measurements, persistence and loopback
control API; `bin/` owns the agent's typed command runner; `dist/` is the source
HTML/CSS/JavaScript for the shared viewer. MLX-LM and vLLM build scripts specialize
its framework identity and telemetry. Their workers, dependency locks, agent
instructions and setup scripts live in their respective package directories.

From this directory, with Node 22+:

```sh
npm run build       # regenerate all three packages before committing
npm run check
npm test           # fixture and standalone-package checks; no model downloads
```

Generated `src`, `bin`, `dist`, and `toolchain/node.sh` files are committed inside
the packages because the Store fetches only the selected package folder. Edit the
shared originals here, then rebuild; edit framework workers and instructions in
the package itself. No npm dependencies or global Python changes are required.

The opt-in `test:live`, `test:mlx-live`, and `test:vllm-live` commands use real
local models and GPU memory. Read each script before running it: they load,
benchmark, cancel and unload the small demo models. Start the corresponding
viewer first for Ollama/MLX-LM. Fresh evidence goes in ignored `evidence/`.
The vLLM script starts and stops its own workspace server.

See the [dated research and qualification evidence](../../../docs/research/local-ai-harnesses/README.md).

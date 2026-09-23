# Models: discover, start, select

A single violet brain opens the Models popover beside Harness Monitor. It silently checks this computer and lists all
compatible chat models from Grid's paginated hardware-fit catalog, including supported multimodal
chat models. One fitted version per model keeps the list simple. A completed fitting download is
preferred to another download; an existing locally managed deployment remains restartable after Pause.

The interface follows Harness Monitor: search, All / Running filters, plain rows,
and a second line for size and live metrics. Each model uses its own logo, with the brain as a
fallback. Typography, search, filter chips, and icon controls use the same scale as Harness Monitor.
Play/pause tooltips explain the memory and download behavior. Running models come first, then downloaded models,
then compatible choices. A useful smaller download leads the available choices. There is no hidden
model list, setup card, Chat button, or Use action.

- **Play** checks the machine again, downloads if necessary, installs the existing Grid engine,
  loads the model, and tests a real reply. Progress stays on its row. Repeated clicks join the
  same operation; the panel and conversation do not own its lifetime.
- **Pause** unloads the exact Grid-managed local engine and keeps the download. External endpoints
  and other computers are not stopped by these controls.
- **Select** a running model in an existing session's visible model picker. Starting a model never
  creates a session, sends a conversation message, or changes the current session's model.
- **Model Manager** remains a quiet advanced link. Its stable Grid package ID is unchanged; the
  package is bundled and a local manager is prepared without moving the workspace. Setup no
  longer depends on a seeded chat task or an LLM account.

Rows show size in GB without download or state labels. Running models also show observed decode
throughput and completed requests over Grid's actual reporting window where those
metrics can be attributed to the model. Machine memory is labelled at the machine level. No engine
or system memory figure is presented as a model's RAM footprint, and absent telemetry stays absent.

The daemon exposes encrypted inventory/start/stop RPCs over the existing connection. It keeps
atomic operation receipts, serialized machine mutations, and imported-model metadata. A lost reply
is reconciled through status, never automatically replayed. Restarted daemons mark unfinished
operations interrupted; they do not silently resubmit a deployment. Grid owns downloads, engine
installation, process identity checks, and inference. Credentials stay in the daemon's memory and
Grid's existing credential store, not in RPC replies, operation files, or logs.

The pinned Grid runtime restarts its engine union when a built-in model is added. The simple Start
flow therefore asks to stop the current local model first, before downloading another. Existing
shared-runtime setups go through Model Manager for changes that could interrupt sibling engines.
The UI does not imply that all individually compatible models can be loaded simultaneously.

Discovery caches machine-fit results for five minutes, refreshes live state while the popover is
open or an operation is active, and polls only once a minute otherwise. The session picker remains the explicit handoff to the first local response.

Validation is recorded in [the test report](../testing/local-models-2026-09-23.md), including
coverage boundaries, native click-through findings, baseline failures, and reproduction commands.

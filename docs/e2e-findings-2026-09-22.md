# E2E grid-switch — finding 2026-09-22: codex resume onto a grid fails after an MCP call

**Symptom.** A codex 0.155.x session that has called an MCP tool on its own login, moved onto a grid
model (any node: `Qwen/Qwen3.8-27B`, `DeepSeek-V4-Flash-0731`) and resumed, never answers again:
`■ stream disconnected before completion: transient provider recovery exhausted`. A FRESH session
on the same grid model answers fine — which is why "switching in the app works" and this only shows
up in the real scenario (use the person's tool + MCP, then switch, keep talking).

**Root cause (isolated with a curl replay, no harness involved).** The relay answers the resumed
request with `event: response.failed` / `error.code: server_error "transient provider recovery
exhausted"`. The replayed history contains two Responses item types codex emits when it loads a deferred
MCP tool — `tool_search_call` / `tool_search_output`. Not new in 0.155: on by default since
`rust-v0.150.0` (upstream #29486, 2026-06-22; features `tool_search` / `tool_search_always_defer_mcp_tools`
are "Removed" = baked in). It surfaced today because the scenario (use an MCP tool on the vendor, THEN
switch) had never been run — the e2e must run on a schedule, not only when a version changes. Removing ONLY those two
items from `input` makes the same request complete (`RESUME_40+2` — the model even recalls the
conversation). `reasoning` items (with `encrypted_content`) and `function_call` items are harmless.

| replayed request                          | relay result                      |
|-------------------------------------------|-----------------------------------|
| as recorded (resume history)              | `response.failed` server_error    |
| minus `tool_search_call/_output`          | `completed`, answers + recalls    |
| minus `reasoning` only                    | `response.failed`                 |
| minus `reasoning` + `tool_search_*`       | `completed`                       |

**Where to fix.** The grid relay, when forwarding a Responses request to a non-OpenAI provider:
drop (or translate) `tool_search_call` / `tool_search_output` input items — they are discovery
bookkeeping; the real call is the `function_call` that follows. Codex cannot be told to stop
emitting them.

**Repro.** `cli/src/e2e/runGridSwitchTrace.ts` (live, creates its own agent) reproduces it on every
run at `grid / recall`; the isolated replay is a `POST <grid>/relay/v1/responses` with the recorded
`input` minus the two item types (script kept in the run's scratch folder during the session).

**Side notes from the same runs.**
- codex 0.155.0 → 0.155.1 got upgraded on this Mac by run 3 (the probe's Enter landed on the
  "Update now" dialog; now answered with Skip before any check).
- The codex subscription hit its usage limit during these runs (`You've hit your usage limit`);
  the subscription leg cannot run again until it resets.

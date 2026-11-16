# Real-engine daemon e2e: opt-in design and first prototype

Status: draft, 2026-10-06. The prototype's authenticated flows have not run: this QA host has Claude Code 2.1.280 and Codex 0.160.0, but neither an environment OAuth token nor an API key. Its auth-free native tmux and resume suites passed. A successful preflight or typecheck is not a live-engine pass.

## Why this suite

The [real CLI record audit](2026-10-06-real-cli-record-audit.md) found drift where synthetic transcripts cannot establish what the installed CLIs actually do: aborted tool output, a queued human message, `/compact`, and Codex's sub-agent activity records. Keep the fast fake-engine e2e suite. Add a separate, explicitly invoked test of the real terminal → native record → daemon reader → app-frame path.

The product contract is what a window receives and what history returns. The real engine must create every native record; the suite must not write a rollout, call a fake-engine command, inject a completion hook, or substitute a model response. When a model does not perform the requested action, that case fails as a precondition/model failure with evidence; it never silently passes or retries until green.

## Invocation and boundaries

`REAL_ENGINES=1 npm run test:e2e-real` runs a separate Vitest configuration and test directory. Neither the normal unit glob nor the normal e2e glob includes it. No workflow invokes it. Both the entry point and configuration reject CI, even if `REAL_ENGINES=1` is accidentally set there. Pure policy tests may run in CI; they cannot import the live fixture or launch an engine.

The prototype is `cli/real-e2e/flows.e2e.ts`: four cases per selected engine and one additional Codex sub-agent case (nine with both engines). `cli/scripts/real-engine-e2e.ts` owns preflight, the private environment, redaction and the watchdog. It accepts no Vitest CLI overrides that could change isolation or write raw reports. `REAL_ENGINE_REPORT=/absolute/new-file.log` optionally saves its redacted output; an existing file is never overwritten.

Select `REAL_ENGINE=claude`, `codex`, or `all` (default). Provide credentials through the launching environment only:

- Claude: `CLAUDE_CODE_OAUTH_TOKEN`. Drop other Anthropic credentials/providers so precedence cannot silently choose a different account.
- Codex: `CODEX_API_KEY` or `OPENAI_API_KEY`, forwarded as an environment variable referenced by a fresh custom provider's `env_key`. Never run `codex login` or write `auth.json`.
- Pin models for reproducibility with `REAL_CLAUDE_MODEL` / `REAL_CODEX_MODEL`; record the selected model and installed CLI versions, not credentials.

Missing selected credentials are an unavailable preflight result with a nonzero exit, before an engine, tmux server or daemon is started. Never copy a real home, auth file, CLI settings, shell profile, plugin or MCP configuration. Never call `/login`, `/logout`, credential helpers or a keychain command. Credential values are not placed in shell argv, configuration text or diagnostics.

A sanitized launcher starts the test worker with a new HOME, XDG folders, TMPDIR, ZDOTDIR, CLAUDE_CONFIG_DIR, CODEX_HOME, daemon data/runtime/auth and npm cache. It clears inherited TMUX/TMUX_PANE and creates TMUX_TMPDIR. Every case gets its own IsolatedDaemon/private socket/free port; hook containment is checked before start and on cleanup. Replace the fixture's fake-engine launchers with references to resolved real binaries; refuse fallback to a fake. Model tools operate only on tiny synthetic project files.

A fresh Claude config contains only onboarding preferences; it does not pre-trust the folder for the trust case. A fresh Codex config contains only the provider, model and feature choices. Hooks are the hooks the daemon installs. Native hook-review screens are answered only after matching the expected screen and only for this fixture's generated hooks. Unexpected onboarding, policy, authentication or update screens fail visibly rather than being blindly accepted.

Claude documents OAuth environment authentication and per-config-directory credential isolation in its [authentication guide](https://code.claude.com/docs/en/authentication). Codex distinguishes noninteractive `CODEX_API_KEY` from a provider's explicit `env_key` in its [environment reference](https://learn.chatgpt.com/docs/config-file/environment-variables#authentication-and-network) and [provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers). The prototype uses that provider configuration for the interactive TUI. These are configuration contracts, not evidence that this unrun prototype authenticates successfully.

## Initial flow matrix

| Flow | Real stimulus and synchronization | Required evidence |
| --- | --- | --- |
| Message during folder trust, both engines | Launch in an existing untrusted disposable Git folder. Wait for the actual trust screen, then send a tagged app message. | Targeted refusal names trust; screen remains up; no turn starts and message was not typed. Explicitly trust this folder, resend, then exactly one completed turn and one history message. No automatic trust for the first attempt. |
| Cancel during a tool, both engines | Ask for the provided local hold command. The command writes a start marker and waits on a release file with a hard deadline. Wait for both marker and live tool_start before app cancel. | Turn ends, late native aborted output creates no second turn; agent reaches idle; next tagged turn works once. Cleanup releases the bounded tool even after failure. |
| `/compact`, both engines | A real turn reads a bounded synthetic context file. Type `/compact` into the real prompt. | Native compact record and context_compact observed; no phantom working turn; history survives; the next tagged turn starts/ends exactly once. Unsupported command or insufficient context is a failed precondition, not a skip. |
| Human message while busy, both engines | While the same marked tool is running, type a distinct message in the pane, then release the tool. | Both user messages occur once in session_get; no lost message or stuck activity. Claude's queued_command joins its current turn; Codex may open its established separate turn card. Assertions follow each engine's observed contract. |
| Codex sub-agent | Explicitly request one child to read a three-line fixture and return its count. Enable the installed CLI's collaboration feature. | Actual spawn, child-start, child-completed and child-report records; the daemon's Task card contains the child report and finishes successfully, live and when replayed through session_get. No fabricated child transcript. |

## Failure and resource policy

One worker, bounded startup/turn/teardown waits, one attempt per case, and a whole-run deadline. Prompts are short, tools bounded and local, and compaction input has a fixed size. The runner does not switch models or increase retries after a rate-limit, billing, authentication or provider error. Those must be diagnosed separately from daemon assertion failures. Running the opt-in suite uses the selected accounts' inference quota.

The first prototype stops at the first failed case. Each case has a five-minute deadline, the local hold command expires after 90 seconds, and the whole run expires after 45 minutes. It does not yet classify provider failures automatically; the retained redacted pane and daemon log are the evidence for that diagnosis. UI selectors and native-record assertions are provisional until a credentialed run verifies them against the installed versions. In particular, a different trust/onboarding screen, a model refusing to spawn a child, or no actual compaction fails the case rather than weakening its assertion.

Retain only redacted diagnostics from fresh synthetic fixtures: engine versions/model choices, elapsed time, normalized frame types, assertion errors and relevant daemon/native record excerpts. Redact exact credential values before persistence. Do not dump process.env or keychain/auth files. Existing default e2e artifact capture is disabled here until its output passes the same redactor. Raw homes and rollouts are removed on every normal teardown, not uploaded to CI.

Close the app client, release the fixture tool, stop this daemon, and kill only its explicitly named private tmux server in finally blocks. A watchdog may terminate only the process group/socket registered by this invocation. No bare `tmux kill-server`, name-wide pkill, real daemon port, global installer or engine update. Preserve an unresolved cleanup failure as a failure, never as a passing case.

## Validation of the prototype

Before live validation: typecheck the script/fixture/config; test disabled/default invocation, CI rejection despite opt-in, missing credentials, selected-engine credential requirements, environment filtering and secret redaction. Confirm the default test globs cannot discover the live file. Auth-free checks demonstrate these boundaries only.

Then run each case once on an idle host with explicitly provided environment credentials and record the exact source, versions, models and results. Inspect the fresh native records to prove the intended real CLI transition occurred. Only after that evidence should the draft be considered for merge. Fix any daemon defect separately, with a deterministic unit and faithful fake-engine e2e regression before changing runtime code.

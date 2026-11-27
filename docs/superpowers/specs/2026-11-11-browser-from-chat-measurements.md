# Browser from chat: engine measurements (Task 0)

2026-11-11, on the person's Mac. Claude Code 2.1.322 (model `claude-opus-5-5`), codex-cli 0.163.0 (model `gpt-6.1-sol`
in its config). Harness CLI v0.6.19.

## How it was measured

The plan's route (two agents started with `harness new`) needs the `agents-start-agents` setting, which is off and
only the person may turn on. So:

- **Headless engines**, in a scratch folder, tiny prompts, naming no timeout:
  - Claude Code: `claude -p --permission-mode default --allowedTools Bash Read --no-session-persistence
    --output-format stream-json --verbose "<prompt>"` for steps 1, 2 and 4. Step 3 with no `--allowedTools`, once with
    `--permission-mode auto` (Harness's default, Auto) and once with `--permission-mode default` (Harness's Ask), the
    person's own `~/.claude/settings.json` rules in effect.
  - Codex: `codex exec --ignore-user-config -m gpt-6.1-sol -c model_reasoning_effort="low" --sandbox workspace-write
    --skip-git-repo-check --ephemeral --json "<prompt>"`. **All three runs failed before the model ran**: `401
    Unauthorized: Missing bearer or basic authentication in header`; `codex login status` says `Not logged in`
    (`~/.codex/auth.json` is absent). No sign-in was made. Codex's column is read from its binary and model catalog.
- **Harness's code** (this worktree), for how agents are launched (step 3) and what a typed line does (step 5).
- **Step 6** was timed in a shell outside a Harness pane.

These are not agents in Harness panes: no Harness launch flags or `TMPDIR`. Each cell says whether it was
**measured** headless or **read** from code, binary or docs.

## Results

| Measure | Claude Code 2.1.322 | Codex 0.163.0 |
|---|---|---|
| 1. Shell time, default | **Measured.** `sleep 80; echo done-80` was refused by the tool: `Blocked: sleep 80 followed by: echo done-80. … use run_in_background: true` (a leading `sleep` of 25 s or more is refused: binary, `Sio=25`). The model reran it in the background. A wait that is not `sleep` (`node -e 'setTimeout(…,80000)'`) **finished** in the foreground at 80 s. The 130 s one was **moved to the background at 120 s** (`timedOutAfterMs: 120000`: "Command did not complete within its 120s timeout and was moved to the background") and finished there. **Read** (binary): default 120,000 ms, max 600,000 ms (`BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`). | **Read** (binary strings, not measured). `exec_command`: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." After the wait, the model gets `Process running with session ID …` and polls with `write_stdin`. That is **moved to the background at 10 s**. `background_terminal_max_timeout = 300000`. The run-to-completion form: "Maximum command runtime. Defaults to 10000 ms", "terminated on timeout". |
| 2. Output kept | **Measured.** 200,000 characters: the agent got 2,435 characters, `Output too large (199.2KB). Full output saved to: <path>`, `Preview (first 2KB):` lines `000000` to `000038`, then `...`. The whole output was in a file it could Read. Where the cut falls: 580 lines (29,579 characters) came back whole. 600 lines (30,600 bytes) were saved to a file with the same 2 KB preview. **Read** (binary): "default 30000; values clamp to 4000-128000. Output past this is saved to a file and Claude receives a short preview plus the path." | **Read**, not measured. Model catalog for `gpt-6.1-sol` (embedded in the binary, and `~/.codex/models_cache.json`): `truncation_policy: {mode: tokens, limit: 10000}`. Notice strings: `Warning: truncated output (original token count: …)`, `… tokens truncated`. Characters kept: not measured. |
| 3. No asking (`harness …`) | **Read:** Harness starts it with `--permission-mode auto` unless the person picks another mode (`cli/src/engines/claude/launch.ts:7-15`, `cli/src/core/agents/launches.ts:525`, `desktop/lib/core/permission_modes.dart:21`). Harness adds allow rules for `harness --help` and for its verbs whoami, ps, search, machines, show, wait, new, close, send and tell. **`browser` is not one of them** (`cli/src/engines/facets/hooks.ts:97-99`, `cli/src/engines/claude/hookContract.ts:34-39`). **Measured, Auto:** `harness whoami`, `harness send --help` and the unlisted `harness status` all ran, with no permission denials. **Measured, Ask:** whoami and send ran. `harness status` was refused with `This command requires approval`. | **Read:** Harness starts it with `--approve-for-me` (`cli/src/engines/codex/launch.ts:3-8,19`). `~/.codex/rules/harness.rules` (written by Harness, `cli/src/engines/codex/hookContract.ts:28-35`) lets the same ten verbs run outside the sandbox without asking. **`browser` is not one of them.** Harness's own note on an unlisted verb: it "asked to leave the sandbox … or, in auto mode, a failed sandboxed try first" (`cli/src/engines/facets/hooks.ts:91-95`). Not measured. |
| 4. The image | **Measured.** Read tool on `$TMPDIR/browser/probe.jpg` (800×450 JPEG made with `sips` from a macOS desktop picture), with no question asked (`Read` was allowed in that run). Answer: "a cluster of five-petaled blossoms … plus one leaf, glowing violet-blue on a black background". That is correct. | **Read**, not measured. The binary has the `view_image` tool (`core/src/tools/handlers/view_image.rs`), and `gpt-6.1-sol` lists `input_modalities: ["text", "image"]`. |
| 5. A typed line | **Read**, the same for both engines (Harness's turn path, below). | Same. |
| 6. Start time | `harness whoami` ×20: p50 0.24 s, p95 0.27 s (the engine does not matter). | Same. |

### Step 5: a typed line, from the code

- **The path.** `CoreApi.turns.deliver` (`cli/src/core/deliveries.ts:111-115`) is the one path for the Wi-Fi device,
  Agent Messages and the orchestrator (`cli/src/core/api.ts:247-250`, `TURN_DELIVERERS` at `:934`). It writes through
  the core's input (`cli/src/core/input.ts`).
- **Mid-turn** (`sleep 60`). A typed delivery whose maker does not queue it in the engine's own input waits for an
  idle pane: "absent, every typed delivery waits for idle" (`cli/src/core/input.ts:67-69`, `paneHold` at `:179-184`).
  So the line arrives after the running turn ends, and starts a turn of its own.
- **At a question.** The pane reads `question_open` and the delivery is held. Only a person's message in a
  Claude pane closes the question, with Escape. "Never a permission prompt, an agent's message, another engine"
  (`cli/src/core/input.ts:220-235`). Any other line waits until the question is answered.
- **The turn it starts.** Every live turn's end makes a recap (`cli/src/lib/commander.ts:653-712`).
  `AgentNotifications.completed` gives `{kind: 'done'}` unless the turn is a replay, a sub-agent's, has no text, or
  has a question open (`cli/src/lib/agentNotifications.ts:24-31`). Nothing asks who started the turn. The
  `turn_summary` carries that notification (`cli/src/lib/commander.ts:822-832`). Desktop then raises
  `_raiseAlert(AlertKind.done)` (`desktop/lib/state/app_state.dart:23243-23261`): an unread mark, a sound, a banner, and
  an OS notification when the window is not in front (`:14703-14751`). It skips this only when that agent is on screen
  (`:14719-14721`). The Desktop window does not read the tier (`cli/src/services/recaps.ts:101-104`).

## The three results

- **`OUTPUT_CAP_CHARS`: 8,000.**
  - **Claude Code, measured:** it keeps a command's output whole up to its 30,000-character inline limit (29,579
    whole, 30,600 cut). Past that limit it gives a 2 KB preview and the path to the file.
  - **Codex, read:** it keeps 10,000 tokens. Assuming at least one character per token (true for ASCII; not checked
    for other scripts), that is at least 10,000 characters.
  - **The cap:** 80% of the smaller, 10,000, is 8,000, below 20,000.
  - **Not used:** read literally on the 200,000-character run, Claude's kept characters are its 2 KB preview (lines
    `000000` to `000038`, 1,989 characters). That would give 1,000, but it is the engine's own cut-and-save, the thing
    the CLI's cap replaces.
  - **To confirm:** Codex's characters kept, in a live run.
- **`HELP_TIME_LINE`: yes.**
  - **Codex, read from the binary, not measured:** it moves a command to the background after its 10 s
    `yield_time_ms` default.
  - **Claude Code, measured:** it ran 80 s in the foreground and backgrounded only at 120 s.
- **Stop rules:**
  - **An engine cannot read the JPEG.**
    - Claude Code: **not fired** (measured: read and described correctly).
    - Codex: **not measurable** here (not signed in). The binary has `view_image` and the model takes images.
  - **An engine asks the person for every `harness` command.**
    - Claude Code: **not fired** in Harness's default mode (measured: Auto ran all three with no question).
    - Codex: **not measurable** live. From the code, Harness's rules let its ten verbs run without asking.
    - **A gap the plan does not cover:** `harness browser` is outside both engines' allow rules
      (`HARNESS_AGENT_TOOLS`, `cli/src/engines/facets/hooks.ts:97-99`). Step 3's stand-ins `whoami` and `send` are in
      those rules, so they do not stand in for `browser`.
    - In Ask mode, Claude Code asks for an unlisted `harness` verb every time. This was measured with
      `harness status`: `This command requires approval`.
    - In Codex's default mode, an unlisted verb first fails a sandboxed try (`hooks.ts:91-95`).
    - No task in the plan adds `browser` to those rules.
  - **A typed line raises a recap or a notification: FIRED (from the code).**
    - Nothing in the turn path tells a delivered line's turn from a person's.
    - At that turn's end, Desktop gets a recap and a `done` notification, and raises an alert. Sound, banner and OS
      notification are skipped only while that agent is on screen.
    - The plan has no task to keep the core from this.

# E2E Grid-Switch Matrix — Plan

Goal: when a NEW version of a coding-agent tool (codex / claude) is acknowledged,
verify it against the **real** harness grid-switch journey (not a mock): an agent on its own
subscription is moved onto a grid model, resumed, checked that it still answers / uses tools /
has its MCP servers / spawns a subagent, then moved back to its own login and checked again — with every step/value logged under a
namespaced session so we can audit what each agent read and did, catch hallucination / wrong
decisions / wrong actions, and produce a review from a free-model watchdog.

---

## 1. Two layers of environment (decide A/B/C)

| Layer | What runs | Needs | Sandboxable? |
|---|---|---|---|
| **Controller** (drive + watchdog) | `gridSwitchDriver` + `paneProbe` (Node) + the opencode `e2e-watchdog` agent (free model) | Node, tmux, opencode | ⚠️ needs the pane: runs on the machine under test |
| **Under-test** (the machine being tested) | harness daemon + tmux + real codex/claude + grid sign-in | tmux, interactive login shell, **codex auth**, **claude login**, **grid sign-in** | ⚠️ only if you provision all login/state inside |

> **DECIDED: Option A — code-managed, ZERO-CONFIG, deterministic scripts on the real machine.**
> All logic lives in repo code (argv-package, matrix script, watchdog agent, session naming).
> Every parameter is auto-derived in code (self-discovering) — daemon port from `env.PORT`, machineId
> from the daemon, engine version from `--version`/`cli_version`, grid model picked automatically from
> available, grid endpoint/credential from the machine's grid login, session name from timestamp.
> No config file, no manual flags, no drift → consistent wherever the same prerequisites are met.
> Under-test reuses the already-running harness machine (codex auth/tmux/grid sign-in). No workflow
> container is required for consistency; a container is OPTIONAL only for the watchdog (read-only
> trace, no credentials) if blast-radius isolation is wanted later.

- **A ✔ (chosen) — code-managed scripts; under-test on the real machine.**
  Fastest, least manual deploy. Real machine already has `~/.codex/auth.json`, tmux, zsh.
  Watchdog runs on the machine (or optionally in an isolated container) and only reads the trace.
- **B — everything in a container sandbox.**
  More setup: must mount codex/claude/grid auth + tmux + harness and keep login state fresh
  for every matrix run. Rejected: too much manual ops.
- **C — split relay: loopback local relay for the relay/convert part ($0), separate real
  subscription→grid run on the real machine.**

---

## 2. Session naming — one name per run, auditable end-to-end

Convention: `session = <engine>@<version>-><testcase>@<grid-model>--<timestamp>`

Examples:
```
codex@0.155.0->grid-switch@grid:gpt-5-mini--20260921T1805Z
claude@2.1.278->back-home@opus--20260921T1810Z
claude@UNKNOWN->grid-switch@none--20260921T1820Z     # engine not logged in -> still nameable + notified
```

The SAME name is stamped on everything from one run:
```
trace-codex@0.155.0->grid-switch@grid-gpt-5-mini--ts.json   # driver step/value log
report-…json / trace-codex@0.155.0->…json                 # what the watchdog reads; its review is written back into it
report-codex@0.155.0->...md                                 # watchdog review output
```
`<engine>@UNKNOWN` is used when a tool is present but not logged in, so the run still has an
audit name and a NOTIFY instead of a hard failure.

---

## 3. argv-package — the real command the harness enters

Spawn is `tmux respawn-pane -k` with the engine argv from `buildEngineCommandArgv`
(`cli/src/lib/engineLaunch.ts`) + env/clearEnv from `launchOverrides.ts` → `gridLaunch.ts`.

- **codex → grid:** `codex [resume <session>] -c model_provider="grid" -c model_providers.grid.name=…
  -c model_providers.grid.base_url=<grid>/relay/v1 -c model_providers.grid.env_key=…
  -c model_providers.grid.wire_api="responses" -c model_providers.grid.supports_websockets="true"
  [-c web_search="disabled"]`; env `OPENAI_API_KEY=<grid token>`; clear vendor creds.
- **claude → grid:** `claude --resume <session> [mode]`; env `ANTHROPIC_BASE_URL=<grid anthropic relay>`,
  `ANTHROPIC_MODEL=<model>`; clear `ANTHROPIC_API_KEY`.
- **back to own login:** clearEnv of grid vars + respawn with `ownLoginProviderArgs` (codex re-reads
  `config.toml`; claude returns to its own `ANTHROPIC_*`).

The E2E matrix builds these argv itself (same builder) so it spawns exactly like the harness.

---

## 3b. Real-test models (fixed per user decision)

- **Subscription leg** (codex/claude answering on their OWN login) uses a fixed cheap model,
  enabled in the tmux launch (`cli/src/e2e/fixedModels.ts`):
  - codex → `gpt-5.5`
  - claude → `claude-sonnet-5`
  (codex/claude expose no model-list CLI, so these are explicit and tuneable in one place.)
- **Grid leg** picks the smallest available model automatically from `grid_models_list`.

---

## 4. Real-matrix flow (per engine × version)

```
1. prep: daemon + real agent in a tmux pane + engine login present
2. for each engine (codex/claude) × version:
     a. agent answers on its OWN subscription (real round-trip)
     b. driver -> agent_retarget grid (payload gridModel/gridName)
     c. harness respawns with grid argv; driver PINGS the engine; wait for answer from the GRID
     d. verify the answer came from the grid, not the old subscription
     e. driver -> agent_retarget clearGrid; verify back on own login
     f. write trace-<session>.json + per-engine log
3. engine not logged in  -> NOTIFY (no hard fail); still name the session @UNKNOWN
   grid not sign-in      -> NOTIFY (per decision)
```

Handles: refusal codes (AGENT_BUSY, RETARGET_UNSUPPORTED_BACKEND, GRID_UNAVAILABLE, …) as
surfaced results, and surfaces every step in the trace so a reviewer can audit what happened.

---

## 5. Where each piece lives (decided 2026-09-22)

Two repos, split by who owns the code under test:

- **autonomous-harness** (this repo) — the **driver**: `harness e2e plan` (trigger: installed vs
  latest) and `harness e2e grid-switch` (`cli/src/e2e/`): creates a fresh agent through the daemon,
  lays out the person's project (`tools/calc.sh` + MCP `e2e_calc`, `workspace.ts`), runs the
  conversation subscription → grid → back-home (`smokeChecks.ts` scenario: tool / mcp / recall,
  proven by the tool/MCP logs, `paneProbe.ts`), moves it with `agent_retarget` (own grid, or a
  relay under test via the `grid` override), and leaves a **review bundle** in
  `~/.harness/cli/data/e2e/runs/<session>/` (trace, daemon log slice, workspace logs, manifest).
- **autonomous-grid-cli** (`e2e/`) — the **reviewer and the fix loop**, next to the relay it fixes:
  `agents/e2e-watchdog.md` (system prompt) + `skills/e2e-watchdog/SKILL.md` (quick view, report
  fields, clean-run shape, find/reproduce, relay bisect, fix + PR rules, report shape),
  `install.sh` (sync into `~/.config/opencode`), `run.sh` (the cron entry: plan → grid-switch →
  `opencode run --agent e2e-watchdog … "Run report: <bundle>/trace.json. What got stuck?"` → bundle
  gains `watchdog.jsonl` + `watchdog.md` + the opencode session id to reopen), and `stack/` (a
  relay checkout under test: strict node, logging proxy, `matrix.sh`, the recorded requests).
- **The grid server** runs it: harness daemon + tmux + codex/claude logins + opencode (free model),
  cron `e2e/run.sh`. The e2e-watchdog reads the relay code in place, tests it, opens the PR there.

Verified 2026-09-22 on this Mac: the relay-commit matrix (`matrix.sh f5bbb4e 00fa887 22519fa
d6c5489 main` × recorded codex requests R/C/T) fails and passes exactly at the commit that fixed
each shape; `main` still fails T (`tool_search_*`, codex 0.155.1) — the open ticket for the agent.

---

## 6. Cost / accounts (honest)

- **Watchdog:** $0 (opencode free model, verified).
- **Real matrix** (`subscription -> grid -> back`): each grid ping costs real tokens against the
  codex/claude subscription + grid model. Small per run, but real. **Accepted** per earlier
  direction; the offline driver spec (`gridSwitchDriver.spec.ts`) remains the $0 CI path.
- **Accounts needed:** codex (present ✅), claude (login pending ❌ -> notify), grid sign-in (pending ❌ -> notify).

---

## 7. Machine state today (verified)

| Item | Status |
|---|---|
| codex binary + auth | ✅ `~/.codex/auth.json` present |
| claude binary | ✅ present; login ❌ (no `~/.claude/.credentials.json`) -> NOTIFY |
| tmux / sqlite3 / zsh | ✅ present |
| opencode binary + free models | ✅ `opencode/big-pickle` verified cost 0 (reviewer only) |
| grid sign-in | ❓ not confirmed -> check+notify |

---

## 8. Operational loop (manual once, then fully automated)

**Manual once (user):** install harness + codex + claude on the server; sign in
codex / claude / grid. This is the ONLY manual step.

**Then automated (no manual action):**
1. boot harness daemon if not running
2. detect current versions (codex/claude/grid) from `--version`/`cli_version`
3. update to latest when a new version is acknowledged
4. run the matrix E2E per version: subscription -> switch grid -> real ping -> verify -> back home
   (session naming for auditability)
5. missing login / not signed in -> NOTIFY, no hard fail
6. watchdog (opencode `e2e-watchdog` agent + skill, free model) reads the trace -> what stuck, reproduced, PASS/FAIL + notice

---

## 9. Build order (pending env choice A/B/C)

1. **argv-package** — expose the exact grid/back-home command builder the matrix reuses.
2. **real-matrix script** — driver + switch + ping + verify + notify, with session naming.
3. **watchdog** — opencode `e2e-watchdog` agent + skill, smoke checks per leg, pane probe. ✔
4. CI/scheduling wrapper for when a new version is acknowledged (per-version, not blanket).

**BLOCKED ON:** env choice (A/B/C) + confirming grid sign-in + claude login (or notify-only).

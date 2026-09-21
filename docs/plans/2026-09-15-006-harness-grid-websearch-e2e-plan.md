# Web search on a Local model — manual end-to-end plan

Status: **run 2026-09-15, all runs green** — see §Outcome · written to be RUN BY AN AGENT from a terminal, no GUI required
Verifies: `2026-09-15-005-harness-grid-websearch-plan.md` §Testing item 6, and ticket 02's two
live-grid bullets (the `harness` server appears, `web_search` / `web_read` answer, the native tools
are gone, the cards are native, returning to the Subscription model restores everything).
Code under test: ticket 02 = `7a1660d`, merged with `origin/main` as `56b5e2b` on
`feat/harness-grid-websearch`. Ticket 01 (neutral strings) is live on the dev control plane.

## Facts this plan rests on (read on 2026-09-15, not assumed)

| Fact | Evidence |
|---|---|
| Dev control plane `https://api-grid.autonomousdev.xyz`; `grid-apis.service` restarted 06:21 with `GRID_WEB_MCP_ENABLED=1`; its pinned CLI is `/opt/grid-public-0.3.46/bin/grid` | nginx `server_name`, `/etc/grid-apis/grid-apis.env` on `grid-dev` |
| Dev mount answers an unauthenticated POST `401 {"detail": "This credential was refused or has expired. Refresh it and update this MCP server's configuration."}` — ticket 01's text; prod still answers the old "grid" sentence | `curl -X POST …/v1/grid/web-mcp/` on both |
| `harness login` hands the **Autonomous account access token** (prod SSO) to `grid login --harness` on stdin; `grid` POSTs it in the body to `<plane>/v1/grid/auth/harness`; grid-apis introspects it at `GRID_ACCOUNT_API_BASE_URL`, **unset on grid-dev → production `apiv2.autonomous.ai`** — so a prod harness sign-in is exactly what dev accepts | `cli.ts:500-520`, `gridHandoff.ts:90`, autonomous-grid `remote/control_plane.py:75-97`, grid-apis `handler.py:1593`, `account_api.py:55` |
| The plane `grid` talks to is `explicit > stored api_url > GRID_CONTROL_PLANE_URL > prod`; `GRID_HOME` moves the whole credential home. This Mac's `~/.grid` is signed into prod | autonomous-grid `remote/credentials.py:154`, `shared/paths.py:22`; `grid --remote mcp config` listing |
| Only `harness login` (not `harness grid login`) mints the grid name (`POST /api/grid/name`, `<email-local-part>-<8 hex>`) and runs `ensureHarnessGrid` (`sync`/`ls`/`start`/`sync`). An already-signed-in `harness login` skips the browser and still does both | `cli.ts:525-580` (`succeed` → `attachGridToSignIn`), `cli.ts:688-722` |
| This repo's "local stack" (`desktop/scripts/start-terminal-local-manual.sh`) runs the backend in **API-key mode with no SSO** and needs a sibling `../autonomous-code` (absent here) — so it can produce no account token and no hand-off | the script; `ls ../../autonomous-code` empty |
| The installed `harness` is `~/.harness/cli/cli.js` v0.2.20-dev (Sep 14, predates 02); a daemon started from `node cli/dist/cli.js` **never self-updates** (inode check) | `cli.ts:4194-4201` |
| The daemon serves a local WebSocket at `http://127.0.0.1:18473/api/local-ws` — the transport the desktop uses on this machine. Handshake: no `Origin` header, first frame `machine_select {machineId, localProtocolVersion: 1}` → `connected`; then any frame; replies are `<type>_result {requestId, …}`; `e2ee: false`. The picker's model list is the frame `grid_models_list` → `{models: [{id, node}]}` | `localWsServer.ts:250-284`, `backendSocket.ts:985-991,1420-1426`; `curl 127.0.0.1:18473/api/status` → `machineId` |
| Live agents today: two Claude Code panes `%1`, `%2` (cwd `BC_whitepapers`) on the DEFAULT tmux server — not to be touched. A registry row carries `agentId`, `engine`, `tmuxPane`, `sessionId`, `transcriptPath` | `~/.harness/cli/data/registry.json`, `tmux list-panes -a` |
| Codex is signed in on this Mac ("Logged in using ChatGPT") | `codex login status` |
| Text models running on the 8x5090 boxes (via `cmc-8x4090-noproxyjump`): `cmc-8x50903:8100` and `:8200` `qwen/qwen3.6-35b-a3b` (vLLM, `--enable-auto-tool-choice --tool-call-parser qwen3_xml`, 0 % util); `cmc-8x50902:9096` `Qwen/Qwen3.8-27B-FP8` (`qwen3_coder`, serving prod, GPUs ~95 %); `cmc-8x50901` DeepSeek-V4-Flash on loopback `:1919` with `--max-running-requests 1`, GPUs at 100 % | `nvidia-smi`, `ps`, `curl /v1/models` on each |
| A grid node **polls** the relay for work; the relay never dials the node, so a Mac behind NAT joining a loopback endpoint is a supported shape | autonomous-grid `remote/serve.py:4-6` |

## Decisions

**D1 — Harness: this branch's CLI, the prod harness backend; grid: dev.** The harness backend's
only jobs here are SSO, minting the grid name, and relaying frames — prod does all three and this
Mac is already signed in. A local backend cannot take part (no SSO, see facts). The daemon is run
from `cli/dist/cli.js` with a dev grid home, on the existing data dir so the machine identity and
session are reused:

```sh
export GRID_HOME=~/.grid-dev                                   # fresh home → no stored prod api_url; ~/.grid untouched
export GRID_CONTROL_PLANE_URL=https://api-grid.autonomousdev.xyz
export HARNESS_GRID_BIN=/tmp/grid-shim                        # Setup S4 — logs every grid argv; drop it to skip
```

Every `harness`/`node cli/dist/cli.js` invocation below, and `grid join`, runs with these exported.
`gridExec` and `handOffToGrid` spawn `grid` with the daemon's own environment, so a daemon started
from a shell without `GRID_HOME` talks to prod and the run is silently wrong.

**D2 — Model: `qwen/qwen3.6-35b-a3b` on `cmc-8x50903:8100`, tunnelled.** Idle, tool-calling on,
fast MoE. Fall back to `cmc-8x50902:9096` (`Qwen/Qwen3.8-27B-FP8`) if it fumbles two-step tool use.
Skip DeepSeek on 50901 (one busy slot).

**D3 — Driver: the daemon's local WebSocket, not the app.** A small Node script speaks the same
frames the desktop sends (`grid_models_list`, `agent_create`, `agent_retarget`, `agent_delete`);
prompts go in with `tmux send-keys`, the pane is read with `tmux capture-pane`, and the transcript
cards are proven by replaying the engine's transcript through the daemon's own normalizer
(`dist/lib/normalize.js`, `dist/engines/codex/normalizer.js`) — the code path that feeds the
desktop. Running the desktop app alongside is optional (to see the cards with eyes); nothing here
depends on it.

## Setup

**S1 — build and swap the daemon.**
```sh
cd ~/Projects/autonomous-harness/cli && git rev-parse --short HEAD          # 56b5e2b or later
npm run build                                                               # per-file dist/: dist/cli.js (daemon) + dist/lib/*.js (replay)
harness stop                                                                # the installed v0.2.20-dev daemon
node dist/cli.js start                                                      # env from D1 exported; self-update is off for a checkout run
node dist/cli.js status                                                     # running · backend wss://harness-api.autonomous.ai
tail -f ~/.harness/cli/data/harness.log                                     # keep open
```
Expect the log's first lines to include `[update] self-update off · running a dev/repo build`.

**S2 — sign the grid side into dev and get the harness grid created there.**
```sh
node dist/cli.js login                     # already signed in → no browser; runs the hand-off, mints the name, ensures the grid
```
Expect on stderr `Created your private grid '<name>'` (or nothing, if it existed). Then:
```sh
grid --remote ls --json | jq -r '.[] | "\(.grid) \(.type) \(.id)"'         # GRID_HOME=~/.grid-dev: the <name>, permissioned-public
grid --remote mcp config                                                    # listing: url: https://api-grid.autonomousdev.xyz/v1/grid/web-mcp/ — no token
env -u GRID_HOME grid --remote ls --json | jq -r '.[].grid'                 # prod home: <name> is NOT there — the isolation held
```
The daemon must be RESTARTED after this (S1's daemon connected before the name existed and
`machine_meta.gridName` is pushed on connect): `node dist/cli.js stop && node dist/cli.js start`.
Then `curl -s 127.0.0.1:18473/api/status | jq .connected` → `true`.

**S3 — tunnel and join the model.** Own tmux window, left running:
```sh
ssh -N -L 8100:127.0.0.1:8100 cmc-8x50903
curl -s http://127.0.0.1:8100/v1/models | jq -r '.data[].id'               # qwen/qwen3.6-35b-a3b
grid --remote join -m qwen/qwen3.6-35b-a3b --at http://127.0.0.1:8100/v1 <name>   # blocks; GRID_HOME=~/.grid-dev — ⚠️ WITH /v1: `remote/probe.py` posts to `<at>/chat/completions`, so a bare host:port 404s every capability probe and the node registers `tools: false` (relay answers `400 No active provider for this model supports tools`)
grid --remote models <name> --json | jq -c '.[] | {model, node, engine}'  # the model, node = this Mac
```
The id the engine must be handed is the RELAY's spelling — `grid models` lowercases it
(`gridModels.ts`); read it from the daemon's own list instead: driver `models` below.

**S4 — the `grid` argv shim** (what makes the cache and the call order observable):
```sh
cat > /tmp/grid-shim <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> /tmp/grid-calls.log
exec /Users/macbookpro/.local/bin/grid "$@"
EOF
chmod +x /tmp/grid-shim; : > /tmp/grid-calls.log
```
(`HARNESS_GRID_BIN` is read by `gridExec`, i.e. the daemon's calls; the hand-off in S2 uses PATH.)

**S5 — the driver.** `/tmp/hd.mjs`, run from `cli/` so `ws` resolves:
```js
// node /tmp/hd.mjs <cmd> [args]   — models | create <engine> <cwd> | retarget <agentId> <model> | clear <agentId> | delete <agentId>
import { WebSocket } from 'ws'
const [cmd, ...a] = process.argv.slice(2)
const status = await (await fetch('http://127.0.0.1:18473/api/status')).json()
const ws = new WebSocket('ws://127.0.0.1:18473/api/local-ws')          // no Origin header: loopback trust
const once = (t) => new Promise((res) => { const h = (raw) => { const f = JSON.parse(raw); if (f.type === t) { ws.off('message', h); res(f.payload) } }; ws.on('message', h) })
await new Promise((r) => ws.once('open', r))
ws.send(JSON.stringify({ type: 'machine_select', payload: { machineId: status.machineId, localProtocolVersion: 1 } }))
await once('connected')
const rpc = async (type, payload) => { const requestId = `hd-${Date.now()}`; const p = once(`${type}_result`); ws.send(JSON.stringify({ type, payload: { requestId, ...payload } })); return p }
const frames = {
  models:   () => rpc('grid_models_list', {}),                             // { models: [{id, node}] } — the picker's list
  create:   () => rpc('agent_create', { engine: a[0], cwd: a[1], bypassPermission: true }),
  retarget: () => rpc('agent_retarget', { agentId: a[0], gridModel: a[1] }),
  clear:    () => rpc('agent_retarget', { agentId: a[0], clearGrid: true }),
  delete:   () => rpc('agent_delete', { agentId: a[0] }),
}
console.log(JSON.stringify(await frames[cmd](), null, 2)); ws.close()
```
`bypassPermission: true` so the MCP tool call is not parked on a permission prompt nobody is there
to answer — hence a throwaway `cwd` under `/tmp`.

**S6 — the pane and the transcript.** After `create`, the reply's `agent.agentId` names the row in
`~/.harness/cli/data/registry.json`; its `tmuxPane` (`%N`) is on the default tmux server:
```sh
tmux send-keys -t %N 'Search the web for the current Bitcoin price and read the top result.' Enter
sleep 20; tmux capture-pane -p -t %N -S -60
```
Transcript replay (the cards): the row's `transcriptPath` once the session is bound (Claude Code:
`~/.claude/projects/<cwd with / → ->/<sessionId>.jsonl`; Codex: `~/.codex/sessions/YYYY/MM/DD/…`).
```sh
node -e 'import("./dist/lib/normalize.js").then(m => { const lines = require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean); for (const e of m.messagesToEvents(lines)) if (e.type==="tool_start"||e.type==="tool_end") console.log(e.type, e.payload.tool, JSON.stringify(e.payload.input??"").slice(0,80)) })' <transcript.jsonl>
```

## Run A — Claude Code

| # | Do | Expect | Pins |
|---|---|---|---|
| A1 | `mkdir -p /tmp/e2e-claude && node /tmp/hd.mjs create claude /tmp/e2e-claude` → `AGENT`; prompt via S6: *"What is on the front page of news.ycombinator.com right now?"* | Pane answers; replay shows `tool_start WebSearch` / `WebFetch` (native). Baseline. | — |
| A2 | `node /tmp/hd.mjs models` → copy the exact `id`; `node /tmp/hd.mjs retarget $AGENT <id>` | Reply `{retargeted: true}`. Pane respawned with `--resume`; the A1 answer still on screen. Log: `[grid] claude -> <name> (grid-…) · <id>`, **no** `web tools unavailable`. `/tmp/grid-calls.log`: `--remote mcp config <name> --json` **above** `--remote info <name> --env`, then `--remote ls --json`. | 02 §4 |
| A3 | `PID=$(pgrep -n -f 'claude .*--resume'); ps -Eww -o args= -p $PID` (argv, then env; own processes only — NOT `tmux show-environment`: a retarget sets variables on the respawned PROCESS, `tmuxBackend.ts:178`) | argv has `--disallowedTools=WebSearch,WebFetch` and `--mcp-config {"mcpServers":{"harness":{"type":"http","url":"https://api-grid.autonomousdev.xyz/v1/grid/web-mcp/","headers":{"Authorization":"Bearer ${GRID_API_KEY}"}}}}` — the variable NAME; the env part has `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `GRID_API_KEY`. `ps -o args= -p $PID | grep -c eyJ` → 0. | 02 §7, §8 |
| A4 | `tmux send-keys -t %N '/mcp' Enter; sleep 3; tmux capture-pane -p -t %N`; then select `harness` (`Enter`), capture; `Escape` ×2 | One server **`harness`** · connected · tools `web_search`, `web_read`; descriptions *"Search the live web."* / *"Read the main text of up to five web pages."* — no "grid" anywhere on screen. | 02 §1, ticket 01 |
| A5 | Prompt: *"Which web tools do you have? List their exact tool names and nothing else."* | Names `mcp__harness__web_search`, `mcp__harness__web_read`; does NOT name `WebSearch` or `WebFetch`. | 02 §1 |
| A6 | Prompt: *"Search the web for the current Bitcoin price and read the top result."*; wait; capture; replay | Pane: two tool calls with real results, no `API Error: 400 Unsupported tool type`, no `503`. Replay: `tool_start WebSearch {"query":…}` then `tool_start WebFetch {"urls":[…],"url":…}` — never `mcp__harness__…`. | 02 §1, §9 |
| A7 | `node /tmp/hd.mjs clear $AGENT` | `{retargeted: true}`; new pid: `ps -Eww` has none of `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, `GRID_API_KEY`; argv has no `--disallowedTools`, no `--mcp-config`; `/mcp` lists no `harness`; A1's prompt replays as native `WebSearch`. | 02 §10 |
| A8 | `node /tmp/hd.mjs retarget $AGENT <id>` again | `/tmp/grid-calls.log` gains `info --env` and `ls` but **no second** `mcp config` — the entry is fresh (365-day token). | 02 §5 |
| A9 | `node /tmp/hd.mjs delete $AGENT` | Pane gone from `tmux list-panes -a`. | cleanup |

## Run B — Codex

| # | Do | Expect | Pins |
|---|---|---|---|
| B1 | `mkdir -p /tmp/e2e-codex && node /tmp/hd.mjs create codex /tmp/e2e-codex`; A1's prompt | Baseline answer; replay (Codex normalizer) shows `WebSearch`. | — |
| B2 | `retarget $AGENT <id>`; `PID=$(pgrep -n -f 'codex .*-c model_provider'); ps -Eww -o args= -p $PID` | argv: `-c web_search="disabled"`, `-c mcp_servers.harness.url="https://api-grid.autonomousdev.xyz/v1/grid/web-mcp/"`, `-c mcp_servers.harness.env_http_headers.Authorization="GRID_MCP_AUTHORIZATION"`; env: `GRID_API_KEY`, `GRID_MCP_AUTHORIZATION=Bearer …`; no token in argv. | 02 §2, §7 |
| B3 | `/mcp` in the pane | `harness` with two tools. | 02 §2 |
| B4 | A6's prompt; replay the rollout through `dist/engines/codex/normalizer.js` (`new CodexNormalizer('replay')`, `ingest` each line) | Calls spelled `mcp__harness__web_search` / `web_read` (or `name`+`namespace: mcp__harness`; or code-mode `tools.mcp__harness__…(…)`) — replay shows `WebSearch` / `WebFetch` regardless. | 02 §2, §9 |
| B5 | `clear $AGENT`; `ps -Eww` on the new pid; `delete $AGENT` | No `GRID_API_KEY`, `GRID_MCP_AUTHORIZATION`; argv has no `web_search=`, no `mcp_servers.harness`. | 02 §10 |

## Run C — degraded path

```sh
cat > /tmp/grid-old <<'EOF'
#!/bin/sh
case "$*" in *"mcp config"*) echo "grid: error: argument command: invalid choice: 'mcp'" >&2; exit 2;; esac
exec /Users/macbookpro/.local/bin/grid "$@"
EOF
chmod +x /tmp/grid-old
node dist/cli.js stop && HARNESS_GRID_BIN=/tmp/grid-old node dist/cli.js start
```
`create claude` → `retarget` → reply `{retargeted: true}` (no `error`); log has `[grid] web tools
unavailable for <name> · This machine's grid is older than 0.3.36 …`; argv still carries
`--disallowedTools=WebSearch,WebFetch` but no `--mcp-config`; `/mcp` lists nothing; a plain prompt
still answers (inference intact). Pins 02 §3, §6 live. Then `delete`, and restart with the S4 shim.

## Evidence to keep

Per run: the daemon log lines, `/tmp/grid-calls.log`, one `ps -o args=` per direction (argv only —
never paste the `-E` env part, it holds the token), the `/mcp` capture, the replay output, and
versions (`claude --version`, `codex --version`, `grid version`, `node dist/cli.js version`).
Paste under the two live bullets in the ticket and tick them.

## Teardown

```sh
node /tmp/hd.mjs delete <any test agent left>
grid --remote leave <name>            # GRID_HOME=~/.grid-dev; unregisters this Mac's node; then close the ssh tunnel
node dist/cli.js stop
harness start                          # the installed daemon, prod grid home, as before
harness status && tmux list-panes -a   # %1 and %2 still there
```
The dev grid `<name>` and `~/.grid-dev` may stay; they cost nothing and the next run reuses them.

## If it does not work

| Symptom | Where to look |
|---|---|
| `machine_select` closes with 4403 | `machineId` must be `/api/status`'s; `localProtocolVersion` must be `1`; no `Origin` header |
| `agent_retarget_result` has `error: GRID_UNAVAILABLE` | `grid-calls.log`: did `info --env` run with `GRID_HOME=~/.grid-dev`? Is `<name>` in `grid --remote ls` there? Was the daemon restarted after S2 (`machine_meta.gridName`)? |
| `/mcp` shows `harness` **failed** | The URL in argv must end in `/`; `curl -X POST <url>`: 404 → `GRID_WEB_MCP_ENABLED`, 401 → token not this grid's (`node dist/cli.js grid login` again) |
| Inference `503 no_providers_available` | The id is not the relay's spelling — use the `models` driver output, not `ollama`/`vllm`'s |
| `WebSearch` still offered (A5) | The daemon on 18473 is the installed one: `curl …/api/status | jq .version` must NOT be `0.2.20-dev.bae1fc6` |
| Replay shows `mcp__harness__web_search` | `npm run build` was skipped — `dist/lib/normalize.js` predates 02 |
| A8 shows a second `mcp config` | Token within 30 days of `exp` or undecodable: `grid mcp config --json | jq -r .authorization | cut -d' ' -f2 | cut -d. -f2 | base64 -d` |
| `grid login --harness` answers 401/403 from dev | The harness session is not a prod one (`~/.harness/cli/data/auth-session` says `autonomousEnv`) |
| `grid join` says the engine is unreachable | The tunnel shell closed, or the port is wrong (`:8100` on 50903, `:9096` on 50902) |

## Out of scope here

`agent.grid.webSearch` and the picker/tooltip text (ticket 03); `agent_create` straight onto a
Local model (plan Q8); shipping ticket 01 to prod; the desktop app itself (D3).

## Outcome (run 2026-09-15 15:12–15:15, by the agent, from this terminal)

**Run A (Claude Code 2.1.272) ✅ · Run B (Codex 0.154.0) ✅ · Run C (degraded) ✅.** Ticket 02's two
live bullets are ticked with the evidence below. Deviations from the plan as written, and two
findings that are not this ticket's:

| What | Detail |
|---|---|
| No tunnel needed | The dev control plane already serves `qwen/qwen3.8-27b` and `deepseek/deepseek-v4-flash-0731` (`owned_by localagi-p2p`) into a freshly created grid; both answer `tool_calls` through the relay in 2–8 s. S3 stays as the fallback. |
| Prod harness backend has no `/api/grid/name` | `harness login` said `Could not read this account's grid name (HTTP 404); skipping grid setup` — the `feat/harness-grid` backend is not on prod. The grid `kelvin-e2e09150` (`grid-bcba99c5d54a44a5`) was created on dev with the daemon's own `ensureHarnessGrid` (`dist/lib/gridEnsure.js`) and its name injected as a `machine_meta` frame over the local WS (driver `meta`). Every backend reconnect wipes it (the prod backend's `machine_meta` carries no `gridName`), so `meta` is re-sent before each retarget. |
| `~/.grid-dev` was not fresh | It held a dev session for a different account; the hand-off replaced it with this account's. Prod `~/.grid` untouched throughout. |
| **Finding 1 — daemon deadlock at start (pre-existing, not this branch)** | With `~/.cursor/projects` at 22k files / 6.9k dirs, `cursor-discovery`'s chokidar watcher hits `EMFILE`, closes the failing handle inside its own FSEvents callback, and libuv blocks the main thread forever in `uv__fsevents_close → uv_sem_wait` (`sample` shows 1372/1375 frames there). The event loop is dead: TCP handshakes complete but nothing is `accept()`ed, no frame is handled. Reproduced with the installed v0.2.27 as well; the same log has 76k `EMFILE` lines since Sep 11. Interim: `CURSOR_HOME=<empty dir>` on the daemon. Proper fix is a separate ticket (one recursive `fs.watch` / FSEvents stream instead of a handle per directory, and never `close()` from inside the watcher's error callback). |
| Finding 2 — self-update swapped the installed bundle | Starting the installed copy from this shell let its updater replace `~/.harness/cli/cli.js` (v0.2.20-dev.bae1fc6.dirty) with the published v0.2.27; no `.prev` was kept. Rebuild with `npm run bundle` if the dev bundle is wanted back. |

Evidence (argv shown, never the env part):

- A2 `/tmp/grid-calls.log`: `--remote mcp config kelvin-e2e09150 --json` → `--remote info kelvin-e2e09150 --env` → `--remote ls --json`; log `[grid] claude -> kelvin-e2e09150 (grid-bcba99c5d54a44a5) · qwen/qwen3.8-27b · retargeted eb2ee7f4 · resumed`.
- A3 argv: `--dangerously-skip-permissions --resume b5cc30a8-… --disallowedTools=WebSearch,WebFetch --mcp-config {"mcpServers":{"harness":{"type":"http","url":"https://api-grid.autonomousdev.xyz/v1/grid/web-mcp/","headers":{"Authorization":"Bearer ${GRID_API_KEY}"}}}}`; `eyJ` count 0; env names `ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_MODEL GRID_API_KEY`, `ANTHROPIC_BASE_URL=https://grid-llm.autonomousdev.xyz/grid-bcba99c5d54a44a5/relay`.
- A4 `/mcp`: `harness · ✔ connected · 2 tools`; `web_search` — "Search the live web. Returns {results: [{title, url, excerpt}]}."; `web_read` — "Read the main text of up to five web pages. …". (This Mac's own `~/.claude.json` also carries a hand-configured `grid-web` — the two-servers case the doc comment accepts.)
- A5 forced call: `Error: No such tool available: WebSearch. WebSearch is disabled for this session, in subagents as well as here.`
- A6 replay: `tool_start WebSearch {"query":"bitcoin price today current","num_results":5}` · `tool_start WebFetch {"urls":["https://coinmarketcap.com/currencies/bitcoin/"],"max_chars":6000,"url":"https://coinmarketcap.com/…"}`; raw transcript names were `mcp__harness__web_search` ×3 / `mcp__harness__web_read` ×3.
- A7 after `clear`: argv `--dangerously-skip-permissions --resume b5cc30a8-…` only; env has none of `ANTHROPIC_BASE_URL/AUTH_TOKEN/GRID_API_KEY` (`ANTHROPIC_MODEL=opus` is the agent's own subscription model, set on the way back); zero `grid` calls.
- A8 second retarget: `--remote info … --env` → `--remote ls --json`, **no** `mcp config`; argv carries `--mcp-config` again from the cache.
- B2 argv: `-c model_provider="grid" … -c web_search="disabled" -c mcp_servers.harness.url="https://api-grid.autonomousdev.xyz/v1/grid/web-mcp/" -c mcp_servers.harness.env_http_headers.Authorization="GRID_MCP_AUTHORIZATION"`; env `GRID_API_KEY`, `GRID_MCP_AUTHORIZATION=Bearer…`; `eyJ` count 0.
- B3 `/mcp`: `harness: connected (2 tools)`. B4 rollout: `function_call name: web_search namespace: mcp__harness` / `web_read`; replay → `WebSearch {"query":"current Bitcoin price"}`, `WebFetch {"urls":[…],"url":…}`. B5 after `clear`: no `web_search=`, no `mcp_servers.harness`, no grid env.
- C: `[grid] web tools unavailable for kelvin-e2e09150 · This machine's \`grid\` is older than 0.3.36 …`, then `[grid] claude -> … · resumed`; argv `--disallowedTools=WebSearch,WebFetch`, no `--mcp-config`; prompt answered `DEGRADED-OK`.
- Versions: claude 2.1.272, codex-cli 0.154.0, grid 0.3.46, daemon = `cli/dist/cli.js` at `56b5e2b`.

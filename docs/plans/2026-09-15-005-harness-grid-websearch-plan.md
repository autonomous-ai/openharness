# Web search for agents on a Local model

Status: proposed · 2026-09-15
Depends on: `2026-09-14-004-harness-grid-plan.md` (Change 4 — the `agent_retarget` path this plan extends)
Decided in a design interview on 2026-09-15; the decisions are tabulated at the end.

## Context

When an agent is moved from its subscription model to a Local (grid) model, the engine's native
web tools stop working. They are not tools the engine runs; they are features of the vendor API,
and a grid base URL is not the vendor API:

- Claude Code's `WebSearch` is executed server-side by Anthropic's API. On a grid endpoint it is
  simply absent.
- Claude Code's `WebFetch` fetches the page locally but *summarises it through a haiku call on the
  same base URL*. The grid's master relay rejects a model name it does not serve with
  `503 no_providers_available` (`grid-src grid_cli/private_server/relay.py:2254-2275`; only the
  reserved name `auto` is routed). So `WebFetch` is dead too. The comment in
  `cli/src/lib/gridWebMcp.ts:130` that leaves `WebFetch` enabled on purpose rests on a wrong
  assumption and goes with this plan.
- Codex's native `web_search` is likewise an API-side feature.

A model that keeps a dead tool in its list will call it — the names are familiar — and fail.

### What the grid already ships

The control plane hosts an MCP server for exactly this gap (`grid-apis grid_networks/web_mcp.py`,
mounted at `/v1/grid/web-mcp/` when `GRID_WEB_MCP_ENABLED` is set; otherwise 404). Facts that shape
the plan:

| Fact | Where |
|---|---|
| Streamable-HTTP FastMCP, stateless, JSON responses; two tools | `web_mcp.py:110,320-384` |
| `web_search(query, num_results=5)` → `{results:[{title,url,excerpt}]}` | `web_mcp.py:333` |
| `web_read(urls ≤ 5, max_chars=6000)` → `{results:[{url,title,text,status,error}]}` | `web_mcp.py:360` |
| Bearer = the **same per-grid access token** `grid info --env` prints as `OPENAI_API_KEY` | `web_mcp.py:168-231`; `autonomous-grid cli/remote_grid.py:378-391` |
| Served by the control plane over public HTTPS — never the private-server node | `web_mcp.py:11-16` |
| Allowance 250 searches / rolling 24 h per account, burst 30/min | `grid_networks/web_search.py:239-248`; `web_mcp.py:98-99` |
| Exhaustion is an `isError` tool result with clean text (no "grid" in it) | `web_mcp.py:273-287` |
| `grid mcp config [<grid>] --json` → `{server, url, authorization}`; trailing slash on `url` is load-bearing (bare path answers 307) | `autonomous-grid cli/mcp_config.py:30-31,94` |
| `--harness <engine>` is a *print style* (mutually exclusive with `--json`); the positional is the **grid name**, not a harness name | `cli/parser.py:1642-1672` |
| `mcp config` renews the token when it is within 30 days of `exp` and persists the renewal; `info --env` never renews | `cli/mcp_config.py:57,139-171` |
| Token TTL 365 days; carries `member_epoch`/`network_epoch`, so it can be revoked before `exp` | `grid-apis grid_networks/tokens.py:23,254-274` |

So the private server is not in the path at all: the agent talks to the control plane directly, and
web search works whether the grid node is asleep, behind a LAN address, or reached through an SSH
tunnel.

### What the harness already has

`cli/src/lib/gridLaunch.ts` already wires an MCP server into six of its seven engines whenever
`GridLaunchOverride.mcpUrl` is set (`gridLaunch.ts:109`), each through the vendor's own config
contract, with the key reaching the process **only through the environment** (`GRID_API_KEY`, or
`GRID_MCP_AUTHORIZATION` for codex); argv and config files carry the variable *name*
(`gridWebMcp.ts:90,143,193,309`). `pi` has no MCP client (`grid mcp config --harness pi` refuses,
too). `--disallowedTools=WebSearch` is already appended to every claude grid launch
(`gridLaunch.ts:522-527`). Retarget is a pane respawn (`respawn-pane -k` + `--resume`,
`cli.ts:3808-3900`), and `gridEnvVarNames()` — derived from a probe override that includes
`mcpUrl` (`gridLaunch.ts:853,866`) — already clears the MCP variables on the way back to the
subscription model.

**The gap is one function.** `resolveGridTarget()` (`cli/src/lib/gridModels.ts:109-129`) returns
`{ networkId, networkName, baseUrl, apiKey, model }` and never fills `mcpUrl`, so on the desktop path
no engine ever attaches the server. Everything downstream is built and tested; nothing upstream
feeds it.

### Where the word "grid" leaks

The grid is an implementation detail; the user's vocabulary is "Subscription" and "Local"
(`desktop/lib/widgets/grid_model_picker.dart:121,136`). Today it leaks in four places:

1. The MCP server name `grid-web` (`gridWebMcp.ts:54`) — tools appear as `mcp__grid-web__web_search`
   in the engine's permission prompts and `/mcp`.
2. The tool descriptions the model reads: "Search the live web **through your grid**." /
   "Read … **through your grid**." (`grid-apis web_mcp.py:335,362`).
3. The 401 body: "This **grid** credential was refused. Run `**grid** mcp config <grid>` …"
   (`web_mcp.py:82-85`), which Claude Code prints verbatim when the server refuses a connection.
4. One desktop string: `'No grid on this account yet — sign in again to set one up.'`
   (`grid_model_picker.dart:146`).

The harness cannot intercept 2 and 3 — MCP traffic runs engine ↔ control plane, not through the
daemon — so those are fixed at the source.

## Design principles

**1. Same seam, one more call.** Web search arrives as one more `grid` subprocess with `--json`,
on the seam plan 004 established. No HTTP client in the daemon, no MCP proxy, no probe.

**2. One key.** The MCP server accepts the inference token. There is no second secret, no second
env var, and nothing new to keep out of argv or logs — the existing property holds unchanged.

**3. Degrade, never refuse.** Inference is the feature; web search is an accessory. If the MCP
config cannot be obtained, the retarget still happens, the native tools are still disabled (they are
dead regardless), and the agent is marked so the user can see why it cannot search.

**4. The user never reads "grid".** Not in a menu, not in a tool name, not in a tool description,
not in an error. Where the harness cannot rewrite the text, the text changes at its source.

**5. State, not events.** The MCP URL is cached against the token's own `exp`, not a timer; the
degraded condition is a field on the agent, not a toast. Both are correct again after a reconnect or
a daemon restart without replaying anything.

## Architecture

```
desktop                         daemon                                       grid CLI / control plane
   │  agent_retarget {model}       │
   ├──────────────────────────────▶│ resolveGridTarget(gridName, model)
   │                               │   cache[gridName]?  miss, or exp − now < 30 d
   │                               │     └─▶ grid mcp config <gridName> --json ──▶ { url, authorization }
   │                               │           store { mcpUrl, exp }; token discarded
   │                               │   grid --remote info <gridName> --env ───────▶ OPENAI_BASE_URL + KEY
   │                               │   grid --remote ls ──────────────────────────▶ network id
   │                               │ gridLaunch.ts: MCP "harness" + native web tools off
   │                               │ respawn-pane -k -e …   (--resume)
   │◀── agent_synced {agent.grid.webSearch: on|unavailable|unsupported}
   │
   │        engine ── MCP (bearer = inference token) ──▶ https://<api>/v1/grid/web-mcp/
   │                  mcp__harness__web_search / web_read
```

---

## Change 1 — `resolveGridTarget()` fills `mcpUrl`, with a cache keyed by token expiry

`cli/src/lib/gridModels.ts`; a small new `cli/src/lib/gridWebSearchCache.ts` (or a module-level
map in the same file if it stays under a screen).

**The call.** `grid mcp config <gridName> --json` (note: `--json`, not `--harness`; the positional is
the grid name from `machine_meta`). Parse `url` — keep it exactly, trailing slash included — and
decode `exp` from the JWT in `authorization` (base64url middle segment, `JSON.parse`, read `exp`;
the same offline check the grid CLI does in `cli/grid_credential.py:96-98`). **Discard the token.**
The key the launch uses comes from `info --env`, as today.

**Order on a miss:** `mcp config --json` first, because it may renew the token and persist it; then
`info --env`, which then reads the renewed token. The other order can hand inference an older
token than the one MCP holds — both valid, but a latent mismatch nobody would look for.

**The cache.** `Map<gridName, { mcpUrl, exp }>`, in daemon memory. A retarget re-runs `mcp config`
only when there is no entry or `exp − now < 30 days`. The margin equals `mcp config`'s own renewal
margin on purpose: a re-run inside it *always* renews, so the daemon is now the thing that keeps a
harness user's grid token alive (nothing else on the harness path renews). A smaller margin would
re-run without renewing and re-run again tomorrow. An undecodable token counts as expired (re-run
every retarget — safe, slow, loud in the log). Dropped whole on harness sign-out (= grid sign-out);
keyed by name so a re-minted grid name never hits a stale entry. Failures are not cached.

**Return shape.** Add `mcpUrl?: string` to the resolved target. Undefined means "could not get one";
the reason (`GRID_CLI_OUTDATED`, `GRID_CLI_MISSING`, not logged in, grid not found) goes to the
daemon log only. `info --env` failing still collapses to `null` → `GRID_UNAVAILABLE`, exactly as
today; this plan does not touch the error path (interview Q13).

Revocation before `exp` (epoch bump) is outside every cache's reach and outside the daemon's: the
401 happens engine ↔ control plane. The engine shows it; the daemon never sees it.

---

## Change 2 — server name `harness`, native web tools off

`cli/src/lib/gridWebMcp.ts`, `cli/src/lib/gridLaunch.ts`, `gridLaunch.spec.ts`.

- `GRID_MCP_SERVER_NAME = 'harness'`. Tools read `mcp__harness__web_search` / `web_read` in Claude
  Code, `harness` in `/mcp`, `mcp_servers.harness` in codex, and so on. Fixtures follow.
- Claude Code: `--disallowedTools=WebSearch,WebFetch` (verify the comma form on the installed
  version; fall back to two `=` arguments). Keep the `=` form — the flag is variadic and the doc
  comment explaining that stays; the sentence about `WebFetch` goes.
- Codex: turn off the native `web_search` feature through its config knob via `-c` (the exact key
  is verified at implementation against the installed codex, not assumed here).
- opencode / copilot / hermes / grok: best-effort — disable a native web tool only where a
  documented knob exists; do not invent one.
- These flags are applied on **every** grid launch, with or without `mcpUrl` — the native tools are
  dead either way.
- `pi` gets no MCP and is marked `unsupported` (Change 3).

---

## Change 3 — the status reaches the desktop

`cli/src/lib/launchOverrides.ts` (`buildLaunchOverrides`), `cli/src/cli.ts` (`gridConfigDirFor`,
`announceSession`), `cli/src/registry.ts`, `desktop/lib/core/models.dart`,
`desktop/lib/widgets/grid_model_picker.dart`, the pane header tooltip.

`agent.grid` in `agent_synced` gains `webSearch: 'on' | 'unavailable' | 'unsupported'`:

| Value | When |
|---|---|
| `on` | `mcpUrl` present and the engine wired it |
| `unavailable` | `resolveGridTarget` had no `mcpUrl` (Change 1 failure) |
| `unsupported` | engine has no MCP client (`pi`), or Hermes on a machine with `/etc/hermes`, where the managed overlay is dropped (`cli.ts:3353-3358`) |

The value is decided where the launch is built, stored with the launch in the registry (which
already holds the full grid launch, 0600, never logged), and emitted by `announceSession` — so it
survives reconnects and is absent again the moment the agent returns to its subscription model.

Desktop: `Agent.gridWebSearch`; a subtitle under the Local model row in the picker and the same
sentence in the pane-header tooltip ("Where this agent runs"): *Web search unavailable* /
*Web search not supported by this engine*. Nothing for `on`. No new frame, no toast, and the
retarget callers in `app_state.dart:3057-3092` are left as they are.

---

## Change 4 — the tools get the native cards

`cli/src/lib/normalize.ts` (`:195-196,311`), per-engine normalizers, `commander.ts:99` colours.

`mcp__harness__web_search` → the canonical `WebSearch` card; `mcp__harness__web_read` → `WebFetch`.
The user sees an agent searching the web, not which road it took — and the server name never
reaches a card even if something upstream slips. Claude Code and Codex are required (Codex's MCP
tool spelling is checked at implementation); other engines best-effort.

---

## Change 5 — the one desktop leak, and three codes to check

`desktop/lib/widgets/grid_model_picker.dart:146` → `'No local models on this account yet — sign in
again to set them up.'`. While there: `INVALID_GRID`, `TMUX_TOO_OLD_FOR_GRID`, `GRID_CONFIG_FAILED`
pass through `_creationFailureMessage` (`app_state.dart:4033-4037`) — confirm they map to a sentence
and are not shown raw.

---

## Change 6 — three strings in grid-apis (separate PR, ships first)

`grid-apis grid_networks/web_mcp.py` and `tests/test_web_mcp.py`.

| Line | Now | After |
|---|---|---|
| `:335` | Search the live web through your grid. | Search the live web. |
| `:362` | Read the main text of up to five web pages through your grid. | Read the main text of up to five web pages. |
| `:82-85` | This grid credential was refused. Run `grid mcp config <grid>` to get a fresh one, and paste it into this MCP server's configuration. | This credential was refused or has expired. Refresh it and update this MCP server's configuration. |

Neutral text costs direct `grid` users nothing and is the only way to keep principle 4 on a path the
harness cannot intercept. No client detection, no per-client text.

---

## Change 7 — the words (added 2026-09-16, after the first end-to-end run)

`cli/src/lib/gridWebMcp.ts`, `cli/src/lib/gridLaunch.ts`, `gridLaunch.spec.ts`; grid-apis
`web_mcp.py`, `tests/test_web_mcp.py`.

**What the run showed.** Change 2 removes `WebSearch`/`WebFetch` from the tool *list*, and the list
is not the only place a model reads tool names from. An agent moved to a Local model mid-conversation
resumes with every turn it had on the Subscription model, `WebSearch` calls that succeeded included,
and a model imitates those ahead of reading the list. Session `1768dbeb…` (Claude Code 2.1.273,
`deepseek/deepseek-v4-flash-0731` resumed after three `WebSearch` turns on Sonnet 5): the request's
tool list had no `WebSearch` — read off the transcript's `prompt_snapshot` — and the first response
still carried three `WebSearch` calls, each refused "No such tool available", before the next turn
found `mcp__harness__web_search`. One wasted turn; Claude Code's refusal is local and costs no
request.

**Two mitigations, neither a guarantee.** The history is what `--resume` exists to keep, so words can
lower the odds and not zero them. Zero would need a history that never held `WebSearch` — routing the
Subscription model's web through `harness` too — which is a product decision this plan does not take.

1. **Claude Code's system prompt, on every Local launch** (`claudeGridPromptArgs`): which tools are
   gone, that earlier turns are no evidence they are back, and — only when the server was wired —
   what to call instead. No "grid" in it: a model narrates its prompt back to the user.
   ⚠️ **`--append-system-prompt` alone does not reach a resumed conversation.** Claude Code records
   the system prompt on a conversation's first request and replays the record on every later request
   and resume, "even when a later launch passes different text" (`--system-prompt-snapshot`, default
   `on`). Measured 2026-09-16 on a resumed session: without `--system-prompt-snapshot off` the model
   never saw the text and no new record was written; with it, it did; and a later launch without the
   flag — the move back to Subscription — replayed the original record, so nothing said on the Local
   model follows the agent off it. `off` gives up prompt-cache stability the relay does not offer
   anyway (`cache_read_input_tokens: 0` on every Local response in that transcript).
2. **The tool descriptions on the control plane** name the built-in tools they stand in for —
   Claude Code's `WebSearch`/`WebFetch`, the `web_search` built into Codex — and say opencode's
   `websearch`/`webfetch` keep working (they never go through the model vendor). A description rides
   in the `tools` array of every request, so unlike a system prompt it survives a resume; it is the
   only text that reaches Codex too. Still no product name (the Change 6 test holds).

| Q | Decision |
|---|---|
| Q21 | Words on every Claude Local launch, both variants; `--system-prompt-snapshot off` alongside |
| Q22 | Descriptions name the dead built-ins precisely, per harness, and name opencode's as alive |
| Q23 | Not taken: routing Subscription web through `harness` (the only zero); rewriting the transcript before `--resume`; a `PreToolUse` hook (cannot fire for a tool that is not offered) |

---

## Failure modes

| Condition | Where | What happens |
|---|---|---|
| `grid` too old for `mcp config` (argparse exit 2 → `GRID_CLI_OUTDATED`) | Change 1 | retarget proceeds; `webSearch: unavailable`; reason in daemon log |
| Not logged in / grid not in credential store / grid not found | Change 1 | same |
| Token expired and no refresh token (`mcp config` refuses) | Change 1 | same — and inference will fail on its own, as today |
| `info --env` fails | today's path | `GRID_UNAVAILABLE`, pane untouched |
| Control plane has `GRID_WEB_MCP_ENABLED` off (404) | engine | attached blind; the engine reports the server as failed to connect; no daemon involvement |
| Token revoked before `exp` (401) | engine | engine prints the (now neutral) 401 text; next retarget after `exp − 30 d` renews |
| Allowance exhausted / burst / vendor busy | model | `isError` tool result; the model relays the sentence; harness parses nothing |
| Engine without MCP client (`pi`) / Hermes overlay dropped | Change 3 | `webSearch: unsupported` |
| Daemon restart | Change 1 | cache empty; one extra `mcp config` on the next retarget |

## Testing

Follow `cli/src/lib/gridEnsure.spec.ts:41-57`: a plan-driven fake `grid` injected through
`HARNESS_GRID_BIN`, logging calls. There is no `gridModels.spec.ts` today; this plan adds it.

1. `gridModels.spec.ts` — `mcp config` succeeds → `mcpUrl` set, trailing slash intact, and the
   fake was called **before** `info --env`; exit 2 → no `mcpUrl`, retarget still resolves;
   second call with a fresh entry → `mcp config` **not** called; entry with `exp` inside 30 days →
   called again; undecodable token → called every time; sign-out → map empty. Assert the token
   from `authorization` is never stored and never logged.
2. `gridLaunch.spec.ts` — server name `harness` in every engine's config; claude carries both
   disallowed tools with and without `mcpUrl`; codex carries its native-off knob; no MCP block when
   `mcpUrl` is absent; `pi` and dropped-Hermes yield `unsupported`; no key in argv or on disk
   (existing assertions, kept).
3. `normalize` tests — `mcp__harness__web_search` / `web_read` map to the `WebSearch` / `WebFetch`
   cards for Claude Code and Codex.
4. Desktop — `webSearch` parsed from `agent_synced`; picker subtitle and tooltip for both degraded
   values; the leak string gone (`grid_model_picker_test.dart`).
5. grid-apis — `tests/test_web_mcp.py` updated for the three strings.
6. Manual end-to-end, Claude Code then Codex, over the SSH tunnel: the model calls
   `web_search` and `web_read`; the native tools are absent from its tool list; the cards render
   as native; `/mcp` shows `harness`; switching back to the subscription model restores the native
   tools. No automated e2e — it needs a live grid.

## Sequencing

| Phase | Contents | Ships alone? |
|---|---|---|
| 0 | Change 6 (grid-apis strings) | yes — independent, three lines |
| 1 | Change 1 + Change 2 (daemon: `mcpUrl`, cache, name, native off) | yes — the feature, invisible until Change 3 |
| 2 | Change 3 + Change 4 + Change 5 (status field, cards, leak), CLI and desktop together | yes |

Nothing in phase 1 depends on phase 0 technically; shipping 0 first only means no harness user ever
sees the old strings.

## Decisions from the design interview (2026-09-15)

| # | Decision |
|---|---|
| Q1 | Attach automatically on every retarget to a Local model; no toggle |
| Q2 | Degrade, do not refuse, when the MCP config cannot be obtained |
| Q3 | Disable both native tools (search + fetch), replaced 1:1 by `web_search` + `web_read` |
| Q4 | Claude Code first-class, Codex second; other engines best-effort |
| Q5 | MCP server name `harness` |
| Q6 | Quota/burst errors are relayed by the model; the harness parses nothing |
| Q7 | Unit tests on the fake-`grid` convention; manual e2e; no automated e2e |
| Q8 | Out of scope: `agent_create` accepting `gridModel`; removing the daemon's acceptance of a full `payload.grid` with `apiKey` |
| Q9, Q16, Q17 | Cache in daemon memory keyed by grid name; re-run when `exp − now < 30 d`; drop on sign-out |
| Q10, Q19, Q20 | Fix "grid" wording at the source in grid-apis; three strings; ships first |
| Q11 | One key (the inference token); `mcp config` supplies only the URL; called before `info --env` on a miss |
| Q12 | No endpoint probe; attach blind |
| Q13 | Do not change how retarget errors are surfaced (daemon flattens, desktop swallows) |
| Q14 | Map the MCP tools onto the native `WebSearch` / `WebFetch` cards |
| Q15 | Fix the picker's "No grid on this account" string here |
| Q18 | Degraded status as `agent.grid.webSearch` on `agent_synced`; picker subtitle + tooltip |

## Open questions

None blocking. Verified at implementation, not decided here: the comma form of
`--disallowedTools` on the installed Claude Code; the codex config key that disables native
`web_search`; codex's spelling of MCP tool names in its event stream (for Change 4); which daemon
path learns of sign-out (for the cache drop).

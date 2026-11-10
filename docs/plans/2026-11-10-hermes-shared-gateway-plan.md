# Hermes 0.22: harnesses stuck on "Waiting to confirm", and conversations attached to the wrong harness

Status: built on `fix/hermes-shared-gateway` (A2) and run on DESKTOP-0TFH0OJ as CLI 0.5.95-gw1/gw2, 2026-11-10: three
Hermes harnesses ready in 214/525/206 ms, each conversation bound to its own pane. Added after the first PC run: a row an
older build gave the gateway is re-observed, not replaced (`terminalAgentReconciler.ts`, `formerProcesses`); the first
install replaced one (`%2002 replaced 5afb24e8`) before that existed.

Original plan below. Based on `origin/main` 6b0963497. Evidence from DESKTOP-0TFH0OJ, CLI 0.5.80,
Hermes 0.22.7 (2026.9.24, stable), 2026-11-09.

## What the person sees

1. Open a Hermes harness while another Hermes harness is already open. Hermes starts and answers, but after 10
   minutes the pane shows the yellow banner "Waiting to confirm the native engine process…" and the harness stays
   offline.
2. Type in that pane. The conversation is attached to the **other** Hermes harness (`5afb24e8 rebound local-eb →
   local-fc` in `harness.log`). The harness you typed in still has no conversation.

## Three causes (each proven on the PC)

| # | Cause | Proof |
|---|---|---|
| 1 | Since #3591 Harness starts Hermes on Windows as `python.exe -I <root>\bin\hermes-boot.py`. The Hermes process rule (`ENGINE_PROCESS_SIGNATURES.hermes`, `processTable.ts:583`) knows `hermes`, `hermes-agent`, `hermes_cli`, but not Harness's own `hermes-boot.py`. | pane %2005: only `24276 python.exe -I …\hermes-boot.py` under it; `19:55:37 create pane open` → `20:05:37 create timed out` → `held` |
| 2 | Hermes 0.22 runs **every** session in one shared background process, the gateway (`python -m hermes_cli.main --profile default gateway run --quiet --idle-exit`). The first Hermes client starts it, so on Windows it is that client's child. Harness took the gateway for the first harness's Hermes, because it matches `hermes_cli`. | registry: `5afb24e8.processIdentity.pid = 23704` = the gateway; `03:39:07 pane open`, `03:39:09 gateway created`, `03:39:10 create ready` |
| 3 | Hermes runs shell hooks **inside the gateway**, with the gateway's environment (`agent/shell_hooks.py` `_spawn` → `build_subprocess_env(os.environ)`). So every hook names the first pane (`HARNESS_PANE`), and its process ancestry passes through the gateway that Harness recorded for `5afb24e8`. The payload has no pane: `{session_id, model, platform, cwd (the gateway's), profile, extra}`. | Hermes source: `session_client_env.py` "the one gateway now runs every session"; client env reaches tools only (`toolchain_environ`), never hooks |

Hermes 0.21.3 (this Mac) still runs the CLI in its own process, so causes 2 and 3 arrive with 0.22 **on every
platform**. On macOS/Linux the gateway is not under any pane at all, so a 0.22 hook matches no harness (to be
confirmed on a Mac with 0.22, step 6).

## Fix

### Part 1: recognize Harness's own boot file as Hermes (cause 1)

- Where: `cli/src/lib/engineBin.ts` `engineBinaryOwnershipSnapshot()` (line 212).
- What: when the `hermes` found on PATH is the installer's launcher (`hermesRoot(program)` from
  `lib/windows/hermesLaunch.ts`), add the file key of `hermesBootFile(root)` to `engineFileKeys.hermes`. The boot
  process then matches by **file identity** (score 4, evidence `file-identity`), the same mechanism every other
  engine binary uses. No new name pattern.
- Check: `enrichProcessRows` sets `entrypointFileKey` for `python.exe -I <file>` (the `-I` flag is skipped by
  `processEntrypoint`). Add a test if it does not.
- Result: the pane's own client (depth 1) is found within seconds, ahead of the gateway (depth 2).

### Part 2: the gateway is never a harness's Hermes (cause 2)

- Where: `cli/src/lib/processTable.ts`, beside `engineCapabilityProbe` (line 133).
- What: a Hermes process whose subcommand (first non-option argv word after the entrypoint, read from the parsed
  argv, not a regex over the line) is `gateway` scores 0 for `hermes`. Same for `hermes-acp` if it shares the rule.
- Result: no harness records pid 23704 again. An existing row that holds the gateway is re-resolved on the next
  reconcile, because the check compares pid + start time and the gateway is no longer selectable.

### Part 3: bind a 0.22 hook to the pane that really made the session (cause 3)

Ancestry and `HARNESS_PANE` are both wrong for any hook that comes through the gateway, so:

- 3a (in any option): in `core/engines/hooks.ts` `resolveHookAgent`, cut the hook's ancestry at the first Hermes
  gateway process and ignore its runtime hints. A gateway hook then never binds by accident. This alone turns
  "attached to the wrong harness" into "not attached yet".
- 3b: the evidence that replaces it. **Decision needed** (options below).

| Option | How | Good | Bad |
|---|---|---|---|
| A. Tag each pane's sessions (chosen; replaced by A2 after step 0) | Launch Hermes with `HERMES_SESSION_SOURCE=harness-<token>` in the pane (Hermes reads it as `--source`). On a hook, read that session's row in `state.db` by id (Harness already reads this db) and pick the harness with that token. | Exact; one indexed read per new session; no Hermes change | Depends on a Hermes db column; the tag shows in Hermes's session filters |
| B. Only bind when unambiguous | Bind a gateway hook only when exactly one Hermes harness is waiting for a conversation. | No Hermes coupling | Two Hermes panes opened together, or `/new` with two open: nothing binds |
| C. Ask Hermes to pass the client's env to hooks | Upstream change: shell hooks start from `toolchain_environ()`, so `HARNESS_PANE` (listed in `terminal.client_env_passthrough`) arrives. | The right long-term fix; keeps today's code | Waits on Hermes; old 0.22 still broken |

**Step 0 result (2026-11-10): option A as written is rejected, revised to A2.** Hermes uses the source label for
behaviour, not only filtering: an unknown label counts as a messaging channel (`session_is_messaging_surface`,
default-deny), as unattended (`is_attended`), and drops out of the pickers and `hermes -c`.

**A2: carry the pane in the session's client environment.** Hermes freezes each session's allowlisted client env
in `state.db` `state_meta['gateway.local_policy.v1:<session id>'].policy.client_env_json`. Proven on the PC: with
`terminal.client_env_passthrough: ["HARNESS_PANE"]`, `hermes chat -q` from `HARNESS_PANE=probe:%999` stored
`{"HARNESS_PANE": "probe:%999", "PATH": …}`; the running gateway read the config change without a restart.

- Harness adds `HARNESS_PANE` (Windows) and `TMUX_PANE` (tmux) to `terminal.client_env_passthrough`, merged with
  the person's own entries, in the same step that writes its Hermes hooks (`engines/nativeHooks.ts`). Only for a
  Hermes with the shared gateway (0.22+). 0.21 ignores the key on load, but `hermes config set` calls it unknown.
- On a hook whose ancestry passes through a Hermes gateway: read that one `state_meta` row by session id, take the
  pane, and bind the Hermes harness on that pane. No row or no pane (a Desktop-app or plain-terminal session):
  unmatched, logged with the reason.
- Side effect, a fix too: a session's tools now see their own pane's `HARNESS_PANE`. Today they inherit the
  gateway's, the first pane's, so `harness send` from inside Hermes names the wrong pane.
- Also proven: the probe ran from no pane at all and Harness still bound it to `5afb24e8`
  (`rebound local-fc → local-32`), cause 3 live.

## Tests

| Test | File |
|---|---|
| `python.exe -I <root>\bin\hermes-boot.py` with the boot file owned → hermes, `file-identity` | `lib/processTable.spec.ts` |
| gateway row (`-m hermes_cli.main --profile default gateway run --quiet --idle-exit`) → not hermes | same |
| pane tree client → gateway child: `selectEngineProcess` returns the client | same |
| hook whose ancestry passes through a gateway does not bind the gateway's pane harness | `core/engines/hooks.spec.ts` |
| 3b: two Hermes harnesses, a hook for each session binds to its own harness | `core/engines/hooks.spec.ts` |
| the real rows from the PC (copied above) as fixtures | both |

Local runs (PR CI does not run them): `npm run test:core`, `npm run test:harnessd`, the affected specs while
working, the full suite once at the end, saved to a file.

## Real check on the PC (before reporting done)

1. Bundle the CLI and install it with `s1re43.ps1` (handoff "Trying a code change on the PC").
2. Close the Hermes harnesses. Open Hermes harness A, then B, from Desktop.
3. Both turn ready within seconds (log `create ready · hermes`), no banner. Screenshot.
4. Type in B, then A. `harness.log` binds each conversation to its own harness. The Desktop tiles show each title.
5. Registry: neither row records the gateway pid.
6. On a Mac with Hermes 0.22 (ask first: it updates the person's Hermes), repeat 2–4.

## Design

- growth: no new store. Option A reads existing Hermes rows.
- concurrency: unchanged (registry locks as today).
- read cost: option A reads one `sessions` row by primary key, once per new session id.
- scale: 10x Hermes panes → 10x reads at session start only; warning metric: `unmatched hermes hook` log count.
- compatibility: Hermes 0.21 (in-process, no gateway) keeps working: parts 1–2 add matches/exclusions only, 3a
  triggers only when a gateway is in the ancestry. Old Harness clients: unchanged.
- migration + rollback: none stored; revert the commit.
- audience: hooks still go through the same server checks.
- identity: binds by process/session evidence, never the machine owner's login.
- failure: an unbindable hook logs `unmatched hermes hook · via gateway` with the reason; no silent drop.
- platforms: Windows (all three parts), macOS/Linux (parts 2–3).

## Also worth fixing (separate)

- The banner says "Waiting to confirm" forever after the 10-minute timeout, though nothing is still waiting. After
  the fix it should not appear for Hermes. If it does for another engine, the copy should say what happened.

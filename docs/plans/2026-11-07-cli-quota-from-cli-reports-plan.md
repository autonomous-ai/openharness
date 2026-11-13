# Quota from the CLIs' own reports; no login reading, no relay (#4137)

> Way of working: plan first, then each plan task test first (failing test committed, then the code), parallel
> subagents only for plan tasks that share no files.

**Goal:** The CLI never opens a Claude or ChatGPT login or credential, and never relays an owner's subscription. The
quota Harness reads comes only from what Claude Code and Codex report themselves.

**Architecture:** `usage_read` keeps its wire shape (Desktop parses it unchanged), but its
source changes. Claude: every Claude session Harness launches gets a pass-through status line. It records
`rate_limits.five_hour` / `seven_day` from Claude Code's status-line JSON into a small report file in Harness's data
folder, then runs the owner's own status line command, if they have one, and prints its output unchanged. Codex: the
daemon asks `codex app-server` for `account/rateLimits/read` under the owner's own `CODEX_HOME`. Sign-in presence comes
from `claude auth status --json` and `codex login status`. The owner subscription relay (`subscriptionRelay.ts`,
`ownerSubscriptions.ts`) and everything that launches through it are removed.

**Tech Stack:** TypeScript (cli), node built-ins only in the status-line script (it runs inside the person's `claude`,
like `hook/notify.mjs`), vitest.

**Spec:** task #4137 brief (anh Dee, 2026-11-07).

## Global Constraints

- No code path reads `~/.claude/.credentials.json`, the `Claude Code-credentials` Keychain item (with or without
  `-w`), `oauthAccount` / `claudeAiOauth`, Codex's `auth.json`, or calls `api/oauth/usage` / `wham/usage`.
- Each CLI starts with its owner's own settings: no relay base URL, token, provider or config dir injected. The one
  setting Harness adds to a Claude launch is the pass-through `statusLine`, which shows the owner's own status line as
  before.
- A report holds only percentages, reset times and when it was read: no token, email, account id or prompt.
- `usage_read`'s reply shape is only extended (`source: 'cli'`), so Desktop from the last 30 days keeps working.
- Windows: the status line and the app-server read start no window (`ownProcessGroup()` / no `detached`).
- No fixed sleeps in tests; memory stores and fake spawns, never the real home or Keychain.

## Review Focus

- The guard test (Task 1) covers every way a login could be opened, and nothing is allowlisted.
- The status line prints exactly what the owner's own status line prints, and a failure in our part never hides it.
- The app-server read has a timeout, is bounded to one at a time per home, and kills its child.
- Removing the relay leaves no dead export, route or setting behind.

## Design

- growth: one report file per Claude config folder on the machine (a handful), overwritten in place.
- concurrency: the report is written by rename, so a reader sees a whole file; the last writer wins.
- read cost: the daemon reads one small file per account, and one app-server read per Codex home per
  `USAGE_FRESH_MS` (3 min, unchanged).
- scale: N/A because per machine; the metric that warns first is the app-server read's duration in the
  daemon log.
- compatibility: wire shape unchanged plus `source`; the backend's `quotas` field unchanged.
- migration and rollback: none stored; reverting the PR restores the old reader.
- audience: unchanged (the `usage_read` guest and owner rules stay).
- identity: only the owner's own CLIs, under the owner's own login, are asked.
- failure: no report yet, or a failed read, is an `unreachable` reading with a message the route shows.
- platforms: macOS, Linux, Windows (CLI and daemon).

## Tasks

### Task 1: The guard

**Files:** `cli/src/loginReads.spec.ts` (new)

**Interfaces:** none.

- [ ] Write a spec that reads every non-test source under `cli/src` and `cli/hook` and fails on any login marker:
  `.credentials.json`, `Claude Code-credentials`, `find-generic-password`, `claudeAiOauth`, `oauthAccount`,
  `api/oauth/usage`, `wham/usage`, and a Codex `auth.json` (any `'auth.json'` outside Grok's own home).
- [ ] Run it: it fails, naming today's readers. Commit.

### Task 2: Claude's status-line reports

**Files:** `cli/hook/statusline.mjs` (new), `cli/src/lib/quotaReports.ts` (new), the Claude launch's settings
argument (`cli/src/engines/launches.ts`, `cli/src/engines/claude/launch.ts`), their specs.

**Interfaces:**
- report file `<dataDir>/quota/claude-<sha256(CLAUDE_CONFIG_DIR or '')[0..16]>.json`:
  `{ "v": 1, "at": <ms>, "five_hour": {"used_percentage", "resets_at"}, "seven_day": {...} }`.
- `readClaudeReport(dataDir: string, configDir?: string): { at: number; five_hour?: Window; seven_day?: Window } | null`.

- [ ] Failing spec: the script, fed a status-line JSON, writes the report and prints the owner's command's output.
- [ ] Failing spec: with no `rate_limits`, nothing is written and the owner's line still prints.
- [ ] Failing spec: a Claude launch carries one `--settings` with `statusLine` pointing at the script, the owner's own
  status line passed along, merged with the attribution setting when there is one.
- [ ] Implement; run the specs above and the launch golden specs.

### Task 3: Codex's own rate-limit read

**Files:** `cli/src/lib/codexRateLimits.ts` (new), its spec.

**Interfaces:** `readCodexRateLimits({ codexHome?, spawn?, timeoutMs? }): Promise<{ ok: true; accountId: string | null;
primary: Window | null; secondary: Window | null } | { ok: false; reason: 'missing' | 'signedOut' | 'failed' }>` where a
`Window` is `{ usedPercent, windowDurationMins, resetsAt }` (Codex 0.166 `RateLimitWindow`).

- [ ] Failing spec with a fake `codex app-server` over stdio: `initialize`, `initialized`, `account/rateLimits/read`.
- [ ] Failing spec: a hung child is killed at the timeout; an error reply is `failed`.
- [ ] Implement.

### Task 4: `usage_read` from the reports

**Files:** `cli/src/services/usage.ts`; remove `cli/src/lib/accountUsage.ts` and its specs.

- [ ] Failing spec: `usage_read` answers Claude from the report and Codex from the app-server read, in its existing
  shape, with `source: 'cli'`, and no report is an `unreachable` reading with its reason.
- [ ] Implement; remove the vendor reader and the relayed-quota wording.

### Task 5: Sign-in from the CLIs' own status

**Files:** `cli/src/lib/engineAccount.ts`, `cli/src/lib/claudeProfiles.ts`;
remove `cli/src/lib/agentCredentials.ts`.

- [ ] Failing spec: signed in comes from `claude auth status --json` `loggedIn` and `codex login status`'s exit code
  (fake runners), with no file or Keychain read.
- [ ] Implement; a profile's label no longer comes from `oauthAccount`.

### Task 6: No owner subscription relay

**Files:** remove `cli/src/lib/subscriptionRelay.ts`, `cli/src/lib/ownerSubscriptions.ts` and their specs; edit
`cli/src/services/sharedMachines.ts`, `cli/src/services/guestLaunches.ts`, `cli/src/lib/guestPaneCommand.ts`.

- [ ] Failing spec: a guest's launch on a shared machine carries no relay variables or provider arguments.
- [ ] Remove the relay and its launch contract; a guest's engine starts with the guest's own sign-in.

Then: the Task 1 guard passes; the CLI coverage gates this touches (`test:core`, `test:harnessd`, `test:sharing`) run
locally and are recorded in the pull request.

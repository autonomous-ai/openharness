# Needs you, right, Part 4: a standing line at session start

> **For agentic workers:** REQUIRED SUB-SKILL: devcrew phase 3 implements this plan task by task. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** every Claude Code and Codex session that holds Harness's own dial skill, with the Harness Device plugin on,
starts with one line in its context. The line tells the agent to ring the dial before it ends a turn that leaves the
person something to decide, answer or do. The eval measures v1 against v1 plus the line. The product part ships only
if the line gains recall.

**Architecture:** a new CLI word, `harness device claude start` / `harness device codex start`
(`cli/src/deviceClaude/start.ts`), prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<the line>"}}`
or nothing. It prints only while Harness's own dial skill is in that engine's home, the plugin is on, the engine is
not marked removed, and the session's folder (the hook input's `cwd`) is outside Harness's data folder, where Harness's
own one-shots run. It reads the hook's input and three small files and asks no daemon and no network. The plugin's `hooks/hooks.json`
(Claude Code) and `hooks/codex.json` (Codex) each gain a `SessionStart` hook in the plugin's two-shell form. The hook
passes on only a line that starts with that JSON prefix. Codex trusts the new hook through Part 7's existing trust
write: `REVIEWED` already labels `SessionStart` `session_start` and hashes its matcher, and the carried fingerprint
changes with the files. The eval stages the same line as a variant's hook (`flow/v3/`), and its listing probe learns to
prove the line reached the model. The core, `cli/hook/notify.mjs`, the devices service and the backend do not change.

**Tech Stack:** TypeScript (Node 24), Vitest (unit, `cli/e2e`, the eval's own config), POSIX sh and Windows PowerShell
for the hooks, Claude Code 2.1.332 (`claude -p`) for the eval, the real Claude Code and Codex 0.172.0 for the hand
checks.

**Spec:** [docs/plans/2026-11-26-needs-you-right-design.md](2026-11-26-needs-you-right-design.md), section "Part 4. A
standing line at session start" (committed with this plan as the branch's first commit), with Part 1 ("Hooks in a variant",
"Targets and gates", "Cost"), Part 5's gate, Part 7 (the Codex manifest, the trust write, "Only content this CLI
carries is trusted"), "Release order", "Platforms" and "Tests (red first)". Part 3's plan
([part3](2026-11-26-needs-you-right-part3-plan.md)) holds the eval's mechanics and Part 7's plan
([part7](2026-11-26-needs-you-right-part7-plan.md)) the Codex plugin's.

## Decisions that bind this plan (the orchestrator, 2026-11-27)

1. "Do it all" (the maintainer, 2026-11-27): Part 4 only. `cli/src/core/` does not change.
2. **Base.** The branch was fast-forwarded to `origin/main` at 402a3a12d1, which holds #4666: `DIAL_SKILL` is v1's text,
   byte for byte `flow/v1/SKILL.md` (checked 2026-11-27). The spec's Part 4/5 edits and its note of decisions 9 and 10
   sit on top. So the eval compares v1 as on `main` with v1 plus the line, and no rebase step is needed.
3. **Eval.** Claude Code only, in `crowd`, `clean` and `name-only`, val and test pooled (held out). The spend counts
   toward the design's $250, and the flow has spent $114.97. Every invocation passes `--spend-cap-usd 175`, which is
   the flow's total, since the runner counts every variant's rows. That leaves $60.03. Stop before going over. The
   ship rule is the spec's: the variant gains recall, with specificity still at least 95%, read as decisions 9 and 10
   say. The eval task reports numbers only, never transcript text, and states the held-out `crowd` recall. Under 90%,
   Part 5 opens, but not on this branch.
4. **Product first, then the verdict.** The product tasks land before the eval runs. If the variant does not gain,
   Task 10 cuts the branch down to the eval's probe, variant and rows.
5. **Codex: the spike said yes** (Codex 0.172.0, isolated, 2026-11-27). A `SessionStart` plugin hook in
   `hooks/codex.json` runs for `startup`, `resume`, `clear` and `compact` (matcher `startup|resume|clear|compact`) and
   also under `codex exec`. Trusted by `[hooks.state."harness-device@openharness:hooks/codex.json:session_start:0:0"]`,
   it puts its `additionalContext` into the model request verbatim, as a developer message right before the user
   prompt. It does not run again on later turns. `resume` adds the line again, and `compact` drops the old line and
   adds a new one. Its `trusted_hash` includes the matcher, and `trusted_content_hash` is the bundle fingerprint as
   before. Its stdin holds `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode` and
   `source`, with `PLUGIN_ROOT` set. Codex also injects plain stdout. The JSON form is used, as the spec says. The Codex
   tasks are no longer conditional. They still ship only with Claude Code's side (decision 4).
6. **Platforms:** macOS, Linux and Windows, in the plugin's existing two-shell form (POSIX and PowerShell). Windows is
   covered by `windows-e2e` on the PR, selected by path, which runs the two-shell hook. No Windows VM (decision 11).
7. **Logs and output.** Fixed words only. The command reads no daemon and no network, ends within a second, and on any
   failure prints nothing and exits 0.
8. **Spec and plan first.** The spec (its Part 4/5 edits and the note of decisions 9 and 10) and this plan are committed
   together as the branch's first commit, before Task 1, by the devcrew flow. No task stages them, except Task 11's
   results edit to the spec.
9. **Gain** (the orchestrator, 2026-11-27). The line ships if held-out (val and test pooled) recall rises beyond noise
   against v1 in `crowd` or in `name-only`, and falls beyond noise in no condition. "Beyond noise" is the paired 95% t interval of v3 − v1 over the need cases both scored (each case's mean `hit` over its
   reps): it rises when the interval's low end is above 0 and falls when its high end is below 0. Task 12 adds that
   comparison to `summarize`, against `_state.json`'s best round, which is round 1 (v1) until Task 9's verdict.
10. **Specificity** (the orchestrator, 2026-11-27, then the spec author's review): pooled over the held-out no-need
    runs of `crowd`, `clean` and `name-only`, quiet in at least 95% of them, an absolute threshold, not "no worse than v1". With `crowd` always at 3 reps, `clean` at 2 and `name-only` at 1, that is 54 runs
    (9 no-need cases each: 27 + 18 + 9), so at most 2 needless rings. `name-only`'s needless rings are also reported on
    their own.
11. **Windows** (the orchestrator, 2026-11-27): no Windows VM. `windows-e2e` on the PR, selected by path, covers the
    two-shell hook. The PR body states that a real Claude Code (or Codex) session was not
    run on Windows. `harness device claude start` and `codex start` must finish under 1 s on every platform; this Mac
    measures them (Verification 3) and the numbers go into the PR body.
12. **`crowd` at 3 reps, always** (the spec author's review, 2026-11-27): about $7.8 more than 2 reps, the flow about
    $158, under the $175 cap. No third-rep decision is left to Task 9.
13. **Harness's own one-shots get no line** (the spec author's review, 2026-11-27). `cli/src/lib/oneshot.ts` runs
    `codex exec --ephemeral --sandbox read-only --ignore-user-config ...` under the person's `CODEX_HOME` for the voice
    router and the window names, and SessionStart runs under `codex exec` too. The rule that already exists is the
    observed agents' `excluded` one (`cable/hosts/observed.ts`, given `[dataDir]` by `services/devices.ts`): a session
    whose `cwd` is the data folder or inside it is Harness's own. Every one-shot runs there (`voiceRouter.ts`'s
    `voice-route-scratch` and `windowNames.ts`'s `window-names-scratch`, both under the data folder), so `start` reads
    the hook input's `cwd` and prints nothing when `within(dataDir, cwd)` (`lib/sessionSearch/externals/support.ts`, the
    function `observed.ts` uses). `oneshot.ts` does not change; no env marker is added. Claude Code's one-shot passes
    `--safe-mode`, which per `claude --help` (2.1.332) starts "with all customizations (... installed plugins, hooks
    ...) disabled", the hooks of admin-managed plugins aside, so its hook should not run at all; Verification 1 checks
    that, and the same `cwd` rule covers it either way. Codex's `--ignore-user-config` skips `config.toml`, which holds
    the plugin's table and the hook trust, so its hook likely does not run either; Verification 2 checks that, and the
    `cwd` rule does not rely on it. (`companions/` builds Codex one-shots of its own in `memory/inference.ts`; its
    `CompanionIntelligence` is created only by a probe script today, so nothing ships that runs it.)

## Global Constraints

- **The line**, verbatim from the spec (278 characters, printable ASCII, no `<` or `>`, one line):
  ``The person has a Harness dial. Before you end a turn that leaves them something to decide, answer or do, run `harness device notify "[the ask]" --suggest "[your pick]" --waiting` (or `--proceeding` when you go on). Not for finished work or progress. The dial skill has the rest.``
- **The output**: exactly `JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: <the line> } })`
  and a newline, or nothing. The same for both engines.
- **The command** (`harness device claude start`, `harness device codex start`): reads its stdin, the hook's input,
  whole, with `asked.ts`'s bounded reader (at most 256 KiB, exported as `hookInput`), and takes only its `cwd`. It
  reads only Claude Code's `settings.json` (the existing reader, at most 1 MiB), `dial-skill.json` (`readRemoved`),
  `<home>/skills/dial/SKILL.md` (the existing `held` reader, at most 4 KiB, no link followed) and, for Codex,
  `<home>/config.toml` (the existing `codexPluginState`). It reads no environment variable of its own and does not look
  for `claude` or `codex`. It opens no socket. It always exits 0. It stays out of `DEVICE_USAGE`, like `asked`. `cli/src/cli.ts` does not change: `runDeviceCommand` already
  receives the dispatch and has every dependency it needs.
- **When it prints.** Both engines: the input is a JSON object whose `cwd` is a string, and `within(dataDir, cwd)` is
  false (decision 13). An input that is too long, not JSON or without a string `cwd` prints nothing. Then Claude Code:
  `pluginActs(dataDir)` (the plugin on in `claudeSettingsPath()` and `readRemoved(...).claude`
  not true) and Harness's own skill in `dirname(claudeSettingsPath())`. Codex: `readRemoved(...).codex` not true,
  `codexPluginState(codexHome) === 'on'` and Harness's own skill in `codexHome`. "Harness's own skill" means a file
  with the marker line, of any release's text (`held` is `same` or `ours`).
- **The hook**: `SessionStart`, matcher `startup|resume|clear|compact`, `timeout: 5`, `onFailure: 'continue'`, the
  plugin's two-shell form. The hook's stdin reaches the command, as it reaches `asked`. stderr is dropped and the exit
  is always 0. Only stdout that starts with
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":` passes on. Anything else a launcher
  prints is dropped, such as an old CLI's usage (`cli.ts` `usage()` prints with `console.log`) or another hook's JSON,
  because both engines add a SessionStart hook's plain stdout to the model's context.
- **Codex trust**: key `harness-device@openharness:hooks/codex.json:session_start:0:0`, with the matcher hashed.
  `devices/codexPluginTrust.ts` does not change, because `REVIEWED.events` and `REVIEWED.matcherEvents` already list
  `SessionStart`. The dial setup's update after the CLI update writes the three records, as Part 7 built.
- **Nothing stored, synced or exposed.** No new count, file, table or log line. The spec's Design section stands as
  written. Codex's side is read from #4642's field counts.
- **Unchanged**: the skill's text in `cli/src/devices/dialSkill.ts` (v1's, as on `main`), `cli/src/core/`,
  `cli/src/architecture.coreFiles.txt`, `core/api.ts`, `cli/hook/notify.mjs`,
  `cli/src/services/`, `cli/src/cable/`, `plugins/harness-device/hooks/device.js` and its test, the backend, Desktop,
  the firmware.
- **Eval**: `--spend-cap-usd 175` on every invocation, `--concurrency 3` at most, `--timeout-s 900`. Exit 3 (account
  limit) or 4 (cap): stop and report the spend. Never raise the cap, switch accounts or work around a limit. No CPU-heavy
  loop on the Mac. `CLAUDE_CONFIG_DIR` is the session's profile, never `~/.claude`. No transcript text, judge reason,
  path or user name in any commit, `change.md`, narrative, README or pull request.
- **Red, then green.** A behavior task commits its failing test first, then the change. Run only the named specs; the
  suites run on CI. No fixed sleeps.
- **Commit only the files a task names** (`git add <path>…`).
- Comments say why (cli/AGENTS.md). Copy and names follow `docs/naming-system.md`. Docs are in English. One pull request.

## Review Focus

1. **A launcher that prints something else.** That could be an older or foreign `harness` printing its usage to stdout,
   another hook's JSON, or text on stderr. Either engine would add it to every session's context. Expected: nothing
   reaches the session. Pinned in Task 2 and Task 4 (`prints nothing but the line`) and in their Windows runner cases.
2. **Windows PowerShell rewrites native output** in its console code page, with CRLF. Expected: the line arrives intact.
   Pinned by Task 1's ASCII test and Task 2's win32 runners (`stdout.trim()` equals the line).
3. **A session in an Orca profile or another `CLAUDE_CONFIG_DIR`, whose `skills/` links to `~/.claude/skills`.**
   Expected: the skill is found through the link, and only in that session's own home. Pinned in Task 1 (the linked
   folder, a skill in another home only).
4. **The person's own `dial` skill**, a CRLF copy, a link at `dial/SKILL.md`, or an older Harness text. Expected: only a
   file with Harness's marker line counts, of any release. Pinned in Task 1.
5. **The eval's hook never reaching the model.** That would be project hooks under `--setting-sources project` in
   `-p`, or a probe that reads only the listing, giving a pass that measures v1 twice at $36. Expected: the pass stops
   before any case. Pinned in Task 7 (`start line not given`, exit 2). Likewise, the line and the skill's description
   drifting apart is pinned in Task 1 (the agreement test).
6. **Harness's own one-shots** (the voice router, the window names) running `codex exec` or `claude -p` under the
   person's homes. Expected: no line, because their `cwd` is in the data folder. Pinned in Task 1 and Task 3 (a `cwd`
   in `voice-route-scratch` and the data folder itself), in Task 5 (the carried Codex hook) and in Verification 1 and 2
   with the real CLIs.

Stated limits for the pull request: a Claude Code session resumed with the plugin gets the line again, because the spec
covers every source (Codex does the same on `resume`). Windows PowerShell's own 2-3.5 s start (the plugin README's
measurement) delays a session start where Claude Code has no Git Bash, as the plugin's other hooks already do. Codex
on Windows always runs its hooks through PowerShell, so each Codex session start there is about 1.5 s slower; a
SessionStart hook cannot run in the background, since it must return its `additionalContext` before the first turn. A
Claude session with the skill and no plugin has the skill alone. A real Claude Code or Codex session was not run on
Windows (decision 11).

---

### Task 1: the line and `harness device claude start`

**Effort:** high. **Depends on:** none.

**Files:**
- Create: `cli/src/deviceClaude/start.ts`
- Create: `cli/src/deviceClaude/start.spec.ts`
- Modify: `cli/src/devices/dialSkill.ts` (export `ownSkill`; `installedSkills`'s inner `ours` becomes it)
- Modify: `cli/src/deviceClaude/asked.ts` (export `hookInput`, unchanged)
- Modify: `cli/src/deviceClaude/command.ts` (the `claude start` case; the header comment lists `start` among the plugin's
  words a person never types)
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Produces, in `start.ts`: `export const DIAL_START_LINE: string` (the Global Constraints' text);
  `export function startOutput(): string` (the JSON, one line, no newline);
  `export function ownSkillIn(home: string): boolean` (`skillsFolderOf(home, false)`, then `ownSkill`; never throws);
  `export async function runStart(deps: { stdin: AsyncIterable<Buffer | string>; dataDir: string; acts(): boolean;
  out(line: string): void }): Promise<0>` (reads the input whole with `hookInput`; prints `startOutput()` once when the
  input's `cwd` is a string outside `dataDir` by `within` and `acts()` is true; anything thrown means nothing printed;
  always 0).
- Produces, in `dialSkill.ts`: `export function ownSkill(skills: string): boolean` (`held(skills)` is `same` or `ours`).
- `command.ts`: `case 'start': return runStart({ stdin: deps.stdin, dataDir: deps.dataDir, acts: () => pluginActs(deps.dataDir) && ownSkillIn(claudeHome()), out: deps.out })`.
  Task 3 adds Codex's case. Task 8 writes the variant's answer from `startOutput()`.

- [ ] **Step 1: Write the failing tests.**
  - `start.spec.ts`:
    - `'the line is the spec's, word for word'`: `DIAL_START_LINE` `toBe` the Global Constraints' text.
    - `'the line is at most 300 characters of printable ASCII on one line, with the command, both flags and the moment'`:
      length ≤ 300; `/^[\x20-\x7e]+$/`; contains `harness device notify`, `--suggest`, `--waiting`, `--proceeding` and
      `leaves them something to decide, answer or do`; no `<` or `>`.
    - `'the line and the dial skill's description agree: the same command, flags and moment'`: for each of
      `harness device notify "[the ask`, `--suggest "[your pick]"`, `--waiting`, `--proceeding`, `decide, answer or do`
      and `Not for finished work or progress.`, both `DIAL_SKILL_DESCRIPTION` (v1's, from #4666) and `DIAL_START_LINE`
      contain it.
    - `'startOutput is the SessionStart JSON on one line'`: no `\n`; `JSON.parse` `toStrictEqual`
      `{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: DIAL_START_LINE } }`.
    - `ownSkillIn` true: `writeSkill(skillsFolderOf(home, true)!)`; the old 0.6.58 text
      (`'---\nname: dial\ndescription: older\n# Written by Harness. Turn off the agent in Harness Device to remove it.\n---\n\nOlder.\n'`).
      Also true through a `skills/` that links to another home's folder (skip on win32).
    - `ownSkillIn` false: no `skills/`; no `dial/`; the person's own `SKILL.md` without the marker; the skill as CRLF; a
      link at `dial/SKILL.md` to Harness's text (skip on win32); `skills` a file; a skill in another home only.
    - `runStart`, with `START_INPUT` (`hook_event_name: 'SessionStart'`, `source: 'startup'`, `cwd` a project folder
      outside `dataDir`): prints once when `acts` is true; prints nothing when it is false; prints nothing and returns
      0 when `acts` throws; returns 0 when `out` throws. Prints nothing, with `acts` true, for a `cwd` that is
      `dataDir` itself, `<dataDir>/voice-route-scratch` (the voice router's one-shots) and
      `<dataDir>/window-names-scratch`; for input that is not JSON, a JSON array, an object without `cwd`, a `cwd` that
      is not a string, and input over 256 KiB (read whole, then nothing). A `cwd` beside the data folder whose name
      starts with it (`<dataDir>-other`) prints the line.
  - `command.spec.ts`, `describe('harness device claude start')`, using the spec's throwaway `CLAUDE_CONFIG_DIR` and data
    folder, with no daemon socket anywhere:
    - `'prints the line with Harness's skill in the session's home and the plugin on, and exits 0'`: skill written into
      `claudeHome`; `device(['claude', 'start'], { dataDir, stdin: [JSON.stringify(START_INPUT)], claude: () => { throw … } })`
      `toEqual({ code: 0, out: [startOutput()], err: [] })`.
    - `it.each` `'prints nothing and exits 0: %s'`: the plugin uninstalled (`pluginOn(false)`); turned off
      (`enabledPlugins` false); removed (`writeRemoved(dataDir, 'claude', true)`); no skill; the person's own `dial`
      skill; Harness's skill in a Codex home only; a session in `<dataDir>/voice-route-scratch` (a Harness one-shot);
      no input. Each `{ code: 0, out: [], err: [] }`.
    - `'start is not in DEVICE_USAGE'`: `expect(DEVICE_USAGE).not.toMatch(/device (claude|codex) start/)`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/deviceClaude/start.spec.ts src/deviceClaude/command.spec.ts`.
  Expected: FAIL, `start.ts` not found, and `claude start` prints the usage and exits 1.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement.** `start.ts`'s header comment says what the line is for, which files it reads, why a `cwd` in
  the data folder gets nothing (Harness's own one-shots run there, and SessionStart runs under `codex exec` too), and
  why it prints nothing on any failure: what it prints goes into the model's context. `runStart` wraps the read,
  `acts()` and `out()` in one try.
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/deviceClaude/start.spec.ts src/deviceClaude/command.spec.ts src/deviceClaude/asked.spec.ts src/devices/dialSkill.spec.ts && npm run typecheck`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 2: Claude Code's SessionStart hook in the plugin

**Effort:** high. **Depends on:** none (its tests use a fake launcher with a literal SessionStart line).

**Files:**
- Modify: `plugins/harness-device/hooks/hooks.json`
- Create: `plugins/harness-device/hooks/start` (mode 755)
- Modify: `cli/scripts/lib/claudePluginBundle.mjs` (`EXECUTABLE` gains `plugins/harness-device/hooks/start`, appended)
- Test: `cli/src/harnessDevicePlugin.spec.ts`, `cli/src/devices/claudePluginBundle.spec.ts`

The spec's "`plugins/harness-device/test/`" is the plugin's own test. As in Parts 6 and 7, the hook tests live in
`cli/src/harnessDevicePlugin.spec.ts`. `plugins/harness-device/test/device.test.ts` tests the mod, which does not change.

**Interfaces:**
- Produces: `hooks.json` keys `['PermissionRequest', 'SessionStart']`. `SessionStart` is
  `[{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command, onFailure: 'continue', timeout: 5 }] }]`.
  In `command`, the POSIX first line is ``echo `# <#` >/dev/null; exec "${CLAUDE_PLUGIN_ROOT}/hooks/start"``. After
  `#>` comes the PermissionRequest form's PowerShell lookup verbatim, without its `HARNESS_DEVICE_MOD_ASKS` check, ending
  `if ($h) { $o = & $h device claude start 2> $null; if ("$o".StartsWith('{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":')) { [Console]::Out.Write("$o") } }; exit 0`.
- `hooks/start`: the launcher lookup of `hooks/asked` (`$HOME/.local/bin/harness`, then `$USERPROFILE/.harness/bin/harness.exe`,
  then `harness` on `PATH`) runs `device claude start`, its stdin the hook's own, with stderr to `/dev/null`, and
  captures its stdout. With no launcher it reads its stdin to the end (`cat >/dev/null`), as `hooks/asked` does. It prints that
  stdout followed by a newline only when it starts with the prefix above, then `exit 0`. Its comment says why: Claude
  Code adds a SessionStart hook's stdout to the session's context, so only the line the command shapes may pass, and the
  hook decides nothing.

- [ ] **Step 1: Write the failing tests** in `harnessDevicePlugin.spec.ts`. Helpers: `startHook(root)`, `START_INPUT`
  (`session_id`, `transcript_path`, `cwd`, `hook_event_name: 'SessionStart'`, `source: 'startup'`), and
  `SESSION_LINE = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The person has a Harness dial."}}'`.
  - The existing `'hooks.json holds one PermissionRequest command hook …'` becomes `'hooks.json holds the PermissionRequest
    hook and one SessionStart command hook for startup, resume, clear and compact, 5 s, onFailure continue'`: keys,
    matchers and the hook object as above.
  - `posix.each(SHELLS)('the SessionStart hook runs hooks/start under %s from a folder with a space, and prints the
    launcher's line')`: launcher prints `SESSION_LINE`, exits 0, and saves its stdin. Expect argv file
    `device\nclaude\nstart\n`, the saved stdin equal to `START_INPUT`'s JSON, and
    `{ status: 0, stdout: SESSION_LINE + '\n', stderr: '' }`.
  - `posix('the SessionStart hook prints nothing but the line')`, with a launcher that prints each of: usage text
    (`harness v0.6 — connect this computer to your machine`), `ALLOW` (another hook's JSON), and `''`, crossed with exit
    codes 0, 1 and 2, and writes to stderr. Each gives `{ status: 0, stdout: '', stderr: '' }`.
  - `posix('with no launcher the SessionStart hook prints nothing and exits 0')`.
  - `posix('the SessionStart hook runs ~/.local/bin/harness first, then the profile's harness.exe, then PATH')`: three
    placements, the first present one runs.
  - `posix('hooks/start is executable and starts with #!/bin/sh')`.
  - `'the SessionStart Windows form turns module loading off, looks in the profile then each absolute PATH folder, runs
    device claude start once, writes only the SessionStart line, and exits 0'`. Same checks as the PermissionRequest
    form's test, plus: `calls` matches `device claude start 2> $null` once; it contains the `StartsWith('{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":')`
    guard; it has no `HARNESS_DEVICE_MOD_ASKS`; it ends `; exit 0`.
  - In `describe.runIf(win32)`, `standIn` takes what it prints (default `ALLOW`). For each runner (PowerShell, Git Bash):
    `'${runner.name}: SessionStart prints the launcher's SessionStart line and exits 0'` (`result.stdout.trim()` is
    `SESSION_LINE`, status 0, and the stand-in received `START_INPUT` on its stdin); `'… prints nothing for a launcher that prints anything else'` (`ALLOW`; stdout `''`);
    `'… with no launcher, prints nothing and exits 0'`.
  - `claudePluginBundle.spec.ts`: the executable test (renamed `'the device plugin's hook scripts alone are executable, as
    in the checkout'`) expects `['plugins/harness-device/hooks/asked', 'plugins/harness-device/hooks/codex-asked', 'plugins/harness-device/hooks/start']`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts src/devices/claudePluginBundle.spec.ts`.
  Expected: FAIL (no `SessionStart` key, no `hooks/start`, executable list differs; the win32 block skips off Windows).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the three files.
- [ ] **Step 5: Run them and see them pass.** Same command. Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 3: `harness device codex start`

**Effort:** high. **Depends on:** Task 1.

**Files:**
- Modify: `cli/src/deviceClaude/command.ts` (`codexCommand`'s `case 'start'`, the header comment)
- Test: `cli/src/deviceClaude/command.spec.ts`

**Interfaces:**
- Consumes: Task 1's `runStart`, `ownSkillIn`, `startOutput`; `readRemoved`; `codexPluginState` (`devices/codexPlugin.ts`).
- Produces: `case 'start': return runStart({ stdin: deps.stdin, dataDir: deps.dataDir, acts: () => readRemoved(deps.dataDir).codex !== true && codexPluginState(deps.codexHome) === 'on' && ownSkillIn(deps.codexHome), out: deps.out })`.
  An `unknown` `config.toml` is not on: Codex cannot start on a file it cannot parse, and the spec says "the plugin on".

- [ ] **Step 1: Write the failing tests** in `describe('harness device codex')`, with `codexHome = folder()`, its
  `config.toml` holding `[plugins."harness-device@openharness"]\nenabled = true\n`, and Harness's skill written into
  `skillsFolderOf(codexHome, true)`:
  - `'codex start prints the line with Harness's skill in the Codex home and the plugin on there, and exits 0'`:
    `device(['codex', 'start'], { dataDir, codexHome, stdin: [JSON.stringify(START_INPUT)], codex: () => { throw … } })`
    `toEqual({ code: 0, out: [startOutput()], err: [] })`.
  - `it.each` `'codex start prints nothing and exits 0: %s'`: removed (`writeRemoved(dataDir, 'codex', true)`);
    `enabled = false`; no plugin table; no `config.toml`; a `config.toml` that does not parse; no skill; the person's
    own `dial` skill; Harness's skill in the Claude Code home only; Harness's own one-shot, Codex's input with `cwd`
    `<dataDir>/voice-route-scratch` and `model`, `permission_mode` and `source: 'startup'` as the spike saw them.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/deviceClaude/command.spec.ts`. Expected:
  FAIL (`codex start` prints the usage and exits 1).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the case.
- [ ] **Step 5: Run them and see them pass.** `cd cli && npx vitest run src/deviceClaude/command.spec.ts && npm run typecheck`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 4: the Codex manifest's SessionStart hook, trusted as the others

**Effort:** high. **Depends on:** Task 2 (it mirrors `hooks/start`, and the executable list it expects holds Task 2's).

**Files:**
- Modify: `plugins/harness-device/hooks/codex.json`
- Create: `plugins/harness-device/hooks/codex-start` (mode 755)
- Modify: `cli/scripts/lib/claudePluginBundle.mjs` (`EXECUTABLE` gains `plugins/harness-device/hooks/codex-start`, appended)
- Test: `cli/src/harnessDevicePlugin.spec.ts`, `cli/src/devices/claudePluginBundle.spec.ts`, `cli/src/devices/codexPluginTrust.spec.ts`

**Interfaces:**
- Produces: `codex.json` keys `['PermissionRequest', 'PreToolUse', 'SessionStart']`. `SessionStart` is
  `[{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command, onFailure: 'continue', timeout: 5 }] }]`.
  In `command`, the POSIX first line is ``echo `# <#` >/dev/null; exec "$PLUGIN_ROOT/hooks/codex-start"``. After `#>`
  comes the Codex PermissionRequest form's lookup, ending with Task 2's guarded write for `device codex start`.
- `hooks/codex-start`: `hooks/codex-asked`'s lookup (`$HOME/.local/bin/harness`, then `PATH`) with Task 2's capture and
  prefix guard, running `device codex start`, `exit 0`. Its comment adds that Codex injects a SessionStart hook's plain
  stdout too (the spike).
- Its trust record: key `harness-device@openharness:hooks/codex.json:session_start:0:0`, hashed with its matcher, by
  the unchanged `pluginTrustRecords`.

- [ ] **Step 1: Write the failing tests.**
  - `harnessDevicePlugin.spec.ts`: the existing codex.json test becomes `'hooks/codex.json holds the PermissionRequest
    and PreToolUse hooks and one SessionStart hook for startup, resume, clear and compact, 5 s, onFailure continue, and
    no mod'`. Then the Codex counterparts of Task 2's cases, run by `runCodexHook`'s way (`<shell> -c`, `PLUGIN_ROOT` in
    the environment), with a folder named with a space, a quote and a dollar sign: the line passes (argv
    `device\ncodex\nstart\n`, the launcher's stdin the hook's input); usage, `ALLOW`, stderr and exits 1 and 2 print nothing; with no launcher it prints
    nothing; `hooks/codex-start` is executable with `#!/bin/sh`; and the Windows form (`device codex start 2> $null`
    once, the guard, no `HARNESS_DEVICE_MOD_ASKS`, `; exit 0`). In the win32 block, through `runCodex`
    (`powershell.exe -NoProfile -Command`): the line passes (`stdout.trim()`), `ALLOW` prints nothing, and no launcher
    prints nothing.
  - `claudePluginBundle.spec.ts`: the executable list is Task 2's plus `'plugins/harness-device/hooks/codex-start'`.
  - `codexPluginTrust.spec.ts`: `'the repository's plugin gets a record for each of its hooks, session_start first, its
    matcher hashed'`. `pluginTrustRecords(<repo>/plugins/harness-device)`'s keys are `[…:session_start:0:0,
    …:permission_request:0:0, …:pre_tool_use:0:0]`, all with one `contentHash`. The `session_start` record's
    `trustedHash` equals `reviewHash({ ...hooks.settings.reviewed!, matcherEvents: [...] }, 'SessionStart',
    'startup|resume|clear|compact', { command, timeout: 5 })` and differs from that hash with the matcher `undefined`.
    (Red: there is no `session_start` key today.)
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts src/devices/claudePluginBundle.spec.ts src/devices/codexPluginTrust.spec.ts`.
  Expected: FAIL.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** the three files. `codexPluginTrust.ts` does not change. If the record test still fails after
  `codex.json` is right, stop and report: Part 7's `REVIEWED` then differs from what the spike measured.
- [ ] **Step 5: Run them and see them pass.** Same command. Expected: PASS (the win32 block skips off Windows).
- [ ] **Step 6: Commit.**

### Task 5: end to end: the carried hooks print the line from the devices' own setup

**Effort:** high. **Depends on:** Tasks 1, 2, 3 and 4.

**Files:**
- Create: `cli/e2e/deviceStartLine.e2e.ts` (no change to `cli/e2e/harness/`)

**Interfaces:**
- Consumes: `IsolatedDaemon`, `Desk` and its `FakeDial`, `fileBundle()` (the daemon and the commands on a build, which
  carries the marketplace), `harnessPath('claude-marketplace', HOME)`, Task 1's `startOutput`, and the real CLI the way
  `inOrca.ts` `asked` runs it (`E2E_BUNDLE_PATH`, else `--import tsx src/cli.ts`, from `CLI_ROOT`).

- [ ] **Step 1: Write the test**, set up as `deviceDialSkill.e2e.ts`'s first-attach case. The daemon gets its own root,
  with `HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` inside it and fake engines. A local helper `launcher(d)` writes
  `<HOME>/.local/bin/harness` as `#!/bin/sh` + `exec <node> <bundle or --import tsx src/cli.ts> "$@"` (with
  `CLI_ROOT` as its folder for tsx). A helper `sessionStart(d, engine)` reads the carried folder's `hooks/hooks.json` or
  `hooks/codex.json` `SessionStart` command and runs it under `/bin/sh -c` with `d.env`. For Claude Code,
  `${CLAUDE_PLUGIN_ROOT}` is replaced by the carried plugin folder; for Codex, `PLUGIN_ROOT` is set. `START_INPUT` goes
  on stdin, with `cwd` a project folder in the root outside the data folder unless a case says otherwise, and the
  helper returns `{ code, stdout, stderr }`.
  - `'after the first attach the carried Claude Code hook prints the line, and after claude disable nothing'`: attach,
    then wait until `<CLAUDE_CONFIG_DIR>/skills/dial/SKILL.md` and the carried `hooks/start` exist. Turn the plugin's
    entry on in `settings.json`, as `inOrca.ts` does. Run: `{ code: 0, stdout: startOutput() + '\n', stderr: '' }`.
    Then `harness device claude disable` (the real CLI, `d.env`), and run again: `{ code: 0, stdout: '', stderr: '' }`.
  - `'the carried Codex hook prints the line with Harness's skill in the Codex home and the plugin on there, and after
    codex disable nothing'`. The fake Codex is below `MIN_CODEX`, so the setup writes no plugin table. The test writes
    `[plugins."harness-device@openharness"] enabled = true` into `$CODEX_HOME/config.toml` itself. Run: the line.
    `harness device codex disable`, run again: nothing.
  - `'the carried Codex hook prints nothing for Harness's own one-shot, a session in the data folder'`: set up as the
    case above, plugin on and skill present, but `START_INPUT`'s `cwd` is `<data folder>/voice-route-scratch`, where
    `voiceRouter.ts` runs its one-shots: `{ code: 0, stdout: '', stderr: '' }`.
- [ ] **Step 2: Run it.** `cd cli && npx vitest run --config vitest.e2e.config.ts e2e/deviceStartLine.e2e.ts`.
  Expected: PASS on top of Tasks 1-4. Its red is theirs: before them there is no `SessionStart` key in the carried hooks.
- [ ] **Step 3: Commit.** One commit.

### Task 6: product docs

**Effort:** medium. **Depends on:** Tasks 1, 2, 3 and 4. **Test that must fail first:** none (docs); one commit.

**Files:**
- Modify: `plugins/harness-device/README.md` (an "At session start" section: the line, word for word; added at start,
  resume, clear and compact, in Claude Code through `hooks/hooks.json` and in Codex through `hooks/codex.json`, trusted
  as its other hooks; only while Harness's own dial skill is in that session's home, the plugin is on, `disable` has
  not removed the engine and the session is not in Harness's data folder, where Harness's own one-shots run; it reads no daemon or network and decides nothing; a launcher's other output is dropped; and
  `harness device claude disable` / `codex disable` take it away. Add one line to "What it never does": it adds no other
  text to a session.)
- Modify: `docs/cli.md` (the `harness device claude` and `harness device codex` rows: one sentence each, that the plugin
  also adds one line about the dial to each session's context when it starts, resumes, clears or compacts, while
  Harness's own dial skill is in that home)
- Modify: `cli/AGENTS.md` (the devices row, beside the plugin's PermissionRequest clause: its `SessionStart` hooks run
  `harness device claude start` / `codex start`, which print the dial's line into the session's context only while
  Harness's own skill is in that home, the plugin is on and not removed, with no daemon and no network,
  `deviceClaude/start.ts`)

- [ ] **Step 1:** Write them, short. No UI element changes, so the design doc does not change.
- [ ] **Step 2:** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts` (its README test). Expected: PASS.
- [ ] **Step 3: Commit.**

### Task 7: the listing probe proves the session-start line reached the model

**Effort:** high. **Depends on:** none. It changes a file under `_state.json` `harness_paths`, so Task 9's first pass
asks for `--approve-harness`.

**Files:**
- Modify: `cli/evals/dial-skill/lib/probe.ts`
- Modify: `cli/evals/dial-skill/README.md` ("Hooks in a variant" and "The listing probe": one sentence each)
- Test: `cli/evals/dial-skill/probe.spec.ts`, `cli/evals/dial-skill/run-eval.spec.ts` (only expectations on probe rows,
  which gain `start_line: null`)

**Interfaces:**
- Produces: `export function startContext(answers: readonly HarnessAnswer[] | undefined): string | null` returns the
  `additionalContext` of the first answer whose stdout, trimmed, parses as
  `{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: <string> } }`, else null.
  `export function readStartContexts(transcript: string): string[]` returns the `content` strings of each
  `{ type: 'attachment', attachment: { type: 'hook_additional_context', hookEvent: 'SessionStart', content: string[] } }`
  line of a saved transcript. That is the shape Claude Code 2.1.332 writes, with `hookName` and `toolUseID` also
  `SessionStart`. Torn and non-JSON lines are skipped. `Probe.start_line: boolean | null` is null when
  `startContext(opts.answers)` is null; otherwise it says whether a read context includes that line.
  `probeFailure` returns `'start line not given'` when `start_line === false`, checked after the listing's checks.
  Probe rows hold the boolean alone, never the text.

- [ ] **Step 1: Write the failing tests** in `probe.spec.ts`:
  - `describe('startContext')`: the line from `[{ argv: ['device', 'claude', 'start'], stdout: <json> + '\n' }]`; null
    for no answers, `ALLOW`-shaped JSON of another event, text that is not JSON, and a SessionStart answer whose
    `additionalContext` is not a string.
  - `describe('readStartContexts')`: takes a SessionStart attachment's content; leaves out a `UserPromptSubmit` one, a
    user message holding the same words, and a torn last line.
  - `describe('probeFailure')`: `start_line: false` gives `'start line not given'`; `true` and `null` give what they
    give today. The existing probe objects gain `start_line: null`.
  - `describe('probeListing')`: `fakeClaude` gains a branch. When the staged `.claude/settings.json` holds
    `hooks.SessionStart`, it runs that command with `/bin/sh -c` under its own environment and writes a
    `hook_additional_context` SessionStart attachment holding the output's `additionalContext` into the saved
    transcript. Cases: `'with a variant's SessionStart hook, the probe reads the line the model was given'`, using hooks
    `{ SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'harness device claude start', timeout: 5 }] }] }`
    and the answer above, giving `start_line: true, failure: null` in each condition. `'fails with start line not given
    when the transcript holds no such context'`: the hook's answer prints nothing, giving `start_line: false`.
    `'without a SessionStart answer, start_line is null'`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/probe.spec.ts evals/dial-skill/run-eval.spec.ts`.
  Expected: FAIL (no such exports, no `start_line`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**, with comments saying why: runs are not saved, so the probe's transcript is the one proof the
  hook's line reached the model, as it is for the listing.
- [ ] **Step 5: Run the eval's whole suite.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 8: the Part 4 variant, `flow/v3`

**Effort:** medium. **Depends on:** Task 1.

**Files:**
- Create: `cli/evals/dial-skill/flow/v3/SKILL.before.md` and `cli/evals/dial-skill/flow/v3/SKILL.md` (both
  `flow/v1/SKILL.md` byte for byte: v3 keeps v1's text and adds the line)
- Create: `cli/evals/dial-skill/flow/v3/hooks.json`:
  `{ "SessionStart": [{ "matcher": "startup|resume|clear|compact", "hooks": [{ "type": "command", "command": "harness device claude start", "timeout": 5 }] }] }`
  (the fake on the staged `PATH` answers it)
- Create: `cli/evals/dial-skill/flow/v3/harness-answers.json`: `[{ "argv": ["device", "claude", "start"], "stdout": <startOutput() + "\n"> }]`,
  written from Task 1's code with `npx tsx -e`, never typed by hand
- Modify: `cli/evals/dial-skill/flow/_state.json` (`harness_paths` gains the two files)
- Test: `cli/src/deviceClaude/start.spec.ts`; `cli/evals/dial-skill/state.spec.ts`'s existing `'lists every variant's
  hooks.json and harness-answers.json'` must pass

**Interfaces:**
- Produces: the variant Task 9 runs. The runner refuses any variant whose `SKILL.md` is not `DIAL_SKILL`, and v1's text is
  `DIAL_SKILL` on this base.

- [ ] **Step 1: Write the failing test** in `start.spec.ts`: `'the eval's Part 4 variant answers exactly what this command
  prints'`. In `cli/evals/dial-skill/flow/v3/harness-answers.json`, the answer with argv `['device', 'claude', 'start']`
  has stdout `startOutput() + '\n'` and no `stderr` or non-zero `code`. In `flow/v3/hooks.json`, `SessionStart`'s one
  hook runs `harness device claude start` with the matcher of the plugin's `hooks/hooks.json` `SessionStart`.
- [ ] **Step 2: Run it and see it fail.** `cd cli && npx vitest run src/deviceClaude/start.spec.ts`. Expected: FAIL (`ENOENT`).
- [ ] **Step 3: Commit the red test.**
- [ ] **Step 4: Write the files** and list the two in `harness_paths`.
- [ ] **Step 5: Run.** `cd cli && npx vitest run src/deviceClaude/start.spec.ts && npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/state.spec.ts`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 9: the eval pass: v1 with the line, val and test in every condition

**Effort:** high. **Depends on:** Tasks 7, 8 and 12, and, by the orchestrator's order, Tasks 1-6 landed first.
**Runs in this worktree** (`/Users/nqhieu84/orca/workspaces/openharness/needs-you-right-start-line`), whose git-ignored
traces must outlive the task. **Test that must fail first:** none (it measures). Its checks are the exit codes, the
probes, `scrub` and the eval's suite.

**Needs the user's own Claude Code sign-in**, through the session's profile in `CLAUDE_CONFIG_DIR`, as Part 3's
passes did.

**Files:**
- Create: `cli/evals/dial-skill/flow/v3/{change.md,results.jsonl,errors.jsonl,probes.jsonl,summary.json,table.md}`
  (`errors.jsonl` only if written)
- Modify: `cli/evals/dial-skill/flow/narrative.md`, `cli/evals/dial-skill/flow/metrics.md` (by `summarize`),
  `cli/evals/dial-skill/flow/_state.json` (`harness_sha` by `--approve-harness`, `current_round` 3, and `best`
  `{ round: 3, val_score, test_score }` only if the verdict ships; otherwise `best` stays round 1)
- Git-ignored, kept on this Mac: `flow/v3/traces/`, `flow/v3/private.jsonl`

**Spend plan** (per-run costs from v1's passes: `crowd` $0.31, `clean` $0.24, `name-only` $0.28, a probe about $0.2):

| Step | Runs | About |
|---|---|---|
| Spent (Parts 1 and 3) | | $114.97 |
| `crowd` val and test, 3 reps (decision 12) | 75 + 1 probe | $23.5 |
| `clean` val and test, 2 reps | 50 + 1 probe | $12.1 |
| `name-only` val and test, 1 rep | 25 + 1 probe | $7.2 |
| Flow after the pass | | about $158; cap $175 |

- [ ] **Step 1: Check the start.** From `cli/`: `CLAUDE_CONFIG_DIR` is set and is not `~/.claude`.
  `diff <(npx tsx -e 'import { DIAL_SKILL } from "./src/devices/dialSkill.ts"; process.stdout.write(DIAL_SKILL)') evals/dial-skill/flow/v3/SKILL.md`
  prints nothing, and likewise for `flow/v1/SKILL.md`. `git status --short` prints nothing (the spec and this plan are
  the branch's first commit). `_state.json` `best.round` is 1. The status table's last `spend` is $114.97.
  `marker=$(mktemp)`.
- [ ] **Step 2: `crowd` at 3 reps.**
  `npx tsx evals/dial-skill/run-eval.mjs --flow evals/dial-skill/flow --variant v3 --condition crowd --split val,test --reps 3 --concurrency 3 --timeout-s 900 --spend-cap-usd 175`
  - Exit 2, "harness changed": review `git diff <_state.json harness_sha> -- <its harness_paths>`. Expect only Task 7's
    `lib/probe.ts` and Task 8's `v3/hooks.json` and `v3/harness-answers.json`. If so, rerun with `--approve-harness`.
    For anything else, stop and report.
  - Exit 2, `listing probe · <condition>: start line not given` (or any probe failure): stop and report the probe row's
    `listing` and `start_line` (Review Focus 5).
  - Exit 1: rerun the same command, which runs only the failed cases. Exit 3 or 4: stop and report the spend.
  - Expected: 1 probe with `start_line: true`, 75 rows, about $23.5.
- [ ] **Step 3: `clean` and `name-only`.** The same command with `--condition clean --reps 2`, then with
  `--condition name-only --reps 1`. Same exits as Step 2. Expected: 2 probes (`dial` `name-only` among them), each
  `start_line: true`; 50 and 25 rows; about $19 together.
- [ ] **Step 4:** `find -H "$CLAUDE_CONFIG_DIR"/ "$CLAUDE_CONFIG_DIR"/*/ -newer "$marker" | sort -u` lists only the
  startup files the README names. Then `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`.
- [ ] **Step 5: Read the numbers**, counts and scenario names only. From the held-out table, read v1's and v3's rows in
  each condition: recall, needless rings, `line_ok`, `ask_ok`, harmed, `went_on`, `one_step`, `loaded`, and v3's
  `recall vs best` (Task 12; best is still round 1, v1). Sort v3's `crowd` misses by `loaded` 0 and 1, and list
  needless rings by scenario.
- [ ] **Step 6: The verdict**, by decisions 9 and 10, from those rows. The line ships only when both hold:
  - **gain:** v3's `recall vs best` interval is above 0 (low end > 0) in `crowd` or in `name-only`, and below 0 (high
    end < 0) in none of `crowd`, `clean` and `name-only`;
  - **specificity:** v3's needless rings in `crowd`, `clean` and `name-only`, over their pooled no-need runs, leave at
    least 95% quiet (at most 2 of 54).

  State each interval and the pooled count it rests on, and `name-only`'s needless rings on their own. Also state: held-out `crowd` recall with the line (k of n, %),
  and "Part 5 opens" when it is under 90%.
- [ ] **Step 7: Write `flow/v3/change.md`** (`# Part 4: v1 and a standing line at session start`; Evidence, Change,
  Result, numbers only) and a `## Part 4` section in `narrative.md` with the same numbers. Set `_state.json` as in
  Files, then summarize again.
- [ ] **Step 8: Make the rows fit to commit:** `npx tsx evals/dial-skill/flow-rows.ts scrub evals/dial-skill/flow`
  exits 0; `node evals/dial-skill/build-report-lite.mjs evals/dial-skill/flow`; `git status --short -- evals/dial-skill/flow`
  shows only the files above; `grep -nE '^>|/Users/|~/|'"$(whoami)" evals/dial-skill/flow/v3/change.md evals/dial-skill/flow/narrative.md`
  prints nothing.
- [ ] **Step 9:** `npx vitest run --config evals/dial-skill/vitest.config.ts`. Expected: PASS.
- [ ] **Step 10: Commit** the files above (`Dial skill eval: Part 4, v1 with a line at session start, on val and test in
  every condition`). The measurement is committed whatever the verdict.

**Report** (to the main session, numbers only): the held-out rows of v1 and v3 in every condition, the verdict and the
numbers it rests on (the three recall intervals against v1, the pooled needless rings and `name-only`'s alone), the
held-out `crowd` recall with the line and whether Part 5 opens,
the spend per pass and in the flow, and Claude Code's version.

### Task 10: cut the branch down when the line does not gain (only on that verdict)

**Effort:** medium. **Depends on:** Task 9. **Runs only** when Task 9's verdict is that the line does not ship.
**Test that must fail first:** none (it removes the product part). One commit.

**What is dropped:** Tasks 1, 2, 3, 4, 5 and 6 whole, and Task 8's guard (it lives in `start.spec.ts`). Codex's side
goes with Claude Code's: it ships only on Claude Code's gain.
**What stays:** Task 7 (the probe), Task 8's `flow/v3/` files and `_state.json` entries, Task 9's rows and narrative
(the record of what was measured), and Task 11.

**Files:**
- Delete: `cli/src/deviceClaude/start.ts`, `cli/src/deviceClaude/start.spec.ts`, `plugins/harness-device/hooks/start`,
  `plugins/harness-device/hooks/codex-start`, `cli/e2e/deviceStartLine.e2e.ts`
- Restore to `main`'s version (`git checkout $(git merge-base HEAD origin/main) -- <path>`; no other task on this branch
  touches them): `cli/src/devices/dialSkill.ts`, `cli/src/deviceClaude/asked.ts`, `cli/src/deviceClaude/command.ts`, `cli/src/deviceClaude/command.spec.ts`,
  `plugins/harness-device/hooks/hooks.json`, `plugins/harness-device/hooks/codex.json`, `plugins/harness-device/README.md`,
  `cli/scripts/lib/claudePluginBundle.mjs`, `cli/src/devices/claudePluginBundle.spec.ts`, `cli/src/harnessDevicePlugin.spec.ts`,
  `cli/src/devices/codexPluginTrust.spec.ts`, `docs/cli.md`, `cli/AGENTS.md`

- [ ] **Step 1:** Delete and restore as listed.
- [ ] **Step 2:** `git diff $(git merge-base HEAD origin/main) --stat` lists only `cli/evals/dial-skill/**`, the spec
  and this plan.
- [ ] **Step 3:** `cd cli && npx vitest run src/harnessDevicePlugin.spec.ts src/devices/claudePluginBundle.spec.ts src/devices/codexPluginTrust.spec.ts src/deviceClaude/command.spec.ts src/deviceClaude/asked.spec.ts src/devices/dialSkill.spec.ts && npm run typecheck && npx vitest run --config evals/dial-skill/vitest.config.ts`.
  Expected: PASS.
- [ ] **Step 4: Commit** (`Needs you, right, Part 4: the line does not ship; the eval's variant and rows stay`).

### Task 11: results and the spec

**Effort:** medium. **Depends on:** Task 9, and Task 10 when it runs. **Test that must fail first:** none (docs); one
commit.

**Files:**
- Modify: `cli/evals/dial-skill/README.md` (Results: a Part 4 block above Part 3's, with the held-out counts of v1 and v3
  side by side in `crowd`, `clean` and `name-only`, plus `loaded`, `one_step`, the verdict, whether Part 5 opens, and
  the spend. The Cost paragraph states Part 4's cap of $175 for the flow and what it spent.)
- Modify: `cli/evals/dial-skill/flow/narrative.md` (the headline: Part 4's result; a "Findings for Part 5" section when
  held-out `crowd` recall is under 90%)
- Modify: `docs/plans/2026-11-26-needs-you-right-design.md` (only a "Measured (<date>)" paragraph under Part 4 with the
  held-out numbers, the recall intervals against v1, the pooled specificity, the verdict, whether Part 5 opens and the
  spend; the rest of the spec is in the branch's first commit)

- [ ] **Step 1:** Write them, numbers only.
- [ ] **Step 2:** `grep -nE '^>|/Users/|~/|'"$(whoami)"` on the three files finds nothing new, and
  `npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow` leaves the narrative's tables unchanged.
- [ ] **Step 3: Commit** (`Dial skill eval: Part 4's results` or, after Task 10, `…; the line does not ship`).

### Task 12: `summarize` pairs each round's held-out recall with the best round's, beyond noise

**Effort:** high. **Depends on:** none. No tokens are spent: it reads the committed rows. Task 9's verdict reads it
(decision 9).

**Files:**
- Modify: `cli/evals/dial-skill/lib/summarize.ts`
- Modify: `cli/evals/dial-skill/README.md` (the held-out table's paragraph: one sentence on `recall vs best`)
- Modify: `cli/evals/dial-skill/flow/narrative.md` (the held-out table rewritten by `summarize`, its new column only)
- Test: `cli/evals/dial-skill/summarize.spec.ts`

**Interfaces:**
- Produces: `Summary.held_out_recall: Record<string, Record<string, Paired>>`, variant → condition: the paired
  difference in held-out recall against `_state.json`'s best round's same condition. Per variant and condition, each
  val or test case's recall is the mean of `grade.hit` over its status-ok rows that have `hit` (a harmed need run
  counts as 0, as in `heldOut`), keyed by `splitIdOf` like the score means. The deltas over the cases both rounds
  scored go through the existing `interval`, and `significant` is as `paired`'s. The best round itself, and a condition
  the best round never ran, get no entry. With no best round, the field is `{}`.
- `heldOutTable` gains a last column, `recall vs best`: `fmtPaired` of that pair, blank for the best round, `n/a` when
  there is none. `headline`, `statusTable` and `aggregateTable` do not change.
- Read in Task 9: "rises beyond noise" is `ci_lo > 0`; "falls beyond noise" is `ci_hi < 0`.

- [ ] **Step 1: Write the failing tests** in `summarize.spec.ts` (`describe('summarize')`), with the spec's fixture
  flow and `_state.json`'s `best.round` 1:
  - `'pairs each round's held-out recall with the best round's, over the need cases both scored'`: v1 (the best) in
    `crowd` hits `d` 0 of 1, `e` 1 of 2, `h` 0 of 1; v2 hits each of them 1 of 1. A no-need case and a train case are in
    both and in neither pair. `held_out_recall.v2.crowd` has `n` 3, `mean` 0.8333, `ci_lo` 0.1162, `ci_hi` 1.5505 (each
    `toBeCloseTo(…, 3)`), `significant` true.
  - `'reads a fall as an interval below 0'`: v2 misses every case v1 hit; `ci_hi < 0`, `significant` true.
  - `'reads equal recall as within noise'`: every delta 0 gives `mean` 0, `significant` false.
  - `'gives the best round and a condition the best never ran no recall pair'`: `held_out_recall.v1` is undefined;
    v2's `name-only`, with no v1 `name-only` rows, is undefined.
  - `'has no recall pair without a best round'`: `best` removed from `_state.json`; `held_out_recall` is `{}`.
  - The existing `'shows the pooled paired score in the held-out table'` expects the header to end
    `| loaded | score vs baseline | recall vs best |` and each row one more cell. A new
    `'shows the recall pair in the held-out table'`: v2's `crowd` row ends `| +0.83 [0.12, 1.55] |`, v1's rows end
    with a blank cell, and a v2 condition with no pair ends `| n/a |`.
- [ ] **Step 2: Run them and see them fail.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts evals/dial-skill/summarize.spec.ts`.
  Expected: FAIL (no `held_out_recall`, no column).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**, with a comment saying why the pair is against the best round, not the baseline: a round
  ships by beating the text it would replace.
- [ ] **Step 5: Run the eval's whole suite.** `cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts`.
  Expected: PASS.
- [ ] **Step 6: Refresh the committed table.** `cd cli && npx tsx evals/dial-skill/summarize.ts evals/dial-skill/flow`,
  then `git diff --stat -- evals/dial-skill/flow` lists only `narrative.md`, whose diff is the held-out table's new
  column (v1's cells blank as the best round, v2's `crowd` against v1, the baseline's against v1). Anything else
  changed: stop and report.
- [ ] **Step 7: Commit** the four files.

---

## Task graph

| Task | Depends on | Effort |
|---|---|---|
| 1 the line, `claude start`, the agreement test | none | high |
| 2 Claude Code's SessionStart hook | none | high |
| 3 `codex start` | 1 | high |
| 4 Codex's SessionStart hook and its trust record | 2 | high |
| 5 end to end, both engines | 1, 2, 3, 4 | high |
| 6 product docs | 1, 2, 3, 4 | medium |
| 7 the probe proves the line | none | high |
| 8 the variant `flow/v3` | 1 | medium |
| 9 the eval pass (this worktree) | 7, 8, 12 (and 1-6 by order) | high |
| 10 cut down (only on no gain) | 9 | medium |
| 11 results and the spec | 9 (and 10 when it runs) | medium |
| 12 `summarize`: recall against the best round, beyond noise | none | high |

Longest chain: 2 → 4 → 5 → 9 → 10 → 11, six tasks (five when Task 10 does not run). 1 → 3 → 5 → 9 → 10 → 11 is as long.
Task 12 shares `cli/evals/dial-skill/README.md` with Tasks 7 and 11 and `flow/narrative.md` with Tasks 9 and 11, so it
does not run beside Task 7.

## Pull request notes

- One pull request, released by harness-pm: the plugin and the CLI (#4666, its base, is on `main`). The PR names macOS, Linux and Windows.
- Evidence: the red-then-green commits of Tasks 1-4, 7-8 and 12; the held-out table of v1 and v3 and the verdict
  (numbers only: the recall intervals against v1 and the pooled needless rings); Verification 1's and 2's results; the
  hook's time at session start on this Mac (Verification 1) and the `start` command's time (Verification 3), each
  median and maximum; `local-checks.py`'s receipts; the stated limits under Review Focus, among them that a real Claude
  Code or Codex session was not run on Windows and that Codex on Windows starts each session about 1.5 s later.
- Codex is judged in the field by #4642's counts, for the days before and 7 days after the release, as the spec says.

## Verification

**On GitHub, automatic on the pull request** ([validation and release](../validation-and-release.md)): `cli-typecheck`
and `cli-tests` (every spec above; `architecture.spec.ts` and `architecture.failureLogs.spec.ts` among them) for `cli/`
and `plugins/harness-device/`. `linux-e2e` runs the new `deviceStartLine.e2e.ts`. `windows-e2e` x64 runs for
`cli/src/devices/` and `plugins/harness-device*/`; there `harnessDevicePlugin.spec.ts` runs both SessionStart forms
under Windows PowerShell and Git Bash, and Codex's under PowerShell, and `codexPluginTrust.spec.ts` runs the record on
Windows. No workflow is started by hand. `start.spec.ts` is not added to the Windows list: the reads it covers
(`skillsFolderOf`, `held`) already run on Windows in the devices' setup.

**Local gates PR CI does not run:** at the final commit, from a clean tree, `python3 scripts/local-checks.py --run`.
No coverage gate is expected: nothing under `src/core/`, `src/services/` or another gate's area changes, so
`npm run test:core` is not selected. Paste its output in the PR. Also, on macOS, the eval's own specs:
`cd cli && npx vitest run --config evals/dial-skill/vitest.config.ts` (no workflow runs them, by design).

1. **The real Claude Code, on this Mac, before the merge** (a tester; macOS; no login, no network beyond `127.0.0.1`).
   - Build: `cd cli && npm ci && npm run bundle` (`cli/dist/cli.js` carries the marketplace with `hooks/start`).
   - Isolation: a scratch root in the scratchpad holds `HOME`, with `CLAUDE_CONFIG_DIR=$HOME/.claude` and Harness's
     data under that `HOME`. `PATH` holds only `$HOME/.local/bin`, Claude Code's folder, Node's folder, `/usr/bin` and
     `/bin` (no `orca`, no `codex`). Commands run under `env -i` with just those variables and `TMPDIR`.
     `$HOME/.local/bin/harness` is a wrapper, `exec node <checkout>/cli/dist/cli.js "$@"`. Never the tester's
     `~/.claude`, `~/.harness`, daemon, login or a production backend.
   - A local stub in the scratchpad listens on `127.0.0.1:<free port>`, records each request body, and answers
     `/v1/messages` with a minimal streamed reply. Claude Code runs with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`,
     `ANTHROPIC_API_KEY=<a dummy, not a real key>`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and
     `DISABLE_AUTOUPDATER=1`.
   - `harness device claude enable`. Expect exit 0, the plugin installed from `$HOME/.harness/claude-marketplace`,
     `$CLAUDE_CONFIG_DIR/skills/dial/SKILL.md` written, and the installed `hooks/start` executable.
   - `claude -p "hello" --max-turns 1` in a scratch folder. The stub's recorded request holds the line verbatim exactly
     once, and the saved transcript holds a `hook_additional_context` attachment with `hookEvent: "SessionStart"` and
     the line. `claude -p --resume <that id> "again"`: the request holds the line (the `resume` source).
   - Harness's own one-shots (decision 13): `claude -p "hello" --max-turns 1` run from the data folder's
     `voice-route-scratch`: the request has no line. The one-shot's own flags (`--print --safe-mode
     --disable-slash-commands --tools "" --no-session-persistence`) from a scratch folder outside the data folder: the
     request has no line, which confirms that `--safe-mode` turns the plugin's hooks off. Report both.
   - Replace the skill with the person's own (no marker line): a new session's request has no line. Put Harness's back,
     then `harness device claude disable`: a new session's request has no line.
   - **The hook's time at session start**, the number for the PR (code standard 4, cli/AGENTS.md 8): the installed
     `hooks/start` run with the wrapper and a `START_INPUT` on stdin, 10 times, start to exit. Report the median and
     maximum; each must be under 1 s. Before Part 4 a session ran no such hook.
   - If Claude Code refuses to run against the stub, stop and report. Do not reach for a real login.
2. **The real Codex, on this Mac, before the merge** (a tester; macOS; Codex 0.172.0 or later, its binary only).
   - Isolation as Part 7's Verification 1: its own `HOME` and `CODEX_HOME` in the scratchpad, signed out, a dummy
     `STUB_KEY`, the spike's stub provider in `config.toml` (`[model_providers.stub]`,
     `base_url = "http://127.0.0.1:<p>/v1"`, `wire_api = "responses"`, `env_key = "STUB_KEY"`) and the stub that records
     each request. The spike's stub and `hooks/list` reader come from the coordinator, or are written fresh in the
     scratchpad. The same `harness` wrapper is on `PATH`, with `codex` added.
   - `harness device codex enable`. Then `codex app-server` `hooks/list` shows three Harness Device hooks, all
     `trusted`, `session_start` among them.
   - `codex exec "hello"`: the stub's request holds the line verbatim as a developer message right before the user
     prompt. `codex exec resume --last "again"`: the line again.
   - Harness's own one-shots (decision 13): `codex exec "hello"` run from the data folder's `voice-route-scratch`: no
     line. Then `oneshot.ts`'s own flags (`exec --json --ephemeral --sandbox read-only --skip-git-repo-check
     --ignore-user-config --ignore-rules -`) from a scratch folder outside the data folder: report whether the request
     holds the line, which says whether `--ignore-user-config` alone keeps the hook out (the `cwd` rule does not rely on
     it).
   - `harness device codex disable`, then `codex exec "hello"`: no line.
3. **The `start` command's time, on this Mac, before the merge** (a tester; macOS; decision 11). In Verification 1's
   isolated `HOME`, with Verification 2's `CODEX_HOME`, both engines set so the command prints the line (the path that
   reads every file). A small Node script in the scratchpad runs the built CLI (`node cli/dist/cli.js device claude
   start`, then `device codex start`) 20 times each, one after another, with `START_INPUT` on stdin, timing each from
   spawn to exit with `process.hrtime.bigint()`, and prints the median and maximum per command. Each maximum must be
   under 1 s; the numbers go into the PR body. No hyperfine, no parallel runs.
4. **Linux:** `linux-e2e` above (Task 5, both engines, from the bundle). The hooks are the same POSIX scripts as on
   macOS, so no real-CLI run is needed there.
5. **Windows:** `windows-e2e` x64 above, selected by path (the hooks' PowerShell and Git Bash forms against a stand-in
   launcher). No Windows VM (decision 11): the PR body states that a real Claude Code or Codex session was not run on
   Windows, and the stated limit that Codex runs hooks through PowerShell there, about 1.5 s more per session start.
6. **The eval** (Task 9) is Claude Code's end-to-end measurement. It runs locally on this Mac, with no workflow, and
   **needs the user's own Claude Code sign-in** through the session profile. Isolation is the eval's own (its README):
   a temp repo per run, the fake `harness`, the curated `PATH`, `--setting-sources project`, Claude's sandbox, no
   backend.
7. **The person's own eye, after the release** (needs the user, with their own login and dial): a fresh session whose
   long turn ends on an ask, with the person in another app, rings the dial.

**Proposal, not built here:** Part 7's proposed scheduled check of the newest Codex release, which compares `hooks/list`'s
hashes with Harness's records, should cover `session_start` too. No such workflow exists.

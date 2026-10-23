# Swarm clone trust

## Approved brief

GOAL: a new Codex or Claude Code agent started by a Swarm on a contributed machine never stops at the engine's "Do you trust this directory?" screen. On 2026-10-22 two Codex agents on MacBookPro2021 sat on that screen and never got the Lead's work; only the machine owner could answer.

WHY: contributing a machine clones the project into the Harness data folder (cli/src/superTabs/contribution.ts:22, `join(core.dataDir, 'swarm-projects', tabId)`; projectFolder.ts:25), but nothing records engine trust for that clone. Trust is recorded only for folders Harness made empty (cli/src/engines/kit/folderTrust.ts, callers core/agents/create.ts:231/290, launches.ts), and its header forbids it for a clone "the person has not been asked about". Owner decision: clicking Add machine IS that answer for the Swarm's clone.

CHANGES:
1. When a machine is added or configured for a Swarm (prepareContribution), record trust for the Swarm's project clone(s) for Claude Code and Codex with the existing folderTrust/recordTrustIn (engine trust contracts, atomic write through symlinks, only ever adds). Also record it once for clones that already exist from earlier contributions (at the next host tick or contribution read). Only the Swarm's own clone folders, never any other folder of the owner. Update the folderTrust.ts header to name this one consented exception and why.
2. Make sure the agents' worktrees made from that clone are trusted too (check how Codex/Claude resolve trust for a git worktree; if a worktree does not inherit, record trust for the worktree folder the Swarm start creates, same rule).
3. New contributions clone into ~/harnesses/swarms/<tabId>/<projectId> (beside ~/harnesses/worktrees/, where owners already look) instead of the hidden data folder. Machines contributed before keep their existing clone path (moving it would break worktrees that use it); projectFolder.ts expectations must accept both roots.
4. Add machine dialog (desktop/lib/super_tabs/machines.dart) says plainly: "Harness clones each project into ~/harnesses/swarms and lets the Swarm's agents work in it."

NOT NOW: Harness answering engine screens on its own; a separate change will make the Swarm chat name the machine owner when an agent is blocked by an on-screen question.

CONSTRAINTS: never trust a folder outside the Swarm clone roots; never remove trust; Windows paths work (projectFolder.windows.spec.ts); old contributions untouched except the added trust. No new dependencies.

OWNS: cli/src/superTabs/contribution.ts, cli/src/superTabs/projectFolder.ts, cli/src/engines/kit/folderTrust.ts (header + any small export needed), the Swarm start's worktree trust if needed (cli/src/superTabs/start.ts), desktop/lib/super_tabs/machines.dart (dialog copy).

OWNER CLARIFICATION (2026-10-22): "machines are already added; Harness must fix access to ~/harnesses/swarms by itself". So machines contributed before this change get fixed automatically with no owner action: on the machine's next Swarm host tick after updating, record Claude and Codex trust for every existing Swarm clone it has (old data-folder path) and for the clones under ~/harnesses/swarms, and their agent worktrees. Re-Add or Configure must not be required. Existing clones still stay where they are.

Repo: github.com/autonomous-ai/openharness, branch from current origin/main. Read AGENTS.md, cli/AGENTS.md, docs/naming-system.md. Push a branch and open a DRAFT PR; do not mark ready, merge or release. Put this brief as docs/plans/2026-10-22-swarm-clone-trust.md in the PR. Tests never touch port 18473, ~/.harness, ~/.claude, ~/.codex, ~/harnesses or the real tmux (use a temp HOME). CLI on Node 24. Run and record in the PR: cli npm run typecheck, npm run test:super-tabs, npm run test:core if core files change, the folderTrust/launchPrep golden specs, projectFolder specs incl. windows; desktop flutter analyze + affected tests. Comments say why; no dead code.

Acceptance checks:
- CLI tests with a temp HOME: adding/configuring a machine records Claude and Codex trust for exactly the Swarm clone (and an earlier clone), nothing else; repeated runs say already
- A Swarm agent worktree from that clone is trusted by both engines (test or documented engine behaviour with evidence)
- New contributions clone under ~/harnesses/swarms/<tab>/<project>; existing contributions keep their path; projectFolder specs incl. Windows pass
- Add machine dialog shows the new sentence (desktop test); all listed suites pass; draft PR link with exact commands and results
- A machine contributed before the change gets its existing clone(s) trusted automatically on the next host tick, with no re-Add or Configure (test)

## Implementation plan

1. Reproduce missing trust and path behavior under a temporary HOME. Keep the existing engine trust contracts and atomic writers. Centralize the two authorized clone roots, validate physical clone containment, and add trust for Claude Code and Codex only for actual Swarm clones. Preserve stored legacy paths.
2. Wire idempotent repair into contribution preparation, project preparation and each contributed-machine poll (including pools with no pending starts). Inspect linked Git worktrees and trust only Swarm agent worktrees belonging to a verified clone. New worktrees inherit via the existing core launch preparation; no core behavior change is planned.
3. Add the exact Add machine sentence and a widget regression. Validate the narrow trust boundary, both roots, symlinks, existing files/config preservation, repeated runs, late configs, and Windows path separators.
4. Run Node24 typecheck, Super Tab coverage gate, all affected Super Tab specs, folderTrust and launchPrep golden specs, existing worktree launch trust specs, and Desktop analysis/affected tests. Run core coverage only if core source/tests change. Independent review before publication; push a branch and open a draft PR with exact results. No ready, merge or release.

## Validation scope

CLI source/toolchain: changed Super Tab modules and transitive engine trust, Git project and engine-home helpers; Node24.22.0, current lockfile, isolated temporary HOME/TMPDIR. No production daemon, real tmux or personal engine files. Existing launch preparation specs pin worktree inheritance. Desktop: machines.dart and its widget suite on installed Flutter/macOS. Use the named affected suites rather than the unrelated full CLI suite; the trust operation is restricted to the new consent path and changes no engine trust format or launch protocol.

## Review focus

- Legacy contributions repair on a tick with zero pending starts and no owner action.
- Symlink escape, malformed roots and another owner's repository never gain trust.
- Only the correct clone's Swarm worktrees inherit; unrelated linked worktrees remain unchanged.
- Missing/unreadable/malformed configs retain existing safe writer behavior; repeated repairs can retry.
- Windows mixed separators and old clone locations remain compatible.

## Review follow-ups

- Publish each machine observation before trust repair. Cache clone/worktree discovery, captured native
  locations and successful trust records in the host process for each contribution generation. A second
  successful tick must perform no Git discovery, login-shell capture or trust-config work. Failed settings
  retry against the retained paths/environment; a new generation or service process starts a fresh repair.
- Cache successful discovery separately from failed discovery so a temporary Git/filesystem failure
  retries without rescanning successful clones. Before retrying a failed settings write, verify the
  original physical directory and Git metadata identities; a replaced path must not inherit consent.
- Explicit contribution/project preparation still scans freshly so a new clone is trusted before launch.
- A backend-selected Codex home may select a config only when a locally registered Codex agent already
  uses that normalized path. Use the local row's path; an arbitrary backend path must never select a file
  such as the owner's Cargo config. Preserve known local profile support and automatic worktree repair.

### Machines freshness rebase and failure scheduling

- Rebase onto current main preserves the five-second start pickup and publishes readings only on
  change or each 15-second heartbeat. Trust repair stays after the publish block, outside its condition.
- Per-tab failed repairs wait 15, 30, 60, 120 and 240 seconds, capped at five minutes. Unavailable
  native login-shell capture therefore cannot delay pending starts on every five-second pass.
- Skipped engine configs (including a machine where the engine has never run) are checked every five
  minutes without creating a config. Successful engine/path records remain cached.
- A changed set of local Codex homes restarts discovery and scheduling, including any new worktree,
  while retaining completed trust records. An arbitrary backend-selected config remains refused.
- RED first: shell capture repeats at five seconds; missing config repeats lstat; a later local
  profile misses source/worktree trust. All three new regressions failed before these fixes.

### Later clones and migration isolation

- Refresh the two consented root folder listings on every periodic pass, including after an empty or
  fully settled repair. New folder names reopen repair while successful Git discovery and settings
  records stay cached; steady polls only reread the directory names and retain failure backoff.
- Do not cache a missing .git directory as permanent rejection: a clone can be observed before Git
  initialization completes. A changed pending path also drops that clone's discovery for a fresh check.
- Catch migration exceptions before start pickup and preserve backoff even when repair throws.
- A Codex table already present settles that path, including explicit untrusted. Preserve the person's
  decision and stop polling its config; missing/malformed settings retain the slow retry.
- RED first: four later-clone cases (empty/previously repaired, failed one-shot shell/config), an
  initializing clone, thrown repair and explicit untrusted retry. All seven regressions failed before
  implementation and pass afterward.
- Lead explicitly authorized marking #1531 ready after the final push so automatic CLI CI runs.

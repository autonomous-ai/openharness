# Project instructions: progress and handoff

Spec: `docs/plans/2026-10-30-project-instructions-design.md`. Plan: `docs/plans/2026-10-30-project-instructions-plan.md`.
Branch: `swarm-direct-messages` (one PR when every phase is done; Ken's call). This file replaces the git-ignored
ledger, so any machine can continue.

## Where it stands (2026-10-30)

| Phase | State |
|---|---|
| 1. Agents message each other directly | Done (6637c0f22; final review fixes in it) |
| 1b. Notice period | Dropped (Ken: a backend switch nobody turns on never runs; notices are ~3/hour) |
| 2. Backend: document, revisions, PM notes, role names, coordinatorName, migration script | Done (f1e80fef7..d769fa76e); independent review done, fixes eecdcdf0b..7c6fdf939, integration baseline-only |
| 3. CLI: two skills per agent, instructions command, neutral prompts | Done (bf23e61e0..d5aff9c87), every task reviewed; validation below |
| 4. Role kinds and routing enforcement removed (backend + CLI), plus phase 1's deferred minors | Done (76bdd8c92..005a6d0c7, 14 tasks) |
| 5. Desktop, web and phone | Done (1cd16aadb..9aafcb177, 10 tasks) |
| 6. Docs | Done (f66c79619, 662d7a08f, c34645ec1) |
| Final reviews | Whole-branch reviews of CLI, apps+docs and backend, each "ready with fixes"; fix waves 7eb1f2826..e73e91ed6; two independent security reviews (2 Medium, 5 Low) fixed in d36945ff4, a2053af01, 780f1a134 |

Phases 3, 4 and 5 must ship together (see the plan); 1 and 2 could ship alone.

## How to continue

1. Nothing is pushed. Open one PR from `swarm-direct-messages` only with the owner's go; never push to main, merge or release
   without Ken.
2. Release order: backend deploy → run the instructions migration in production (owner's go; a project still at revision 0 must
   not take a first save from an old CLI's rule.set before it) → CLI release → Desktop and phone.
3. Release notes: an older CLI on another machine installs the built-in dev text for non-coordinator agents a new CLI starts; a CLI
   downgraded after this release relaunches Swarm sessions without their skill (registry rows are rewritten in the new role shape);
   after a backend rollback, routes from a new CLI can pick what the old backend's rules refuse.
4. Checks PR CI does not run, already run locally (see Ledger "Validation"): backend integration suite, CLI test:core, Desktop and
   phone Swarm test sets.

## Brief for every phase

Branch `swarm-direct-messages`; work in a checkout or worktree of it.
Spec (binding): docs/plans/2026-10-30-project-instructions-design.md. Plan: docs/plans/2026-10-30-project-instructions-plan.md.
Ledger: this file (docs/plans/2026-10-30-project-instructions-progress.md) — read it first (rulings from earlier phases bind you); append your own lines.

Rules:
- Before coding, replace your phase's outline in the plan file with a task-level plan (files, interfaces, test names and assertions, commands), in the plan's existing style. Keep it proportionate.
- TDD for every behavior change: write the failing test, run it and see it fail for the right reason, implement, see it pass.
- Match the surrounding code: comment density, naming, idiom; comments say why, naming the incident or decision.
- Decide conflicts yourself with the spec as authority; ledger each as `Phase N: Ruling: <what> — <why> — <cost if wrong>`. Stop and report only for something destructive or outside this worktree.
- Commit on the branch after each task (git add the exact files; never `git add -A`; never commit .superpowers). Commit messages end with:
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Never push, never open a PR, never merge, never release, never touch prod data.
- Never use bare `git stash`; never run `dart format lib`/`dart format test` (format only files you changed); never `git clean`.
- Backend tests: `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= npx vitest run <files>`; run `npx prisma generate` after schema changes, then `npx tsc --noEmit -p .`.
  Integration: same env, `npx vitest run --config vitest.super-tabs.config.ts` (takes ~10 min; redirect to a log in the workspace). The origin/main baseline has 25 known failures listed in the list at the end of this file; compare with `comm` — no new failures allowed except tests you deliberately changed (ledger them).
- CLI tests: `cd cli && npx vitest run <files>`; `npx tsc --noEmit -p .`; run `npm run test:core` only if you change src/core or src/services (100% per-file coverage gate).
- Desktop: `cd desktop && flutter test <files>`; `flutter analyze <changed files>`.
- Phone: find the Flutter app under mobile/; same commands there.
- Old clients must keep working (spec Design: Compatibility).
- At the end: append `Phase N: complete (commits <first>..<last>, tests: <commands> → <results>)` to the ledger, and reply with a short report: what changed, test results, rulings, anything left undone. Do not claim success without the command output.

## Ledger (rulings and results, in order)

Scope: Phase 1, Tasks 1-5. Branch swarm-direct-messages from origin/main 16f2304d6. No commits (Ken: no commit until asked); tasks are recorded by tests, not commit ranges.
Pre-flight: T2 consumes T1 recipient rules (memberToLead only when recipientIds empty; joining recipients) — consistent. T3 consumes CommandContext.recent (+createdAt) and toLead from terminal.ts — check toLead signature at T3. T5 consumes T4 --to flag — consistent.
Task 1: Ruling: the plan's Task 1 test asserts no copy to the Lead for named messages, which is Task 2's change — kept the assertion; Task 1 is verified green together with Task 2 — cost if wrong: none, both ship together.
Task 2: Ruling: native.ts per-turn copies to the Lead NOT removed in phase 1 — the 24h count showed 0 such deliveries to the PM, while removing them rewrites the team-account identity and withheld-delivery tests (superTabTeam 235, superTabLiveness 1456, superTabs 1137) whose subject is security — cost if wrong: the PM still hears a person's hand-typed terminal turns, which are rare; can be done in phase 4.
Task 1: complete (no commit; tests: backend vitest src/superTabs/commands.test.ts → 288/288; RED seen: FORBIDDEN/INVALID_RECIPIENT)
Task 2: complete (no commit; tests: commands.test.ts 288/288; integration superTabLiveness moved-task test updated → pass; RED seen: recipients [worker, lead])
Task 2: Ruling: integration test 'messages from an agent whose task moved' named an agent of another task of the SAME project as the outsider — under the spec that agent now joins; the test now names an agent of ANOTHER project for the refusal and checks the same-project agent is delivered — cost if wrong: none, spec states it.
Task 3: complete (no commit; tests: commands.test.ts 288/288 incl. loop notice; RED seen: no notice; tsc clean after prisma generate)
Task 4: complete (no commit; tests: cli src/superTabs/command.spec.ts + service.spec.ts → 139/139; RED seen: usage error on --to)
Task 4: Ruling: service.spec 'offers --mention in help' asserted the old usage string — updated to the new usage with --to — cost if wrong: none.
Task 5: complete (no commit; tests: cli src/lib/swarmSkills.spec.ts 73/73, cli src/superTabs + skills 1605/1606 (1 skipped), desktop super_tab_project_skills_test 12/12; RED seen on the CLI skill test)
Task 5: Ruling: the plan's inline edits to existing skill lines broke the owner-approved byte-for-byte texts; instead each role gets one new section "## Who a post reaches" right before Reactions, removed in the byte-for-byte comparison like the other added sections — cost if wrong: guidance sits in its own section rather than next to review findings.
Task 5: Ruling: Desktop copy test was not run RED before syncing roles_editor.dart (it would have failed once the CLI text changed) — cost if wrong: none, it compares the two sources directly.
Validation: test:core not run — no file under cli/src/core or cli/src/services changed. Integration baseline on origin/main 16f2304d6 (this branch's base) has 25 failing tests in superTabBuddies, superTabBuddyProbes, superTabLiveness, superTabTidy, superTabs (routing/route-decision and start-timeout tests), unrelated to this change; the only new failure was the test updated in Task 2.
Validation: integration vitest.super-tabs.config.ts final → 845 passed, 25 failed; failing set identical to the origin/main baseline (comm: no new, none fixed).
Final review: opus reviewer, verdict "With fixes" (Important 1-4).
Final: fixed loop notice repeating every 20 messages — 'does not count its own loop notice as a break' RED→GREEN (notice source kind pair-loop, skipped by pairLoop; store reads source), suite commands+touches 300/300
Final: fixed a post naming only its sender reaching no one — 'treats a post that names only its sender as unnamed' RED→GREEN (memberToLead and default addressee use the filtered list), suite 300/300
Final: fixed joining recipients not touched for concurrency (D3) — touches.test 'touches an agent a post names from outside its group' RED→GREEN, suite 300/300
Final: fixed (Important 4, ruled scope) a Reviewer named or posting into a review group bypassing review rules, and agents joining the project chat for good — 'leaves joining a review to the review rules and the project chat to people' RED→GREEN; joinsProject refuses both, suite 300/300
Final: Ruling: other permanence effects of joining (Ready-for-review wakes to Reviewers in a Builder's group, tidy keeping a joined agent awake while its task is open, membership kept until archive) stay in phase 1 — an agent in an open task is never idle per the spec, and role-kind behavior is removed in phase 4 — cost if wrong: an agent consulted once stays in that task's wake list until it closes.
Final: minor (deferred): message.react joins the group via postable (a reaction in another task adds membership).
Final: minor (deferred): the loop notice does not use leadNoticeRows/forRecipients, so when the Lead is not in the group people may see it twice.
Final: minor (deferred): a person naming an agent outside the group now makes it join (spec says a person's message is unchanged).
Final: minor (deferred): joinsProject accepts agents marked stop (conversation.agent refuses STOP_REQUESTED).
Final: minor (deferred): "Who may post…" doc comment now sits above joinsProject instead of postable.
Final: minor (deferred): Lead skill line "names no one reaches its assigned agent" overstates (not after leadWorkerBounced or a reply to someone else).
Final: minor (deferred): no test for posting into a private chat or Buddy chat the agent is not in; no test that reacting joins.
Validation after fixes: integration 845 passed, 25 failed = origin/main baseline set (no new). Workspace kept (not deleted): nothing is committed yet, so the ledger is the only record of rulings until Ken commits.
Commit: phase 1 = 6637c0f22
Ruling (Ken): phase 1b notice period dropped from spec and plan — server notices ~3/h, a period only adds delay; commit 49a277712
Phase 2: plan written (plan file, "Phase 2" section replaced with Tasks 1-7); commit f1e80fef7 carries it.
Phase 2: Task 1 complete (f1e80fef7; tests: instructions.test.ts 2/2; RED seen: module missing)
Phase 2: Ruling: roleNameOf reads a custom role set's role name before PM/Reviewer/Engineer, and a Buddy as "Buddy" — spec Migration says "its custom role's name, else PM, Engineer or Reviewer"; a Buddy read as "Engineer" would be wrong — cost if wrong: a custom-set coordinator shows its custom name instead of PM.
Phase 2: Ruling: fixed phase 1's unclassified notice kind 'pair-loop' (notices.test failed) as 'recipients', like the other coordinator notices — cost if wrong: people no longer see the loop notice in the task chat (commit 90a13c380).
Phase 2: Task 2 complete (92fc3d79e; tests: instructions.test.ts 7/7, errorHandler.test 9/9, integration superTabInstructions 3/3; RED seen: ZodError unknown command, missing details)
Phase 2: Ruling: a save of the same text is a no-op (result unchanged: true, no revision, no chat line) — a second identical line would be noise — cost if wrong: a client expecting a new revision must read `unchanged`.
Phase 2: Ruling: the refusal carries details through SuperTabError.details → errorHandler error body ({ code, message, revision, text }) — the only way a command route can hand back the text to merge — cost if wrong: none for old clients, they read code/message.
Phase 2: Ruling: a new Swarm's first project (store.create) also starts at revision 1, besides project.create; lead.start creates no project — cost if wrong: none.
Phase 2: Task 3 complete (b1b21fbbc; tests: instructions.test.ts 10/10, integration superTabInstructions 4/4; RED seen: ZodError unknown note commands; integration RED found the null-expiry bug below)
Phase 2: Ruling: notes live in their own collection (SuperTabPmNote), not in the project's state; the state carries `notesRevision` and the instructions read returns the live notes — the head part is read on every head change by every client, and 100 x 300 chars would ride on each; expiry is by time, which a state read cannot drop without a write — cost if wrong: phase 5 reads notes with the document (one read it makes anyway).
Phase 2: Ruling: expired notes are deleted on the project's next note write (lazy), with a `gt: Date(0)` bound because Prisma's Mongo filter sorted null below every date and deleted lasting notes (seen in the integration test) — cost if wrong: an expired note's row stays until the next note write; it is never read.
Phase 2: Task 4 complete (1b84475bd; tests: instructions.test.ts 12/12, read/views.test 14/14, integration superTabInstructions 5/5; RED seen: ZodError roleName/project.coordinatorName, derived roleName undefined)
Phase 2: Ruling: the effective role name is in `derived.agents[id].roleName` (and host rows), the stored one also in the agent part — who leads a project and its role set live in other parts, so a default kept in the agent part would go stale — cost if wrong: none; clients read derived.
Phase 2: Ruling: project.coordinatorName is the coordinator's or the project owner's (manageProject), and posts no chat line — spec: "settable by the coordinator or a person who can manage the project" — cost if wrong: a rename goes unannounced.
Phase 2: Ruling: views.test 'keeps time-based agent values out of the part' now expects derived roleName 'Engineer' — the derived shape gained a field — cost if wrong: none.
Phase 2: Task 5 complete (4f94c79ea; tests: integration superTabInstructions 7/7, src/routes + hotFilters 506/506; RED seen: route 404)
Phase 2: Ruling: a Buddy reads the current text but not the notes nor the history (NOT_FOUND) — spec: Buddies read the document; notes and history name who asked for what — cost if wrong: a Buddy cannot repeat a coordinator's note to its member.
Phase 2: Ruling: a project without a document (revision 0) reads the built-in template with `template: true`, so phase 3's CLI takes the text from the backend alone — cost if wrong: none.
Phase 2: Task 6 complete (eb8c28e4a; tests: migration/instructions.test.ts 3/3, integration superTabInstructions 8/8 incl. dry run, apply, apply again, save-then-rerun; RED seen: module missing)
Phase 2: Ruling: the migration never cuts a document for length, though the spec says an oversized one "keeps its rules' text and links the rest to an archived revision" — the brief (and anti-goal "nothing is dropped") says never drop; an oversized document is stored whole and the next save must fit 64 KB — cost if wrong: a team with >64 KB of role texts must trim before its first save.
Phase 2: Ruling: the migration's revision 1 is writtenBy { kind: 'system', id: 'migration' }, askedBy the project owner — it is nobody's edit, and Identity forbids the machine owner's login — cost if wrong: phase 5 must show 'system' authors.
Phase 2: Ruling: the migration is a script (scripts/swarm-instructions/migrate.ts), not a worker job like dropLegacyJob — the brief asks for a script runnable against a database URL; a failed Swarm (head changed meanwhile) is listed and the next run takes it — cost if wrong: someone must run it after deploy.
Phase 2: Ruling: agents' role names are not written by the migration — the read default (roleNameOf) gives the same names without a write — cost if wrong: none.
Phase 2: Task 7 complete (e128d9d2d; docs/swarms.md "Instructions" with the Design checklist)
Phase 2: self-review fix d769fa76e: a stale save on a project at revision 0 hands back the template text; a Buddy's save is BUDDY_FORBIDDEN (unit RED→GREEN)
Phase 2: Validation: integration vitest.super-tabs.config.ts → 853 passed, 25 failed (38 files, +8 tests in the new superTabInstructions file); failing set identical to the baseline (comm: no new, none fixed; log integration-phase2.log, list fail-phase2.txt). Run was on eb8c28e4a+docs; d769fa76e changed only the pure stale-text branch, covered by unit tests.
Phase 2: complete (commits f1e80fef7..d769fa76e, tests: backend `npx vitest run` → 3513 passed, 16 skipped (220 files); `npx tsc --noEmit -p .` clean after prisma generate; integration 853/878 with the 25 baseline failures only)

## Integration baseline failures on origin/main 16f2304d6 (25)

```
 FAIL  integration/superTabBuddies.test.ts > a Buddy through the store > reads no routing: no route rows in its task's messages, no routing decisions, no routing policy (security review 2 of #2115)
 FAIL  integration/superTabBuddyProbes.test.ts > a Buddy and threads > reads the replies to a route row as people wrote them, never the route row, its id or its thread line
 FAIL  integration/superTabBuddyProbes.test.ts > security review 1 of #2115: a Buddy's reads, probed by two people > keeps routing history and route rows from another person's Buddy
 FAIL  integration/superTabLiveness.test.ts > a Ready for review while no Reviewer of another engine can start > saves the hand-over and tells the project chat once, through the store's write
 FAIL  integration/superTabLiveness.test.ts > a start that never runs > fails 3 minutes after dispatch, naming its machine to its Lead only, and tells the Lead in its group
 FAIL  integration/superTabLiveness.test.ts > a start that never runs > is not failed by another machine's report that read its machine silent while that machine reported it preparing
 FAIL  integration/superTabLiveness.test.ts > a start that never runs > is not failed by the Lead's poll that read its machine silent while that machine reported it preparing
 FAIL  integration/superTabLiveness.test.ts > a start that never runs > waits while its own machine reports it preparing, shows the Lead it is preparing, and fails it after 15 minutes
 FAIL  integration/superTabLiveness.test.ts > a task that stalls > is orphaned when a machine's report times its launched start out, and stays so once the start has ended
 FAIL  integration/superTabLiveness.test.ts > a task that stalls > is orphaned when its start fails, the Lead woken once by the failure notice, and stays so once the start is no longer loaded
 FAIL  integration/superTabLiveness.test.ts > a task that stalls > waits queued while its start is not launched, and is orphaned 10 minutes after it was asked for, waking the Lead once
 FAIL  integration/superTabLiveness.test.ts > an agent whose task was lost > takes the Lead's explicit assignment with a reason, while the mark that keeps routing away from it stays
 FAIL  integration/superTabTidy.test.ts > a review the Swarm opens by itself > opens on a Ready for review with a project pull request, reaches its free Reviewer, and the Lead can cancel and archive it
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > closes a linked decision with the assignment outcome
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > corrects the log to the model that ran when the routed switch failed, and reads the times of one decision
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > keeps a decision open when the Lead stops its work to hand over to the candidate a person chose
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > records more than 30 routes in an hour: there is no hourly cap
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > records, supersedes and lets a person change a route decision; a closed one refuses
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > releases a queued start's route hold when that start fails
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > releases a started agent's route hold when the host stops it before assignment
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > releases every queued route hold when its machine leaves because its owner leaves the Swarm
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > releases every queued route hold when its machine leaves because its owner removes it
 FAIL  integration/superTabs.test.ts > Super Tabs on a real Mongo replica set > returns the receipt of a recorded agent start after its machine stops being listed
 FAIL  integration/superTabs.test.ts > Swarm parts under concurrent writes > assigns the routed agent through its finished start, without an override reason
 FAIL  integration/superTabs.test.ts > Swarm sweeps > drops finished starts and expired invitations after their time, and creates the purge index
```
Handoff (2026-10-30, Mac Studio): worktree /Users/mac/harnesses/worktrees/openharness/swarm-direct-messages on ebf7b329a; baseline backend `npx vitest run src/superTabs src/middlewares src/routes` → 1904 passed, 5 skipped; tsc clean. Phase 2 independent review started.
Phase 3: plan written (plan file, "Phase 3" section replaced with Tasks 1-6).
Phase 3: Ruling: saved and wire role values stay lead/dev/review/buddy and modes default/orchestration — a start's agent_create reaches other machines' CLIs, which refuse unknown values (launches.ts INVALID_SWARM_ROLE), and saved rows relaunch; the kind now only picks the old-backend fallback text — cost if wrong: the rename to coordinator|agent moves to phase 4 with the kinds.
Phase 3: Ruling: today's role texts and Desktop's copies stay unchanged — they are the new CLI's text on an old backend and what running agents hold until the host moves them — cost if wrong: none; phase 5 removes the Desktop copies.
Phase 3: Ruling: the host, not the launch, writes swarm-instructions — the core reads nothing from the backend at launch; the launch line sends the agent to the instructions command, which prints the same text — cost if wrong: the file appears at the host's next pass (seconds) after the agent already read the text.
Phase 2 review fix: a Buddy whose person lost a private project no longer reads its instructions (store.instructions checks its person via the new projects.ts buddyPerson, shared with readsRecordsIn) — integration superTabInstructions 'reads nothing to a Buddy whose person lost the private project' RED (200, expected 404) →GREEN (eecdcdf0b)
Phase 2 review fix: the migration script prints no document's text (printableReport; --text TAB_ID shows one Swarm's), docs/swarms.md names DATABASE_URL and --text — migration/instructions.test 'leaves every document's text out' RED (printableReport is not a function) →GREEN (4ae6dc12c)
Phase 2 review fix: a person's save with askedBy naming someone else names them in the chat line ("owner changed the instructions for peer: …") — instructions.test 'names in the chat line the member a person saved for' RED (no "for peer") →GREEN (54a0876ab)
Phase 2 review fix: instructions.save, note.add, note.remove and project.coordinatorName take the lead check (touch the Lead conversation) like project.report — touches.test 'makes the coordinator's instructions save, notes and name meet a Lead change' RED (instructions.save: false) →GREEN (ec51f9b24)
Phase 2 review fix: a new Swarm's first revision is stamped with the store's clock, not Date.now() — integration superTabInstructions 'starts … on revision 1 … at the store's time' RED (at = machine time) →GREEN (7c6fdf939)
Phase 2 review fixes validated: backend `npx vitest run src/superTabs src/middlewares src/routes` → 1907 passed, 5 skipped (baseline 1904 + 3 new); `npx tsc --noEmit -p .` clean; integration superTabInstructions 9/9 (whole integration suite not rerun, per the brief for these fixes). The script itself (outside tsconfig's include) typechecks clean with a scratch config.
Phase 2 review fixes: Validation: integration vitest.super-tabs.config.ts on 214f4a5ba → 854 passed, 25 failed (879); failing set identical to the baseline (comm: no new, none fixed); unit src/superTabs src/middlewares src/routes → 1907 passed, 5 skipped; tsc clean.
Phase 3: Ruling: the task-level work ran with subagents in parallel where files did not overlap (tasks 3/5/6 together; reviews beside the next task) — the user asked for all phases without stopping — cost if wrong: index.lock retries.
Phase 3: Ruling: tool skill documents roleName on agent.start as optional; an older Swarm refuses the key (start again without it) — the launch writes the tools skill on old backends too — cost if wrong: one refused start, retried.
Phase 3: Ruling: harness super-tab instructions maps to INSTRUCTIONS_UNAVAILABLE only a 404 without the backend's own code (route missing); the backend's NOT_FOUND and its 503 INSTRUCTIONS_UNAVAILABLE pass through — cost if wrong: a raw 404 on an old backend.
Phase 3: Ruling: a first install after a new launch is told only when the revision is 0 or was saved at or before the launch (ProjectDoc.savedAt from the revisions read vs the launch tools record mtime); otherwise one notice — closes the old-backend-at-launch and save-before-first-install gaps (task 3 review) — cost if wrong: one extra notice, or none in the rare no-project-at-launch case.
Phase 3: Ruling: a Buddy on an instructions row still gets its swarm-buddy text refreshed (task 4 review); a failed history read is retried, capped at 5 minutes — cost if wrong: none.
Phase 3: Validation: cli vitest src/superTabs src/lib src/core/agents → 12798 passed, 6 failed in nativeProcessControl/registry/sessionRepair (files untouched by the branch, known on this Mac); tsc clean; test:core 3168 passed (exit 1 only on baseline coverage thresholds in src/core/transcripts); Desktop launch prompt tests 44 passed.
Phase 4: plan written (d7abb60fc, 14 tasks, 23 decisions adopted as written). Phase 5: plan written (0208c10f3, 10 tasks, 17 decisions adopted).
Phase 4: Ruling: decision 4 (persons keep their current checks) wins over decision 6's "or a person": a person resumes or fails only their own start — cost if wrong: a person cannot finish a teammate's stuck start.
Process: after phase 3 the user asked to drop per-task reviews for speed; remaining tasks ran in parallel file lanes, then whole-branch reviews by area, fix waves, two independent security reviews and a security fix wave.
Validation: backend unit 1887 passed, 5 skipped; tsc clean; backend integration (security-fix run) 880/882 — the one remaining original baseline failure (superTabLiveness lost-task assignment) plus a test moved out of the project chat (215/215 alone); 24 of the 25 original baseline failures now pass (phase 4 removed the floors behind them).
Validation: cli vitest src/superTabs src/lib src/core/agents 12790 passed, failures only in registry lock x3, sessionRepair x2 (known on this Mac), stoppedAgents and nativeProcessControl (load; pass alone); tsc clean; test:core 3171/3171 (exit 1 only on coverage thresholds in files the branch does not touch); scheduler python 40 OK (OR-Tools absent).
Validation: Desktop super_tab/settings/swarm sets +2277 -3 (two load failures pass alone; super_tab_attachment_fetch_test "stops reading past the limit" fails alone too — test and code untouched, real-socket timing in this sandbox, not checked on a clean base); phone test/swarm +1413 -1 (load failure, passes alone); check-ui-style passes; copy pairs identical.
Final: Ruling: plan floors by difficulty (low 1, medium 2, high 3) as advice, too-small models left out, so plan and route agree — cost if wrong: pricier picks.
Final: Ruling: old Desktop routing saves get IGNORED_NOTE in the routing-policy read warnings; skill-set and role saves stay accepted and silent — cost if wrong: an old Desktop user edits roles that do nothing until they update.
Final: Ruling: security — an agent drives a terminal only as far as the person whose machine runs it could; agents cannot agent.add sessions; project chat work is coordinator-or-person; Team sessions settle starts only on their machine; route.modelResult needs the start maker or coordinator; person-added sessions released only by the coordinator or a person — cost if wrong: some agent actions are narrower than "any agent of the project".
Final: Ruling (for Ken): migrated custom role texts become readable by every project reader and their Buddies; any agent can write into a member's Buddy chat with person.tell (the Buddy allowlist blocks exfiltration) — accepted as the spec's design.
Security re-review open items fixed in 2fdb7785d (work.cancel in the project chat is coordinator-or-person; agent.add finds a rebound session by machine and current harness). Final validation: backend unit 1889 passed; tsc clean; full integration 881/882 — only the remaining original baseline failure (superTabLiveness lost-task assignment).
Coordinator terminal power restored: df8c3976b (RED→GREEN; unit 1890 pass; tsc clean; 5 terminal integration files 399/400, baseline only).

# An ask is owned until the person has it (2026-11-07)

No requester: the PM's design answer to anh Dee's "how do we design you right?" (11-07 12:59), task #4429. Spec only;
the build tasks at the end each get their own task and pull request.

## What went wrong on 11-07

Anh Dee's visible asks sat unshipped for six hours. Three causes:

1. **Nobody owns an ask until it reaches the person.** The builder stops at Done and leaves; the Integrator owns the
   merge; the release step goes to whoever is the Integrator then. An ask falls into the gaps between them, and each
   gap looks like someone else's.
2. **Desktop ships in big batches tied together by dependencies.** One late pull request, or a Desktop change waiting
   on its backend part, holds every other ask in the same release.
3. **The PM spends its time on mechanical notices** (stale red checks, OS test steps, idle agents, waits) instead of on
   asks. The asks are in its inbox too, under the noise.

## How it works today (main 05d2b1e3a)

- An Engineer marks its pull request ready and is free at once ("handed", `handed.ts`, #3399). Red CI or a conflict
  brings the task back to it; if it is down or slow for 60 minutes, anyone free in the lane takes it.
- The Integrator opens the review and test steps' follow-ups, builds merge batches, and takes release steps
  (instructions, Roles › Integrator). The merge train (`mergeTrain/`, #3402) merges approved pull requests in batches
  every 10 minutes and rebuilds a batch when main moves (#4379).
- The release list (`releases.ts`, #3405) opens a release step for the Integrator: Desktop, CLI and web right after a
  visible merge, the backend at most every 2 hours and never 09:00–10:00, all inside 09:00–18:00 Vietnam time. A
  verified release marks the tasks it carries Shipped, and the requester's Buddy says so (`buddyNews.ts`).
- The PM gets the Swarm's notices in a 5-minute digest (`noticeDigest.ts`: stalled, lost, resumed, idle, review failed,
  review capacity, overlap, Done rows) and stuck alerts at once (`stuck.ts`, #3915: red checks at head, a lost step, a
  down agent), beside people's messages in its inbox (`inbox.ts`, #3403).
- The Board (#3812, #3827) shows six columns, Done's waiting-to-merge time and Merged's next release time. Nothing shows
  when the person asked or when they should have it.
- Anh Dee's rule (11-07): his and his Buddy's asks merge before crew or test work, and a Desktop release goes out within
  2 hours of any of them merging.

## Words

Added to [the Naming System](../naming-system.md) by the first build task:

| Word | Meaning |
|---|---|
| **Ask** | A task a person asked for: its requester is a person (directly or through their Buddy) and the PM accepted it. Work the crew opened with no requester is not an ask. |
| **Owner** | The one agent that carries an ask from accepted to the person's app. |
| **Due** | When the person should have the ask. |
| **Late** | Past due and not yet with the person. |
| **With you** | The person's own app runs a release that carries the ask. The last stage. |

## What changes, in one view

| | Today | After |
|---|---|---|
| Who carries an ask after review | Nobody in particular: Engineer leaves, Integrator merges, Integrator releases | Its owner, the same agent from accepted to released |
| How an ask merges | In a batch with others, on the next 10-minute pass | On its own, on the pass its pull request turns eligible |
| Desktop release | After a visible merge, carrying whatever batch merged, by the Integrator | After every ask merges, by that ask's owner; one building at a time |
| An ask with backend and Desktop parts | Parts merge and release in any order; Desktop can wait on the backend's 2-hour pace | The owner merges the backend part first; its release opens at once; then the Desktop part merges |
| The PM's inbox | People, crew needs, notices, stuck alerts | New asks, decisions, and late |
| An ask's card | Column and one mark | Asked at, where it is now and since when, due |
| When an ask is late | Nobody is told | The PM and the person are told once |

## 1. One owner per ask

- The Engineer the PM assigns to an ask is its owner. It stays the owner until the ask is with the person. It hands
  nothing off: no Integrator, no second Engineer, no release agent.
- **It stays on the ask.** Marking its pull request ready does not free it ("handed" does not apply to an ask). Between
  events it waits without spending quota, and the server wakes it on each one: a verdict, a CI result, a conflict, main
  moving, its merge, its release step, a verified release, late.
- **It does everything after review itself:**
  - merges main into its branch when the train says it conflicts or main moved under a passed review, and asks the same
    Reviewer to confirm the moved head;
  - keeps its receipts on the task: the local-check receipts in the pull request body for the exact head, the review and
    test verdicts at that head, the merge commit, the release's `--wait` receipt and the version it shipped in;
  - starts `make release-desktop ARGS="--prepare"` on its branch when it marks the pull request ready, so the release can
    reuse that build, but never from a branch that changes `.github/` or the release scripts, and never for Team-written
    work (Design 8); such an ask's release builds from main as usual;
  - takes the release step the server opened for its ask (section 2) and runs it from a checkout of main, at a commit
    that holds its merge with `ci/required` green; it has no right to release outside that step (Design 8);
  - sets the task done only when the release carrying it is verified, with the version and the receipts as evidence.
- **After it ships** the owner is free for new work, but stays named on the ask until the person has it. If the person
  says on the card that it does not work, the ask returns to that owner if it is still running; otherwise to a new one.
- **Several pull requests in one ask** (a backend part and a Desktop part) are all the owner's. It merges the backend part
  first; the Desktop part merges once the backend release carrying it is verified. The order is kept by the ask, never
  by the shared release.
- **If the owner is lost** (its machine goes offline, its session closes, its account runs out of quota), the server gives
  the ask to a free agent in its lane at once, as lost work is given today. The new owner reads everything from the
  task's receipts. This is the only handover, and it is counted.
- **Crew work is unchanged:** a task with no requester keeps today's flow (handed on ready, Integrator, batches).

## 2. Desktop ships per ask

- **A release opens whenever an ask merges.** When an ask's pull request with a Desktop part merges, the Swarm opens the
  Desktop release step at once, inside the release window, for that ask's owner. The release carries main as it is; it
  never waits for another pull request.
- **One building at a time.** A project has at most one Desktop release building. Asks that merge while it builds wait
  for the next one, which opens as soon as the building one is verified and carries every ask merged since. Its step
  goes to the owner of the oldest ask it carries; owners of the other asks it carries wait on it and do not cut another.
  So asks never queue behind more than one release.
- **Backend parts go first, automatically.** An ask's backend release opens as soon as its backend part merges. The
  2-hour backend pace applies only to backend releases that carry no ask. The 09:00–10:00 backend pause stays.
- **Nothing waits on a dependency at release time.** Main is releasable after every merge: a Desktop change works with
  the backend it may meet (AGENTS.md, compatibility), and the owner holds its own Desktop part until its backend is out.
  A late pull request holds only its own ask.
- **Small and frequent.** Most releases carry one or two asks. The `--prepare` build started on the ask's branch is reused
  when main's Desktop inputs still match at release time (docs/validation-and-release.md), which small releases make
  more likely.
- **Unchanged:** the release window (09:00–18:00 Vietnam time; an ask merged after 18:00 goes at 09:00), the urgent override
  for a P0, the verified-release rule for Shipped, CLI and web releasing after a visible merge, and the phone's own
  release flow.

## 3. The PM's inbox: new asks, decisions, late

The Swarm settles mechanical conditions itself, and writes one line about each on the task's own card, so every
failure is still seen by someone who can act. The PM's inbox keeps three sections:

1. **New asks:** people's messages and proposals it has not decided.
2. **Decisions:** questions asked of the PM by name, and a person disagreeing with a decision.
3. **Late:** asks past due, and crew tasks stuck 30 minutes with nobody able to act.

What leaves the PM's inbox and who settles it instead:

| Condition | Settled by | The PM sees |
|---|---|---|
| CI red at the head | the PR watch gives it back to the owner (or the crew task's Engineer), as today | nothing, unless it makes the ask late |
| A red check from an older head | ignored: only the head counts | nothing |
| A recorded flaky check fails | the server reruns it once | nothing; a second failure goes to the owner |
| A merge conflict, or main moved under a batch | the train tells the owner, who merges main | nothing |
| A step for an OS with no machine of that OS free | the step waits and says so on its card (#3926) | late only |
| A lost agent or a failed start | the server gives the work to a free agent in its lane | late only, when none is free for 10 minutes |
| An idle agent | the crew keep and stop rules | nothing |
| Waits: CI running, review running, a release building, the next train pass | nothing to settle | nothing |
| A release due | the release list opens the step for the owner (or the Integrator for crew work) | nothing |
| A Done row, a review result | the Board shows it | nothing |

The people on a task still hear when it is stuck, as today (#3915, Tony's 11-06 report); only the PM stops getting it.

## 4. The Board shows each ask's times

- Each ask's card gets one quiet line in the card's existing caption: **asked at**, **now at** (its stage and since when)
  and **due**, in the reader's local time:

  ```
  +--------------------------------------------+
  | [Desk] Composer keeps a draft              |
  | asked 10:12 · in review 11:40 · due 14:00  |
  +--------------------------------------------+
  ```

- **Asked at** is when the person first asked: their message or their Buddy's proposal, not when the task was made.
- **Now at** is one of: proposal, accepted, building, in review, merging, releasing, shipped, with you. It moves through
  Ken's six columns: proposal → Proposal; accepted → Next up; building and in review → Working; merging → Done;
  releasing → Merged; shipped and with you → Shipped.
- **Due** is set by the PM when it accepts: its estimate from the ask's real steps, with no padding. When it gives none,
  due is 4 release-window hours after asked at: 2 to merge (the product target) and 2 to release (anh Dee's 11-07 rule).
  Only release-window hours count, since nothing reaches a person outside it except a P0, which counts every hour.
- **Late:** when due passes and the ask is not with the person, the due turns to a warning ("late 25 min"), and three
  things happen once:
  - one line on the card saying where it is and why (its stage's mark: CI red, waiting on a person, a release building);
  - the ask goes in the PM's Late section;
  - the person's Buddy tells them in one line, with where it is.

  The owner gives a new due with its reason; the Buddy passes it on. Passing the new due flags it again, once.
- **With you** comes from the person's own app: Desktop says its version on every request it makes, as the CLI does, and
  the server records the newest Desktop version each person runs. An ask is with you when that version carries its
  Desktop part; a CLI part when one of the person's machines runs a CLI that carries it; a backend or web part when its
  release is verified. Until then, its card in Shipped says "Update to 1.3.90".
- Late is not something the person must act on, so it never enters their Needs you bar.

## What this changes in Ken's Buddy/Board spec (2026-11-06)

[docs/plans/2026-11-06-buddy-board-final-spec.md](../plans/2026-11-06-buddy-board-final-spec.md) stays the base. This
spec changes it in six places:

1. **The Buddy's three moments become four:** decided, needs you, **late**, shipped. The shipped line names the version to
   update to.
2. **The PM's inputs** ("proposals, answers on proposals, and the Swarm's notices") narrow: of the Swarm's notices, the PM
   gets only late ones.
3. **The Failure line** ("a proposal the PM has not answered within the project's limit is shown as late") covers every
   stage of an ask, through its due.
4. **Done's waiting-to-merge warning past 1 hour** stays for crew work. An ask stays in Done for minutes, because it
   merges on its own, and past due it shows late instead.
5. **Merged's "when the next release is due"** reads "releasing in Desktop 1.3.90" for an ask, since its release opens at
   once. **Shipped** shows "update to …" until the ask is with the person.
6. **Out of scope there, changed here:** Ken's spec left the merge and release flow to each project's instructions. This
   spec changes the built-in flow for asks: one owner instead of the Integrator, a batch of one, a release step per ask.
   Projects keep their instructions for crew work.

The rest stands: the columns, the rights, Buddies, proposals, the card's chat, the rollout per project.

## Instructions lines that change

The PM edits these in the project's instructions when the matching build task ships (Dee's 11-06 note: a rule the code
checks loses its prompt line):

- Roles › Integrator, "Takes everything after a builder says its PR is ready": for crew work only; an ask's owner does it.
- Workflow 4: an ask's owner sets done when its release is verified, not when its review passes.
- Anh Dee's 11-07 hourly report (time since the last Desktop release, his asks merged but not released) reads from the
  ask records, so it is the same facts the Board shows.

## Measures

Each with no content, paths or identifiers:

- ask time from asked to with you, and from merged to released, median and p95, per day;
- asks late, and minutes late, per day;
- handovers per ask (target 0 beyond lost owners);
- lines in the PM's inbox per hour, by section, before and after;
- Desktop releases per day, and the asks each carries;
- `--prepare` builds reused at release, out of releases.

## Design (docs/feature-design-rules.md)

Reviewed revision: initial spec. Reviewer: pending. Each line: answered.

1. **Growth.** New data: on each ask task, a few small fields (asked at, due, stage and since, owner, the late flag for
   the current due, links to receipts); on each person's member record, one Desktop version. Nothing appended per
   event: each field is replaced. Lifecycle:

   | Record | Created | Updated | Finished | Lost | Cancelled | Leave and rejoin | Deleted, purged |
   |---|---|---|---|---|---|---|---|
   | Ask fields on a task | when the PM accepts a task with a person requester | on each stage change, a new due, late | kept with the task once with you | owner replaced; fields kept | stage stays at its last; no late flag on a cancelled ask | requester rejoining keeps it; a requester who left gets no Buddy line | with the task, by the existing archive and deletion |
   | Desktop version on a member | first Desktop request after this ships | only when a higher version is seen | n/a | n/a | n/a | reset with the membership | with the membership |

   Readers of "all tasks" (the Board, the personal Tasks feed, the archive, the history) read the fields like any task
   field; archived tasks keep them in history. Limit: bounded by open asks per Swarm, which are already open tasks.
2. **Concurrency.** Ask fields are written under the task's existing part version guard, by the command or time check
   that changed the stage, which already locks the task. The late flag holds the due it was raised for, so a second time
   check finds nothing new. The Desktop release lock is the release list's one open step per component per project
   (`releases.ts` `steps`); a second owner finds it open and waits. Merges serialize in the train, as today. The member's
   version is written under the member part, only when higher.
3. **Read cost.** The Board and the Tasks feed read changed task parts, as today; each ask card adds about 100 bytes.
   The late check runs in the existing time checks over loaded open tasks only. The version write happens once per
   Desktop update per person, not per request: the server compares with the value in its cache. A test asserts a one-task
   change sends one card and an unchanged version writes nothing.
4. **Scale.** At 10x today's asks (hundreds a day), releases coalesce: one building and one waiting per project, so
   Desktop releases stay within about one per release build time (to be measured; about 14 a day at 40 minutes). macOS
   runners (5 at once for the account) are the first limit; the metric that warns first is merged-to-released time p95
   and the wait for a macOS runner. Owners waiting between events hold no quota; held agents per Swarm equal open asks,
   shown on the Board.
5. **Compatibility.** Backend first; every new field is optional. Readers found in the code: the Board and card caption
   (`desktop/lib/super_tabs/task_groups.dart`), the personal Tasks feed (`personalTasks`), the phone parity test
   (`mobile/test/swarm/desktop_parity_test.dart`, so the phone model reads the new fields and draws nothing), the
   PM's digest and inbox (`noticeDigest.ts`, `inbox.ts`), stuck alerts (`stuck.ts`), busy checks (`occupiesAgent` in
   `model.ts`, `dispatch.ts`, `commands.ts`, `machines.ts`, `terminal.ts`, `github/holds.ts`), the train
   (`mergeTrain/plan.ts`), the release list (`releases.ts`, `releaseWatch.ts`) and the Buddy's news (`buddyNews.ts`). Each
   build task repeats the search for its own field. An older Desktop shows the card without the line; it sends no version,
   so its person's asks stay "shipped" and never "with you", and nothing else changes. An older backend sends no ask
   fields, and the new Desktop shows today's card.
6. **Migration and rollback.** Order: the backend tasks, then Desktop, each released on its own. No migration: open
   tasks with a person requester get asked at from their first message or proposal and the default due on their next
   change; no production write. Rolling back the backend: the previous release ignores the fields; owners go back to
   being freed on ready; notices go back to the PM. That direction is noisier and loses nothing. Checked against the
   isolated integration store; no production restore is needed for added optional fields.
7. **Audience.** Ask fields are task fields and go only where the task goes, through the same read predicate. The late
   line to a person goes only to the requester's own Buddy, through the existing private line path. A person's Desktop
   version is read only by the server to decide "with you"; no one else sees it. The version comes from the app itself,
   so the server trusts it for nothing else: it accepts only a well-formed version of bounded length (`desktop/` and a
   dotted number, at most 32 characters; anything else is dropped and counted), keeps it only when higher, and uses it
   only to show "with you", never for access, routing or a release decision. Logs and measures carry no titles or
   identifiers.
8. **Identity.** The owner runs under its own person's login and settings (Swarm v3). Merges go through the Swarm's
   GitHub App for its task, as today. The release runs from a checkout of main and dispatches the existing release
   workflow through the same App; signing secrets stay in that workflow. Releasing moves from one Integrator to every
   ask's owner, so the right is bound to the step: an owner may start a release workflow only through a release step the
   server opened for it, from main at a commit that holds its ask's merge with `ci/required` green. The App's right to
   start release workflows is granted for that step only, while it is open, and never to an Engineer's task access in
   general; the server refuses any other start and says so on the card. A `--prepare` build runs the release workflow
   from the branch's own copy, and its Mac build job gets the Apple signing secrets today (only Windows signing and
   publishing sit behind the protected `release` environment). So a branch could change the workflow or its signing
   action and read them. No ask prepares from a branch that changes anything under `.github/`, `scripts/` or
   `desktop/scripts/`, and none prepares for Team-written work. `release-desktop.sh --prepare` refuses such a branch and
   names why, and the ask's release builds from main instead. The cleaner fix, moving Mac signing behind the `release`
   environment, is its own security task, because the exposure exists today for anyone with write access. Once it
   ships, the path rule stays as a second guard. An owner without GitHub access for its task is refused and the ask
   goes late, never run under a machine owner's login.
9. **Failure.** Owner lost: the ask goes to a free lane agent at once, counted as a handover, and late if none is free
   for 10 minutes. Release fails: the owner sees the failed run, fixes it as a code failure and cuts the next version;
   the ask shows "releasing" until then and goes late at its due. GitHub cannot say a release is verified: the ask stays
   releasing, the release list logs it as today, and late catches it. Desktop sends no version: the ask stays shipped,
   which the person sees. The time checks stop: the PM watchdog (#3385) already restarts them. Every one of these writes
   a line on the card.
10. **Platforms.** Backend: Linux. Desktop: macOS, Windows, Linux, all three carry the card line and send the version.
    The phone and web Boards follow Ken's rollout; the phone reads the new fields in its model and draws nothing yet.
    Phone releases are not per ask.

## Build tasks, smallest first

1. **Words.** Add Ask, Owner, Due, Late and With you to docs/naming-system.md. Docs only.
2. **Prepare refuses unsafe branches.** `release-desktop.sh --prepare` refuses a branch whose diff from main touches
   `.github/`, `scripts/` or `desktop/scripts/`, and Team-written work, naming why (Design 8). Ships before task 12, which
   has owners prepare. Scripts, with a security review.
3. **Desktop says its version.** Desktop sends `x-harness-client: desktop/<version>` on its requests, as the CLI does.
   Desktop, all three OSes.
4. **The server records it.** The newest Desktop version per member: only a well-formed, bounded version, written only
   when higher, used only for "with you" (Design 7). Backend.
5. **Ask times on the task.** Asked at, due (the PM's at Accept, else the default), stage and since, owner; sent in the
   task part and the Tasks feed. Backend.
6. **The card's line.** Asked, now at, due and the late warning in the card caption; "update to …" in Shipped. Desktop,
   light and dark, from the existing card component.
7. **Late, once.** The time checks raise late once per due: a line on the card, the PM's Late section, the person's Buddy
   line; `work.status` takes a new due with a reason. Backend.
8. **With you.** An ask moves to with you from the member's Desktop version, its machines' CLI versions, or a verified
   backend or web release. Backend.
9. **The PM's inbox narrows.** The digest kinds and stuck alerts stop going to the PM; its inbox has New asks, Decisions
   and Late; settled conditions write their line on the card; the server reruns a recorded flaky check once. Backend.
10. **An ask merges alone.** The train merges an eligible ask's pull request in a batch of one, on the pass it turns
    eligible, asks before crew work (anh Dee's first). Backend.
11. **A release per ask.** The release list opens the Desktop step for the owner of the oldest ask it carries, one
    building at a time; an ask's backend release skips the 2-hour pace. The right to start a release workflow is granted
    for that open step only, from main at a commit holding the ask's merge with `ci/required` green (Design 8). Backend,
    with a security review.
12. **The owner stays.** "Handed" does not free an ask's owner; the server wakes it on each event; a lost owner's ask goes
    to a free lane agent with its receipts; the owner sets done at the verified release. Backend, with the CLI host's
    wake.

The PM edits the instructions lines above as tasks 9, 11 and 12 ship.

## Out of scope

- Phone releases per ask.
- Changing crew work's flow (no requester).
- New approvals or gates for people: late informs, it asks nothing.
- The release window, the backend pause and the urgent override.

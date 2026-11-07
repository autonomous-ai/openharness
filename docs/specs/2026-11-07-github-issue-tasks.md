# GitHub issues are the tasks of GitHub projects — 2026-11-07

Task #4533. Asked by anh Dee in the project chat at 17:30 Vietnam time on 2026-11-07 ("Let's build it").

**Why.** A team on GitHub keeps its work in GitHub, so on a GitHub project the issue is the task. Talk is a different
matter. lampOS ran its agents' talk through one "Queue" issue. That issue reached 18,700 comments and hit GitHub's
2,500-comment cap 7 times. Agents polled it and still missed asks. So agents talk in the task's chat in Harness, where
messages are pushed to whoever must act.

**What it is not.** It is not a GitHub client: Harness doesn't read issue comments, show issue threads or replace GitHub's
issue screens. It doesn't adopt issues opened on GitHub outside Harness; that is a separate proposal for the PM (end of
this spec). Code review stays a pull request review on GitHub, tied to a commit, as today.

## What exists today (checked 2026-11-07 on `main` cda28db13)

- A task is one `SwarmGroup` part: a `Conversation` in `backend/src/superTabs/model.ts:408-587`, with `title`,
  `brief`, `task` (goal, changes, constraints, owns), `checks`, `priority`, `requesterId`, `assignment`, PR links,
  `taskApproval`, `releasing` and `released`. Columns are worked out on the client
  (`desktop/lib/super_tabs/task_groups.dart:211-307`).
- Writes take a version check per part inside one Mongo transaction (`parts/write.ts:97-129`). Commands are idempotent
  by `operationId` (`SuperTabOperation`).
- The Harness GitHub App (`backend/src/github/app.ts`, `docs/swarm-github-app.md`) mints tokens for one repository and
  an explicit permission set. It never mints `administration`, `repository_creation` or `installation_repositories`.
  Agent tokens also ask for `issues: write` where the installation granted it (`GRANTED_TOKEN_PERMISSIONS`, #2755).
- **Nothing reads or writes GitHub issues.** The app's webhook is off, and no route receives GitHub events. Pull request
  events are polled every 60 s (`superTabs/pullRequestEvents.ts`).
- A project's repository is `project.repository.repositoryUrl`. It is approved for the project by someone GitHub says
  can push (`github/approvals.ts`). Harness never checks the repository's GitHub visibility.
- Harness doesn't know people's GitHub logins (`docs/swarm-github-app.md`, Attribution).
- `conversation.merged` (`commands.ts:3204`) marks a task merged. It is sent by the builder, the PM or the merge train.

## Departures from the ask (for anh Dee)

- **Harness keeps a read-only copy of the issue.** The ask says Harness keeps only the link and what isn't the task.
  This spec also keeps a copy of the issue's title, details, owner and status. Without it, every screen and agent read
  would be a GitHub call, which runs into GitHub's rate limits and goes down whenever GitHub does. An older release
  couldn't roll back either, since it would show empty tasks. The copy is never the truth: only GitHub's answers and
  webhooks write it, and GitHub replaces it whenever the two differ (A, and Design 2).
- **Some tasks never become issues** (confidential tasks, steps, and public-repository briefs that name people), and on a
  public repository the issue is created at Accept, not at creation. An issue can't be unpublished, and these protect
  security work and people's names. Ownrev6's review asked for this.

## Product spec

### Which projects

A project is a **GitHub project** when all of these hold. The server checks them, and the person makes no choice:

- its repository is on github.com and approved for the project;
- the app's installation on it has granted **Issues: Read and write**;
- the repository has issues turned on;
- the server has the app's webhook configured (`GITHUB_APP_WEBHOOK_SECRET`);
- the repository's audience matches the project's (Design 7: private with private, public with public; an internal
  repository never).

Any other project keeps its tasks in Harness exactly as today. Project details shows which condition is missing, in one
line: for example "Tasks stay in Harness: the app can't write issues here. An owner accepts Issues under Configure."

### Tasks that stay in Harness on a GitHub project

Harness can't take an issue back once it's published, since deleting one needs `administration`, which the app never
gets. So the server decides before it creates an issue, and these tasks never get one:

- **Confidential tasks**, on any repository, public or private. `conversation.create` takes an optional
  `confidential: true`, set only at creation. The PM sets it for security work (an unfixed hole, an incident's details)
  and for any brief that quotes a person's private chat; the PM's skill text says so. Setting it on a task whose issue
  already exists is refused with `ISSUE_ALREADY_PUBLISHED`, and the PM is told that only a repository admin can delete
  the issue.
  - **On a public repository, it is on by default** for a P0 task and for a task whose brief asks for a security review
    (its constraints or review name one). An unmarked security task therefore fails closed: it stays in Harness. The PM
    publishes such a task only by sending `confidential: false` explicitly. A false match only keeps a task in Harness.
- **On a public repository, a brief that names someone.** Before publishing, the server runs the title and brief through
  `redactCredentials`, and checks them for any email address and any person, machine or account name from the Swarm's
  roster. On a match the task stays in Harness, and the PM is told which kind of name stopped it (never the name
  itself). Editing the brief clears the hold, and the issue is created then.
- **Steps** (review, security review, test), as they aren't tasks of their own.
- **Open tasks on a public repository at migration.** Their briefs were written for Harness, not for the public, so they
  finish in Harness (Design 6). Only tasks created after the project becomes a GitHub project get issues.

The card of a withheld task shows no issue number, like any Harness task.

### A) The issue holds the task

On a GitHub project, each task is one GitHub issue. The issue holds:

| Task field | On the issue |
| --- | --- |
| Title | The issue title. |
| Details (goal, changes, constraints, owns, checks, review) | The issue body, as Markdown sections with these headings, plus a hidden marker line `<!-- harness-task: v1 -->`. |
| Owner | The person, as the issue's assignee. |
| Status | One Harness label: `harness: assigned`, `harness: accepted`, `harness: in review`, `harness: done`. |
| Agent | One label `agent: <name>` for the agent on it now. |

The issue is the truth for title, details, owner and status:

- **Harness writes it through the app.** Creating a task creates the issue. An edit in Harness (rename, `work.define`)
  updates it. Accept, assignment, review and merge move its label. The app's bot is the author of every write.
- **GitHub edits show in Harness.** The app's webhook reports each edit, and Harness applies it within seconds.
- **GitHub wins.** If the issue changed on GitHub after the copy an edit in Harness was based on, Harness doesn't apply
  that edit. It tells whoever made it, in the task's chat: "The issue changed on GitHub; your edit wasn't applied." It
  never overwrites a GitHub edit and never rewrites labels or text it didn't set.

**Harness keeps:**

- the link: repository id, issue number and URL;
- what isn't the task: its chat, its Decisions, which agent is on it now and that agent's attempts, PR links and check
  results;
- a read-only copy of the issue's title, details, owner, status and `updated_at`, in the task's existing fields.

The copy serves screens and agents without a GitHub call per read, lets an older release roll back (Design 6), and lets
an agent rebuild offline. It changes only from GitHub's answers and webhooks, never from a Harness edit directly. When
the copy and GitHub differ, the copy is replaced. Until a task's issue exists (it is being created, or GitHub is down),
the task's fields are Harness's own, as today. The issue is created from them, and from then on the copy rule applies.

**Status, both ways:**

| Harness | Issue |
| --- | --- |
| Task created; its requester's mode is Ask me, waiting for their Accept | Private repository: open, `harness: assigned`. Public repository: no issue yet; it is created at Accept, so a task the requester declines is never published. |
| Accepted (by the owner, or at once under Accept all); waiting for an agent, or an agent working | open, `harness: accepted` |
| Agent reports `review` with its PR | open, `harness: in review` |
| `conversation.merged`, and CI was green at the merged head | `harness: done`, then closed (`completed`) with the note below |
| Merged with CI not green | stays `harness: in review`; the PM is told |
| Declined, or cancelled (`work.cancel`) | closed (`not_planned`); no Harness label |

Harness acts on these changes made on GitHub:

| GitHub | Harness |
| --- | --- |
| Title or body edited | The copy updates. The agent on it is sent a message in the task's chat: "The issue changed on GitHub:" with what changed. |
| Status label changed by hand | Tasks shows GitHub's status. The PM is told. No agent is started or stopped. |
| Closed by a person | The agent on it is told to push and stop, and the task shows Done or Declined from `state_reason`. The PM is told. |
| Reopened | The task returns to Next up. The PM is told. |
| Assignee changed | Tasks shows the new assignee as the owner if they have linked their GitHub account, and "Owner not in Harness" otherwise. Accept and Decline stay with the task's requester in Harness, so write access on GitHub never approves a task. Work in progress goes on; the PM is told. |
| `agent:` label changed by hand | Shown on GitHub only. Harness keeps its own record of the agent and changes the label only when the agent changes. |
| Deleted or transferred | The link is removed. The task stays in Harness with its last copy, and the PM is told. |

**The close note.** When a PR merges with CI green, Harness posts one comment and closes the issue. The comment says what
changed (the PR's title and link) and how it was tested (the names of the checks green at the merged head, and of the
review steps that said Yes). It carries no evidence text, so no machine name, path or agent output reaches GitHub. It is
capped at 2,000 characters. It is the only comment Harness writes on an issue. PR bodies say `Refs #N`, never `Closes #N`, so GitHub doesn't close an issue on a red merge.

**The owner.** The issue's assignee starts as the task's requester. Ownership on GitHub is shown, not obeyed: Accept,
Decline and every other authority stay with the Harness requester and the existing server checks. A person links their
GitHub account once, through the app's existing sign-in. Harness stores their GitHub
user id and login only, and revokes the sign-in token at once, as approval does today. An owner who hasn't linked one
leaves the issue unassigned. Harness writes no name or email of theirs to GitHub. If GitHub drops an assignee who can't
access the repository, Harness reads that from its answer and tells the PM.

**The Tasks screen.** One screen shows both kinds of task, as today: GitHub tasks and Harness tasks mix in one list. A
GitHub task's card shows the issue number beside the project tag. Clicking the number opens the issue in the browser,
and clicking anywhere else opens the task's chat. A task with no issue shows no number. Issues and PRs share one sequence
of numbers in a repository, so the issue number never collides with a PR number. The look follows
`desktop/design/desktop-design-system.md` and comes from its own mockup task.

**Two numbers, and how `#N` is read.** A GitHub task has its Harness number (#4533) and its issue number (212). Each
place shows one of them, and where a `#N` came from decides what it links to:

| Place | Shows | `#N` there means |
| --- | --- | --- |
| Task card | The issue number, with GitHub's mark | The issue (opens GitHub) |
| Commands, CLI, `status`/`mine`/`task` | The Harness number; `task` also prints the issue URL | A Harness task |
| Harness chat written in Harness (people, agents, cancel and close reasons since #3545) | — | A Harness task, as today. Harness's own lines about a GitHub task name both: "#4533 (issue 212)" |
| Text copied from GitHub (the issue's title and body copy, "The issue changed on GitHub" messages) | — | That repository's issue or PR, linked to GitHub, never to a Harness task, so "Duplicate of #212" opens issue 212 |
| What Harness writes to GitHub (issue body, labels, close note, the PR line `Refs #212`) | Only GitHub numbers | GitHub's own linking; no Harness number is written there |

The renderer knows which kind of text it draws: the copy carries its source, so no guessing from the text is needed.

### B) Agents talk in the task's chat

- Agents ask, answer and hand over in the task's chat, addressed to whoever must act, as today. Harness creates no
  "Queue" issue and no issue for talk. It reads no issue comments, so no agent waits on one, nothing polls, and the
  comment cap doesn't apply.
- The agent skill text (`cli/src/lib/swarmSkills.ts`) says it plainly: never post to or poll a GitHub issue to talk; the
  task's chat is where people and agents hear you.
- On a GitHub project, agent tokens no longer ask for `issues`. Only the server writes issues, so an agent can't set its
  own status label or close its own issue. Agents still write pull requests, reviews and PR comments with
  `pull_requests: write`.
- Existing Queue issues, lampOS's included, are the team's data. Harness doesn't close, lock or edit them. The team
  closes them when its agents have moved to task chat.

## Design (docs/feature-design-rules.md)

Reviewed revision: the head PR #3549 merges at. Reviewers: Ownrev6 and Ownrev1 (review), Ownrev5 (security: GitHub
App tokens), Ownrev2 (security: private repositories).

### 1. Growth

| Record | Created | Updated | Finished, lost, cancelled | Deleted | Limit |
| --- | --- | --- | --- | --- | --- |
| Issue link and copy on the task (`issue` in the group's JSON, about 0.3 KB plus the body copy) | The issue is created for a task, or migration | Each webhook or write answer newer than the copy | Stays with the task; archived with it | Deleted with the task's group; recreating a group under the same key starts with no link | One per task. The body copy is capped at GitHub's 65,536 characters, under `PART_LIMIT_BYTES`. |
| `issueKey` column on `SwarmGroup` (`<repositoryId>#<number>`) | With the link | Never (a transfer removes it) | Kept while the group is | With the group | One per task, unique |
| Pending GitHub write on the task (`issue.pending`: wanted fields and the copy each was based on) | A Harness edit or status change | Overwritten by the next wanted state, so it never queues more than one per field | Cleared when applied or refused | With the group | One per task, about 5 fields |
| Person's GitHub link (`githubUserId`, `githubLogin` on the membership) | Linking | Relinking | Removed when the membership is | With the membership; rejoining starts unlinked | One per membership |
| Webhook delivery receipt | Each applied delivery (an existing `SuperTabOperation` keyed by the `X-GitHub-Delivery` id) | Never | — | Existing operation-receipt expiry | One per delivery for a linked issue. Deliveries for issues with no task store nothing. |
| `agent: <name>` label in the repository | First time that agent works a task there | Never | — | Never by Harness: a label in the team's repository is theirs to remove | One per agent that worked there (tens per repository) |
| Harness status labels (4) | Created once per repository on first use | Never | — | Left in place | 4 per repository |
| The close note | One per merged task | Never | — | The team's, on GitHub | One per task |

Readers of "all tasks" (Board, Tasks feed, CLI `status`, leaderboard, archive pass, PR watch, merge train) read the copy
in the existing fields, so they need no change. Archived tasks keep their link, and the archive pass doesn't touch the
issue.

### 2. Concurrency

- The unit is the task's group part, as today. A webhook applies in one transaction that loads the group by `issueKey`
  and writes it with the existing version check. Nothing locks the Swarm.
- Invariant: **one writer of the copy.** Only GitHub's answers and webhooks write it. They apply only when the issue's
  `updated_at` is newer than the copy's, so late or replayed deliveries change nothing.
- Invariant: **GitHub wins.** Each Harness edit records the copy it was based on. The command refuses with
  `ISSUE_CHANGED_ON_GITHUB` if the copy has moved since. The sync pass reads the issue again (conditional GET) just before
  writing, and drops any field whose GitHub value is no longer the base. Labels and assignees change through GitHub's
  add and remove endpoints, never by replacing the whole list, so a label a person added at the same moment survives.
  Title and body change through `PATCH` with only that field.
- Invariant: **one issue per task.** Creation runs after the command commits, never inside the transaction. The task's
  wanted state marks `creating`, and the issue is created with the marker line, the task's id in it. A retry after a
  crash lists the bot's issues since the mark (`GET /issues?creator=<bot>&since=`, page by page, at most 10 pages of
  100) and adopts its own issue rather than creating a second. If 10 pages don't reach the mark time, it stops, holds the
  task's creation and tells the PM. It never creates a second issue.
- The sync pass runs in the singleton worker. It wakes when a commit leaves a pending write (push, not a timer) and
  handles one task at a time per installation, so a task's writes stay in order.

### 3. Read cost

- **Clients:** nothing new to fetch. A synced edit is an ordinary group change on `/changes`. `personalTasks` rows and
  group views gain an optional `issue: { number, url }` (about 80 bytes). A first load of 1,000 active tasks grows by at
  most 80 KB. An idle cursor adds nothing. A test asserts the row bytes and that a one-issue edit sends one group part.
- **Webhooks:** each delivery costs one indexed lookup on `issueKey` (unique index). An event for an issue with no task
  answers `204` and stores nothing. A test asserts that no collection scan happens and that unlinked deliveries make no
  writes.
- **GitHub API, per task lifetime:** about 12 requests from the installation token: create (labels and assignee in the
  same call), 2 per status move (add one label, remove one), 2 per agent change, 1 conditional GET per write batch (a 304
  doesn't count against the limit), and close plus note. Quick moves inside 5 seconds collapse into one write (Accept all
  creates the issue already `accepted`).
- **GitHub API limits** (per installation): 5,000 requests an hour or more, and GitHub's secondary limits on writes of
  about 80 a minute and 500 an hour. The sync pass keeps its own budget, under both, per installation: 60 writes a minute
  and 400 an hour. Above it, writes wait in order. Tasks shows "Syncing to GitHub" on the card, and nothing fails.
  `Retry-After` and secondary-limit answers back off (1 s, 2 s, 4 s ... up to 5 min) and never retry in a loop. Every
  request keeps the existing 10 s timeout.
- **Missed webhooks:** GitHub doesn't retry a failed delivery itself. Every 15 minutes the worker reads the app's
  delivery log with the app's JWT (`GET /app/hook/deliveries`, 100 a page), paging back to where its last pass ended,
  and asks GitHub to redeliver the failed ones. It reads at most 20 pages a pass. A backlog past that is counted and
  logged, and the next pass carries on from there. Idle, that is one request per server per pass, not per task. Opening a task's chat and assigning an agent also do a conditional GET of its issue.

### 4. Scale (10x)

- Today: about 80 tasks a day (56, 65 and 84 commits reached `main` on 4, 5 and 6 Nov) and 34 open tasks in the
  busiest Swarm (openharness). At 10x: 800 tasks a day, about 9,600
  requests a day (nearly all writes), so about 400 writes in a busy hour in one repository. **That is GitHub's secondary write limit**, so it
  is the first limit, under 2x away. The write budget keeps Harness under it (writes wait; they don't fail), and this
  line triggers a design review (Rule 2) when the measured peak passes 200 an hour.
- The metric that warns first: `harness_github_issue_writes_per_hour_peak` (a gauge of the busiest installation's last
  hour, with no ids), plus `harness_github_issue_sync_wait_seconds` (a histogram of the time from a Harness change to
  its GitHub write). The thin slice measures both on a synthetic run of 200 tasks against `fakeGitHub`.
- Webhook load at 10x: one indexed lookup per issue event in installed repositories, whether linked or not. The p95
  target is 100 ms, like every hot-path query.
- Other measures, all without ids or content: `harness_github_webhook_deliveries_total{event,outcome}`,
  `harness_github_issue_sync_total{direction,outcome}`, `harness_github_issue_lag_seconds` (from GitHub's `updated_at`
  to the copy applied), `harness_github_rate_remaining_ratio`. Each is emitted after commit (`afterCommit`), so retries
  count once.

### 5. Compatibility

The backend ships first. Every new field is optional, and no `WorkStatus` value is added. The readers, from a search
of the code:

| Reader | With an `issue` field |
| --- | --- |
| Desktop board card (`task_card.dart`, `tasks_view.dart:700`) | Ignores it until the card task ships; then it shows the number. |
| Desktop personal Tasks card (`tasks/personal_task_card.dart`) | Same. |
| Mobile (`swarm_project_tasks.dart`, `tasks/personal_tasks.dart`) | Ignores it; mobile shows the number in a later task. |
| Web | Same Flutter code as Desktop. |
| CLI `task` / `status` / `mine` | Prints the issue URL when present. Older CLIs print the copy, as today. |
| Agent skills (`swarmSkills.ts`) | Updated text in B). Older skill text still works; agents simply aren't told about issues. |
| PR watch, merge train, release watch, archive pass, leaderboard | Read PR links and the copy, as today, so they're unchanged. The merge path adds the close write after commit. |
| `work.define`, `conversation.rename` | On a GitHub task they also leave a pending write, and refuse with `ISSUE_CHANGED_ON_GITHUB` (409) when the copy moved. Older clients see a named refusal. |
| `task.approve` / `task.reject`, `work.assign`, `work.status`, `work.cancel`, `conversation.merged` | Unchanged inputs; the server adds the status write after commit. |

- An older Desktop against the new backend shows GitHub tasks as ordinary tasks, without the number.
- A newer Desktop against an older backend sees no `issue` field and shows no number.
- Command schemas are `.strict()`. The one new input, `confidential` on `conversation.create`, ships with the backend
  before the PM's skill text names it. Agents send command JSON as written, so no CLI release is needed for it. An agent
  that leaves it out on a public repository is still caught by the server's name check. The skill text tells the PM to
  set it for security work. On a public repository, P0 and security-review tasks are confidential by default, so leaving
  it off fails closed there.

### 6. Migration and rollback

Order:

1. Backend (webhook receiver and copy) ships.
2. The app's webhook is turned on and its secret is set (Ken).
3. New tasks on GitHub projects get issues.
4. Clients ship the number.
5. The open tasks of each GitHub project are migrated, one project at a time.

**Migration:**

- On a **private** repository, a worker job takes each open task (not done, merged, archived, confidential or a step)
  and creates its issue at the task's current status, within the write budget. It is a dry run first. The dry run lists
  per project what it would create, so the PM can mark tasks confidential before the run.
- On a **public** repository, nothing is migrated. Open tasks finish in Harness, and only new tasks get issues, under the
  checks in "Tasks that stay in Harness".
- The job is idempotent by the marker line and the bot's issue list.
- Finished tasks get no issue; their history stays in Harness.
- It is checked against the read-only anomaly queries on production (task counts per project and the largest brief per
  project, on indexes, with `explain()` first). No production restore runs, because Harness's data changes only by
  adding a link.
- Ken gives the go for the run, since it writes to customers' repositories.

**Rollback:**

- The previous release ignores `issue` and reads the copy in the existing fields, so every task still shows its last
  synced title, brief and status.
- The issues stay on GitHub, untouched. Their labels freeze until the next deploy.
- Rolling forward again reads each linked issue (conditional GET, within budget) and applies anything edited meanwhile,
  so GitHub still wins.
- A rollback never deletes an issue or label. To stop one project's sync, revoke the app's Issues grant: the project
  stops being a GitHub project, and its tasks go on from the copy.

### 7. Audience

- **The repository's audience matches the project's, both ways.** The rule covers what comes into Harness and what goes
  out:

  | Harness project | Repository | GitHub project? |
  | --- | --- | --- |
  | Private (members only) | Private | Yes |
  | Public (the whole Swarm) | Public | Yes, with the public-repository holds ("Tasks that stay in Harness") |
  | Private | Public | No. Members-only tasks would be published to the world. |
  | Private | Internal | No. The tasks would reach the whole GitHub organisation. |
  | Public | Private or internal | No. Repository content would reach Swarm members without repository access. |

  - The server reads the repository's visibility when it links the project, and again on `repository` webhooks
    (`privatized`, `publicized`, `renamed`, `transferred`, `deleted`).
  - It also reads it right before each issue is created (a conditional GET, so a 304 costs nothing). A missed webhook
    therefore never publishes under the old rule.
  - Changing either side so the pair stops matching stops sync at once. Nothing more is published, and no later edit
    comes into Harness. The project owner is told in one line which side to change. Making a linked private project
    public is refused with `REPOSITORY_AUDIENCE_MISMATCH`, which names why.
  - Project details shows a mismatch as the missing condition, for example "Tasks stay in Harness: the repository is
    public and this project is private."
- **Who reads a GitHub task's copy:** the existing `canReadProject` / `canReadGroup` predicate, the one every read path
  calls. No new read path exists: the copy travels in the group part.
- **Where copies go, and their guards:**
  - API reads and change feeds: the same predicate.
  - Notices and messages ("The issue changed on GitHub"): posted inside the task, so the task's audience applies.
  - An agent's terminal: the task's agent gets the issue's text as it gets the brief today. On another person's machine
    that is the same exposure as the repository's code, which it already clones.
  - Logs: delivery id, event, action and outcome only, never titles, bodies, logins or tokens.
  - Measures: counts and durations only.
  - Webhook payloads of unlinked issues: discarded unread, never stored.
  - A rolled-back release shows the copy only to the same predicate.
- **What leaves Harness for GitHub:** the title and details of tasks that aren't withheld ("Tasks that stay in Harness"),
  status and agent labels, the assignee (only for a person who linked their account), and the close note (PR link and
  check names). Confidential tasks and steps never leave. On a public repository, a brief naming a person, machine or
  account from the roster, or holding an email, is held back by the server. No chat text leaves.
- **Whose edits on GitHub direct agents:** GitHub lets only an issue's author (the app's bot) and people with write access
  edit its body. So the people who can change a task's brief on GitHub are the people who can already push to the
  repository. Comments are never read, so outside people on a public repository can't reach an agent through an issue.
- **The webhook route** (`POST /api/github/webhook`) is the only new unauthenticated route:
  - It checks `X-Hub-Signature-256` with a constant-time compare before parsing.
  - It takes at most 1 MB.
  - It accepts only `issues`, `repository`, `installation` and `installation_repositories` events.
  - It answers within 10 s. A busy store answers `503`, and the redelivery pass picks the delivery up.

### 8. Identity

- Every issue write runs as the app, with a server-only installation token: `ISSUE_SYNC_PERMISSIONS = { issues: 'write',
  metadata: 'read' }` for the one repository. It is minted when the sync pass needs it, cached in the server's memory
  until 10 minutes before expiry, never sent to a client or an agent, and never logged.
- No person's login and no user-to-server token writes an issue. The machine owner's git or gh login is never used.
- Linking a person's GitHub account uses the app's existing sign-in. The person's short-lived token reads only who they
  are, is revoked at once and is never stored.
- On GitHub projects, agent tokens lose `issues` (B). `TOKEN_PERMISSIONS` stays as it is.
- The app's manifest needs no new permission. The webhook needs the **Issues** and **Repository** events turned on, plus
  the secret (GitHub sends installation events to every app). `docs/swarm-github-app.md` changes in the same PR as the receiver.
- Missing identity: with no app, no Issues grant or no webhook secret, the project isn't a GitHub project, and Project
  details says which is missing. Nothing falls back to a person's login.

### 9. Failure

| Failure | Who notices | What they see | Recovery |
| --- | --- | --- | --- |
| GitHub down or times out on a write | Sync pass | Card: "Syncing to GitHub"; after 15 min the PM is told | Backoff up to 5 min; the pending write stays until it applies |
| Write refused (permission lost, issue locked, repository archived) | Sync pass | PM and the task's chat: GitHub's reason in one line; Project details shows the missing condition | Pending write cleared; the task goes on from the copy until fixed |
| Edit made in Harness after GitHub changed | The editor | "The issue changed on GitHub; your edit wasn't applied." | Read the new copy and edit again |
| Webhook delivery lost or refused (`503`) | Redelivery pass | Nothing, if redelivered within 15 min; `deliveries_total{outcome=failed}` rises | GitHub redelivers; opening the task reads the issue again |
| Bad signature | Receiver | `401`, a log line without the body, and the outcome counted | None: the request is dropped |
| Crash between creating the issue and recording it | Sync pass on restart | Nothing | Adopts its own issue by marker; never a second one |
| Assignee dropped by GitHub (no repository access) | Sync pass | PM: "<person> can't be assigned on GitHub" | Owner kept in Harness; issue unassigned |
| Repository and project audiences stop matching (either side changed) | Receiver, or the visibility read before a create | Project owner: one line naming the side to change; sync stops | Match them again; sync resumes and reads each issue again |
| Merged with CI red | Merge path | PM: the issue stays `in review` | A green fix-forward merge closes it |
| Issue deleted or transferred | Receiver | PM, and the task loses its number | The task goes on in Harness |
| Rate budget full | Sync pass | "Syncing to GitHub"; the wait histogram rises | Writes drain in order as the budget allows |
| Brief names a person, machine or account, or holds an email (public repository) | Server, before creating the issue | PM: which kind of name held it back (never the name) | Edit the brief; the issue is created then. Until then the task works in Harness |
| `confidential` set after the issue exists | The command | `ISSUE_ALREADY_PUBLISHED`: only a repository admin can delete the issue | The PM asks the repository's admin |

### 10. Platforms

- The backend (Linux) does all GitHub work. No daemon, CLI core or PTY change, so macOS, Windows and Linux machines
  behave alike, and no process starts.
- Desktop (macOS, Windows, Linux) and web show the number in the card task, tested offscreen in light and dark.
- iOS and Android ignore the field until their own task.
- The CLI prints the URL, the same on every platform.

## Build tasks, smallest first

Today is Saturday 7 Nov; the launch is Tuesday 10 Nov. Before the launch, only what can't break a customer's
repository ships: the talk rule, the receiver that only records, and account linking. Writes to GitHub start after the
launch, behind each repository's own Issues grant. Each task is its own PR, with its Design lines checked against this
spec.

**Before the launch**

1. **Agents talk in the task's chat** (S, docs and skill text). `swarmSkills.ts` and the PM tool sheet: never post to or
   poll a GitHub issue to talk; ask in the task's chat with `--to`. A test asserts the skill text. Ships Saturday.
2. **Webhook receiver, recording only** (M, backend).
   - `POST /api/github/webhook` with signature check, size cap, event allow-list and delivery-id receipts.
   - Metrics, a log line per delivery, and the redelivery pass.
   - `GITHUB_APP_WEBHOOK_SECRET`, and `docs/swarm-github-app.md` updated.
   - No effect on tasks yet.
   - Two security reviews (signature, unauthenticated route). Ken sets the secret and turns the webhook on. Sunday.
3. **Link a person's GitHub account** (S, backend plus Desktop's existing GitHub access section).
   - The existing sign-in stores the GitHub user id and login on the membership.
   - Unlink on leave.
   - Security review (token revoked, never stored). Monday.

**After the launch (from Wednesday 11 Nov)**

4. **Issue link, copy and audience** (M, backend).
   - The GitHub-project predicate, with the audience-match rule, the visibility read before each create, and the `repository` events.
   - `issueKey` index.
   - Creating the issue for a new task (marker, adopt on retry).
   - What stays in Harness: `confidential`, steps, and the public-repository name check. The PM's skill text names
     `confidential`.
   - Applying `issues` webhooks to the copy, with the newer-`updated_at` rule.
   - "The issue changed on GitHub" messages.
   - Two security reviews (server token permissions; private repositories). This must ship before any issue content
     enters Harness.
5. **Status, owner and agent labels, and agent tokens lose `issues`** (M, backend).
   - The pending-write sync pass, its write budget and backoff.
   - The status and agent labels and the assignee.
   - `ISSUE_CHANGED_ON_GITHUB`.
   - GitHub-side close and reopen acting on the task.
   - Agent tokens drop `issues` on GitHub projects.
   - Security review.
6. **Close on a green merge** (S, backend). The close note (PR link and check names only, capped), `Refs #N` in the PR line, and red merges
   left `in review`.
7. **Issue number on the task card** (S, Desktop and web). Takes the mockup from its own task. Adds `issue` to
   `personalTasks` and group views. Design system doc and gallery updated in the same PR.
8. **Migrate open tasks** (M, backend job). Dry run per project, then the run with Ken's go, project by project,
   openharness last.
9. **Mobile shows the number** (S, mobile). Tested on Tony's Mac.

## Proposals for the PM (not in this spec)

- Adopting an issue opened on GitHub as a task (a label such as `harness` that the PM triages). It needs its own design:
  the issue's author may not have write access, so its text must reach agents only after the PM accepts it.
- Replacing the 60 s pull request poll with `pull_request`, `check_suite` and review webhooks through the receiver in
  task 2.

# GitHub repository approval in every Swarm Implementation Plan

> Way of working: this project's instructions (Engineer role): implemented by the Engineer task by task, each failing test
> committed before its code; one independent review on the pull request (two here: a security change). Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Harness GitHub App gives a Swarm project's agents a token for a repository only once someone who can push to
it approved it, in every Swarm, whatever the Team-account switch says; a one-off script lists, and on the owner's go
approves once, the (Swarm, project, repository) pairs in use now so nothing working today breaks.

**Architecture:** Today the approval check in both token routes and in the project's GitHub status read is skipped unless
`SWARM_TEAM_ACCOUNT_REQUIRED=1` (store grants carry `approvalRequired: teamAccountRequired()`). The check becomes
unconditional and `approvalRequired` leaves the grants; the Team-account switch keeps deciding machine rules only. A new
module lists current pairs from each Swarm's head part (one aggregation, no full Swarm load) and, only with `apply`,
writes per-project approval rows marked as granted by this migration; a script wraps it, dry run by default.

**Tech Stack:** TypeScript, Fastify, Prisma on MongoDB, Vitest (unit + `integration/` on MongoMemoryReplSet with a fake
GitHub).

**Spec:** Task #1694 brief (option B, default applied 11-03 15:00 VN); the approval design in
`docs/plans/2026-10-28-swarm-project-github-access.md` ("Approval: who may use a repository").

## Global Constraints

- Every Swarm needs a person's approval of a GitHub repository before its agents get GitHub App tokens for it.
- Existing Team-account behavior unchanged: with the switch on, the same refusals and the same tokens as before.
- The script is a dry run by default: prints counts and pairs, writes nothing unless told (`--apply`).
- No production write: the script runs for real only with Ken's go, after this merges and a production dry run is read.
  In this task it runs only against the throwaway test database.
- Refusal code and text stay `GITHUB_REPOSITORY_NOT_APPROVED` with the existing message (clients already show it).
- PR body first line: "Requested by ken15@autonomous.ai through Harness."
- Swarm code stays out of `cli/src/core`; nothing in the CLI or Desktop changes (both already handle `not-approved`).

## Design

- **Growth:** approval rows already exist (one per Swarm, repository, project or `*`). The script adds at most one per
  current GitHub project; Swarm purge already deletes a Swarm's rows (`superTabs/purge.ts`).
- **Concurrency:** the script writes with the existing unique index (`autonomousEnv, tabId, repository, projectId`) as an
  upsert that never overwrites a person's approval; a second run writes nothing.
- **Read cost:** the token routes do the same single indexed lookup they already do with the switch on. The script reads
  only head parts (`projects`) and `SuperTab` ids/env/deletedAt.
- **Scale:** 10x Swarms is 10x head rows in one aggregation, read once by hand; tokens add no reads. First warning: token
  route latency (unchanged path).
- **Compatibility:** old clients never approve; a teammate's start on an unapproved project already gets
  `GITHUB_REPOSITORY_NOT_APPROVED` in Team-account Swarms, and Desktop/web show "Set up GitHub for teammates".
- **Migration + rollback:** order is merge → production dry run read by Ken → his go → `--apply` → backend release (rerun
  the dry run just before release; it is idempotent). Rollback: release the previous backend; the rows are unused by it.
  Removing grandfathered rows: `deleteMany({ approvedBy: GRANDFATHERED_BY })`.
- **Audience:** the server enforces it, in both token routes; the client status is only a display.
- **Identity:** grandfathered rows name `approvedBy: 'system:grandfathered-2026-11-03'`, never a person, so `reader` never
  tells anyone "You can push" from them.
- **Failure:** an unapproved project gets the 403 with its reason; the script lists Swarms it could not read
  (`skipped`, `failed`) and exits non-zero on a failure.
- **Platforms:** backend only.

## Review Focus

- A Swarm without the Team-account switch asks for an agent's token on an unapproved repository: refused, no GitHub mint.
- An approval for the whole Swarm (`*`) still covers every project, and an approval in another Swarm does not.
- Grandfathered rows must not read as a person's "can push" in `reader` (the dialog's "You can push").
- The dry run against a database with a person's existing approval, a deleted Swarm, a non-GitHub address and a
  project without an address lists only what is missing, and writes nothing.
- An old single-row Swarm (`format` 1) is listed as skipped, never silently passed over.

---

### Task 1: Approval required in every Swarm

**Files:**
- Modify: `backend/src/routes/superTabs.ts:262-276,326-336` (`requireApproval`, project GitHub status)
- Modify: `backend/src/superTabs/store.ts` (`githubAssignment`, `githubStart`, `projectRepository`: drop `approvalRequired`)
- Test: `backend/integration/superTabGithub.test.ts`, `backend/integration/superTabTeam.test.ts:643`
- Docs: `docs/swarm-github-app.md` (approvals: every Swarm), `docs/plans/2026-10-28-swarm-project-github-access.md` (Rollout)

**Interfaces:**
- Produces: `requireApproval(user, grant: { tabId; projectId }, repository)` always checks; store grants without
  `approvalRequired`.

- [ ] **Step 1: Write the failing tests** in `superTabGithub.test.ts`, switch off (no `teamAccounts()`):
  - `the GitHub token endpoint` › `refuses an agent's token for a repository nobody approved for the project, in a Swarm
    without the team account, and gives it once approved`: `fresh({ approveAll: false })`, `working(env)`, `ask` →
    403 `GITHUB_REPOSITORY_NOT_APPROVED`, no `/access_tokens` call; push an approval for `lead` → 200 with `token`.
  - Same endpoint › `with the team account on, refuses an unapproved repository and gives an approved one its token`
    (Team behavior pinned on the agent route too).
  - `a queued start's preparation token` › replace `asks approval in any Swarm with the switch on, ... and none with it
    off` by `asks approval in any Swarm, with the switch on or off`: both 403, status `not-approved` both times.
  - `the GitHub token endpoint` › `a swarm-wide approval covers every project; another Swarm's does not`.
- [ ] **Step 2: Run, verify red**: `cd backend && npm run test:super-tabs -- integration/superTabGithub.test.ts`
  Expected: the switch-off cases FAIL (200 / `covered` instead of 403 / `not-approved`).
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement**: remove `if (!grant.approvalRequired) return` and the `!project.approvalRequired ||` short
  cut; drop `approvalRequired` from the three store returns and from `superTabTeam.test.ts:643`'s expected object.
- [ ] **Step 5: Run green**: same command, then `npm run test:super-tabs -- integration/superTabTeam.test.ts` and
  `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** code + docs.

### Task 2: One-off approval of current pairs

**Files:**
- Create: `backend/src/github/currentApprovals.ts`
- Create: `backend/scripts/swarm-github-approvals/approve-current.ts`
- Test: `backend/integration/superTabGithubCurrentApprovals.test.ts` (added to `backend/vitest.super-tabs.config.ts`)

**Interfaces:**
- Produces:
  - `export const GRANDFATHERED_BY = 'system:grandfathered-2026-11-03'`
  - `export interface CurrentPair { autonomousEnv: string; tabId: string; projectId: string; repository: string }`
    (`repository`: `owner/name`, lower case, from `githubRepository(url).fullName`)
  - `export interface CurrentApprovalsReport { apply: boolean; swarms: number; pairs: CurrentPair[]; alreadyApproved: number;
    written: number; skipped: string[]; failed: Array<{ tabId: string; error: string }> }`
  - `export async function approveCurrentPairs(db: PrismaClient, opts: { apply: boolean; installed: (repository: GitHubRepository) => Promise<boolean> }): Promise<CurrentApprovalsReport>`
  - After security reviews 1 and 2: only pairs whose repository the app is installed on now are approved (the script passes
    `GitHubApp.resolve(...) !== null`, so it needs `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY`); the report adds
    `notInstalled: CurrentPair[]` and `unknown: Array<CurrentPair & { error: string }>`, neither ever approved. Errors print
    their code only; a live Swarm without a head is `skipped`; a person approving mid-run counts as already approved.
- Script: `DATABASE_URL=… node --import tsx scripts/swarm-github-approvals/approve-current.ts [--apply]`; prints the report
  as JSON then one line (`Dry run: N pairs would be approved. Nothing was written; add --apply to write them.`); usage
  and exit 2 for any other argument or no `DATABASE_URL`; exit 1 when `failed` is not empty.

- [ ] **Step 1: Write the failing tests** (fresh MongoMemoryReplSet, `prisma db push`, Swarms made through `SuperTabStore`):
  - `lists each live Swarm's GitHub projects without an approval, and writes nothing in a dry run`: Swarm A project on
    `https://github.com/Acme/App.git` (expect `acme/app`), Swarm B second project on GitLab and one with no address,
    Swarm C deleted (`deletedAt` set), Swarm D with a person's approval for its project, Swarm E with a `*` approval;
    expect `pairs` = A's and B's GitHub project only, `alreadyApproved: 2`, `written: 0`, and the approval row count
    unchanged.
  - `with apply, approves exactly those pairs once, marked as granted by the migration, and a second run writes nothing`:
    rows have `approvedBy: GRANDFATHERED_BY`, `githubLogin: ''`, project scope; D's row keeps its person; second run
    `pairs: []`, `written: 0`.
  - `grandfathered rows never read as the reader's push access`: `new PrismaApprovals(db).reader(...)` for the Swarm
    owner → `null`; `approved(...)` → `true`.
  - `lists a single-row Swarm as skipped`: a `SuperTab` row with `format: 1` → in `skipped`.
  - `the script prints the dry run and writes nothing; it refuses unknown arguments`: run via `node_modules/.bin/tsx`
    with `DATABASE_URL` = the test URI; stdout JSON has the pairs and the dry-run line; `--bogus` exits 2.
- [ ] **Step 2: Run, verify red**: `npm run test:super-tabs -- integration/superTabGithubCurrentApprovals.test.ts`
  Expected: FAIL, module `../src/github/currentApprovals.js` not found.
- [ ] **Step 3: Commit the red tests.**
- [ ] **Step 4: Implement** `approveCurrentPairs`: `superTab.findMany({ select: { id, autonomousEnv, format, deletedAt } })`;
  `format !== 2` → `skipped`; deleted → left out; heads by `swarmHead.aggregateRaw` (`key: 'head'`, `deleted: false`,
  `tabId ∈ live`, project `tabId`, `projects.id`, `projects.repository.repositoryUrl`, `project.repositoryUrl` for a head
  without `projects`, as `projectsOf` reads it); skip addresses `githubRepository` rejects; one `findMany` of existing
  approvals for those tabs to count `alreadyApproved` (project or `*`); with `apply`, `upsert` each pair with
  `update: {}` so a person's row is never changed. Script mirrors `scripts/swarm-instructions/migrate.ts`.
- [ ] **Step 5: Run green**, then `npm run typecheck`.
- [ ] **Step 6: Commit.**

### Task 3: Before Ready

- [ ] `npm test` (backend unit), the full Super Tab integration suite (`npm run test:super-tabs`), `npm run typecheck`.
- [ ] Red/green evidence (the red commits' failures, the green runs) as a PR comment; mark Ready; two Reviewers by Routing
  for two independent security reviews.

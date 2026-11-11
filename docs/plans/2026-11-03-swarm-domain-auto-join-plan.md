# Swarm domain auto-join Implementation Plan

> **How this plan runs:** by this project's instructions (Engineer role): the Engineer implements it task by task, test
> first (failing test committed, watched failing, then the code), and the pull request's Review step is the one
> independent review. Tasks 1–5 (backend) and Task 6 (Desktop) share no files; Task 6 runs in parallel by its own
> subagent against the API contract below. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A person signed in at the owner's email domain is joined, with no click, to every Swarm whose owner turned on
"Add them automatically"; nobody at a public domain ever is; a person who left is never pulled back.

**Architecture:** The setting lives in `state.sharing.access` (head part). Two derived columns on the `SuperTab` row,
`autoJoinDomain` and `autoJoinDeclined`, come from `indexesOf(state)` (parts/commit.ts), so they are written in the same
guarded row update as `memberIds` by every commit that changes them; one named index `[autonomousEnv, autoJoinDomain]`
serves the pull. `autoJoin(user)` (superTabs/autoJoin.ts) runs before both list reads, at most once per person per
2 minutes (Redis `SET NX PX`), and joins each match through `SuperTabStore.autoJoinSwarm`, one transaction per Swarm,
as the person.

**Tech Stack:** Fastify + Prisma (MongoDB) + Redis (ioredis) backend, vitest integration suite on mongodb-memory-server;
Flutter Desktop with widget tests.

**Spec:** `docs/specs/2026-11-03-swarm-domain-auto-join.md`

## Global Constraints

- Error codes: `PUBLIC_DOMAIN` (400) on save at a public domain; `DOMAIN_NOT_YOURS` (400) only when `autoJoin: true`
  names a domain other than the saving owner's `emailDomain(AuthUser.email)`; a link/domain join at a public domain
  answers `JOIN_UNAVAILABLE` (404) as any unavailable join does.
- `autoJoin` absent in a save keeps the saved value (same domain); `false` turns it off; any mode other than `domain`
  clears it.
- Try each person at most every **2 minutes** (`AUTO_JOIN_EVERY_MS = 120_000`), key written before trying; Redis down
  means try. **Limit 10** Swarms per try. **Cap 200** people per Swarm.
- Auto-join gives Workspace role **guest** (an active Workspace member keeps theirs) and the Swarm role the owner picked;
  marks `joinedVia: 'domain'` on the person. A team session never joins.
- Desktop copy, verbatim (owner `ken@acme.com`): option **"Everyone at @acme.com"**, **"Other domain…"**, toggle
  **"Add them automatically"** with **"Anyone who signs in with an @acme.com email joins this Swarm. You can remove
  anyone."**; **"Automatic joins work only for @acme.com, your own domain. People at partner.com join with the link."**;
  **"Not available for @gmail.com: anyone can make an address there. Invite people or share a link."**;
  **"Joined with @acme.com"**; **"Sharing with @gmail.com was turned off: anyone can make an address there."**;
  **"Automatic joins stopped: this Swarm has 200 people."**; leave dialog **"You won't be added back automatically. Ask
  the owner to invite you if you want to return."**
- No feature switch. Swarm code stays out of `cli/src/core`. Desktop tests never sign the real CLI out (memory store,
  fake sign-in).

## API contract (backend ↔ Desktop)

- `GET/POST /api/super-tabs/:tabId/sharing` answer
  `{ revision, access, joinUrl, ownDomain: string|null, ownDomainPublic: boolean, autoJoinFull: boolean, turnedOffDomain?: string }`.
  `access` for `domain` is `{ mode: 'domain', role, domain, autoJoin: boolean }`. A saved share at a public domain
  answers `access: { mode: 'invited', role }` with `turnedOffDomain: '<domain>'`.
- The save body's `access` for `domain` takes optional `autoJoin: boolean`.
- Swarm read: the head part's data carries `autoJoin: true` while auto-join is on (any member reads it); each member part
  may carry `joinedVia: 'domain'`.

## Review Focus

1. An old Desktop saves `domain` sharing for a *different* domain with no `autoJoin` field → auto-join turns off (the
   saved value is kept only for the same domain), never `DOMAIN_NOT_YOURS`. Test in Task 2.
2. The owner's email moved to another domain and they save with the field absent → kept value is dropped (auto-join only
   at the saver's own domain), no refusal. Test in Task 2.
3. A deleted Swarm with auto-join on → nobody joins (`autoJoinDomain` cleared on deletion). Test in Task 3.
4. A person auto-joined, then removed from the Workspace (the Workspace removal leaves each Swarm via `member.remove`)
   → declined, never rejoined. Test in Task 4.
5. Two list reads of the same person race on one Swarm → one membership, no error to either read. Test in Task 3.

---

### Task 1: Spec and plan (this commit)

- [x] Commit `docs/specs/2026-11-03-swarm-domain-auto-join.md` (with the "What exists today" fix) and this plan.

### Task 2: Domain checks and the `autoJoin` setting on save and join

**Files:**
- Modify: `backend/src/superTabs/sharing.ts` (schema, `configureSharing`, `sharingDetails`, `authorizeSwarmJoin`)
- Modify: `backend/src/superTabs/store.ts` (`sharing`, `saveSharing`: pass the user)
- Modify: `backend/src/lib/publicEmailDomains.ts` (add VN/Asian free providers)
- Test: `backend/integration/superTabAutoJoin.test.ts` (new), `backend/src/lib/publicEmailDomains.test.ts` if present

**Interfaces:**
- Produces: `generalAccessSchema` `domain` gains `autoJoin: z.boolean().optional()`;
  `configureSharing(previous, access, rotateLink, ownerEmail: string): SwarmSharing` (stored `access.autoJoin` only when
  true); `sharingDetails(state, ownerEmail: string)` returns the contract shape above;
  `autoJoinOn(state): string | null` (the domain while `mode==='domain' && autoJoin && !isPublicEmailDomain(domain)`).

- [ ] **Step 1: Write the failing tests** in `superTabAutoJoin.test.ts` (fixture as `superTabSharing.test.ts`; accounts at
  `acme.com`, `partner.com`, `gmail.com`):
  - `refuses a public domain on save`: gmail owner saves `{mode:'domain',domain:'gmail.com'}` → 400 `PUBLIC_DOMAIN`;
    acme owner saving `domain: 'outlook.com'` → `PUBLIC_DOMAIN`.
  - `refuses auto-join at another domain`: acme owner `{domain:'partner.com', autoJoin:true}` → 400 `DOMAIN_NOT_YOURS`;
    `{domain:'partner.com'}` → 200, `access.autoJoin === false`, and a `partner.com` person's `POST join` → 200.
  - `keeps, turns off and clears autoJoin`: save `{domain:'acme.com', autoJoin:true}`; save `{domain:'acme.com',
    role:'viewer'}` → `autoJoin` still true; save `autoJoin:false` → false; on again, then `{mode:'link'}` → details
    have no `autoJoin`, row `autoJoinDomain === null`; back to `domain` with no field → false. Review Focus 1 and 2.
  - `turns off an old public-domain share`: write `state.sharing.access = {mode:'domain',domain:'gmail.com'}` directly
    (saveState) → a gmail person's `POST join` → 404 `JOIN_UNAVAILABLE`; owner's `GET sharing` →
    `access.mode === 'invited'`, `turnedOffDomain === 'gmail.com'`.
  - `tells the dialog the owner's domain`: acme owner `ownDomain 'acme.com', ownDomainPublic false`; gmail owner
    `ownDomainPublic true`.
- [ ] **Step 2:** Run `cd backend && NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=<package.json key> npx vitest run -c vitest.super-tabs.config.ts integration/superTabAutoJoin.test.ts` → FAIL (no codes, no fields).
- [ ] **Step 3:** Implement. Save: `PUBLIC_DOMAIN` before `DOMAIN_NOT_YOURS`; kept value = previous `autoJoin` when
  previous was `domain` at the same domain and that domain is the saver's own. Join: `authorizeSwarmJoin` refuses a
  public `access.domain`. Public list adds: free consumer providers common in Vietnam and Asia
  (Zing, VNN, FPT mail, Rediff and others; the exact list is in the commit).
- [ ] **Step 4:** Re-run → PASS; run `integration/superTabSharing.test.ts` → still PASS.
- [ ] **Step 5:** Commit test, then code.

### Task 3: Row fields, index and the pull join on list reads

**Files:**
- Modify: `backend/prisma/schema.prisma` (`SuperTab.autoJoinDomain String?`, `autoJoinDeclined String[]`,
  `@@index([autonomousEnv, autoJoinDomain])`)
- Modify: `backend/src/superTabs/parts/commit.ts` (`indexesOf`), `backend/src/superTabs/parts/indexed.ts`
  (`NAMED_INDEX.SuperTab.autoJoin`), `backend/src/superTabs/model.ts` (`Person.joinedVia?: 'domain'`,
  `SuperTabState.autoJoinDeclined?: string[]`, stripped in `visibleState`)
- Create: `backend/src/superTabs/autoJoin.ts`
- Modify: `backend/src/superTabs/store.ts` (`autoJoinSwarm`, `workspaceList`, hook `autoJoins`),
  `backend/src/superTabs/read/service.ts` (`list`), `backend/src/routes/superTabs.ts` (Redis memory wiring)
- Test: `backend/integration/superTabAutoJoin.test.ts`, `backend/src/superTabs/autoJoin.test.ts`

**Interfaces:**
- Produces (autoJoin.ts): `AUTO_JOIN_EVERY_MS = 120_000`, `AUTO_JOIN_LIMIT = 10`, `AUTO_JOIN_CAP = 200`;
  `interface AutoJoinMemory { claim(key: string): Promise<boolean> }`; `redisAutoJoinMemory(redis)` (`SET
  swarm:auto-join:<env>:<sub> 1 PX 120000 NX`); `localAutoJoinMemory(now)`;
  `autoJoin(store: SuperTabStore, user: AuthUser): Promise<string[]>` (joined tab ids; never throws).
- Produces (store.ts): `autoJoinSwarm(user, tabId): Promise<'joined' | 'skipped' | 'declined'>` — in one transaction:
  sharing still on at the person's domain, person not declined and not a member, `people.length < 200`; Workspace guest
  (an active member keeps theirs; `WORKSPACE_ACCESS_REVOKED` → `'declined'` written in its own transaction); person
  pushed with the sharing role, `joinedVia: 'domain'`, a fresh generation; touches the head. Logs
  `[super-tab] auto-join` with `tabId`, `userId`, `people`.
- `indexesOf(state)` adds `autoJoinDomain: deletion ? null : autoJoinOn(state)`,
  `autoJoinDeclined: state.autoJoinDeclined ?? []`.

- [ ] **Step 1: Write the failing tests:**
  - `joins x@acme.com to auto-join Swarms on /list`: three acme Swarms (auto-join on as viewer; domain without
    auto-join; invite-only) → `GET /list` as `x@acme.com` lists only the first; its member part has `role 'viewer'`,
    `joinedVia 'domain'`; `swarmWorkspaceMember` role `guest`.
  - `joins nobody at a public domain`: `x@gmail.com`, `y@privaterelay.appleid.com` → nothing joined, no Swarm read.
  - `joins through /workspaces too`.
  - `keeps an existing Workspace member's role`: person already `member` of the owner's Workspace → joined, still
    `member`.
  - `ten per try`: 11 Swarms waiting → first read joins 10; within 2 minutes no try; after the clock passes 2 minutes
    the 11th joins.
  - `team session never joins`: list as `harnessSessionKind: 'team'` → 403 and no membership.
  - `turning auto-join off racing a join`: run `saveSharing(autoJoin:false)` and `autoJoinSwarm` concurrently N times →
    whenever the save committed first, no membership; never a member after a later off with joinedAt after it.
  - `stops at 200 people`: Swarm with 200 people → skipped; `sharing` answers `autoJoinFull: true`.
  - `deleted Swarm joins nobody` (Review Focus 3); `two racing reads, one membership` (Review Focus 5).
  - Unit (`autoJoin.test.ts`): memory `claim` false → no query; memory throws → tries; one Swarm's join throws → the
    others still join and `autoJoin` resolves.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement as the Interfaces say. The pull: `readBy(db, 'SuperTab', 'autoJoin', [{ $match: {
  autonomousEnv, autoJoinDomain: domain, deletedAt: null, memberIds: { $ne: sub }, autoJoinDeclined: { $ne: sub } } },
  { $limit: 10 }, { $project: { _id: 1 } }])` — a raw pipeline, so no Prisma `has`/`in` filter and no new
  `hotFilters.allowed.json` entry (that list may only shrink). `SwarmReads.list` calls it only without `after`, after
  its team-session refusal.
- [ ] **Step 4:** Re-run → PASS; `npm test -- src/superTabs/hotFilters.test.ts src/superTabs/parts` → PASS.
- [ ] **Step 5:** Commit test, then code.

### Task 4: Leaving is final; re-invite and link join clear it

**Files:**
- Modify: `backend/src/superTabs/commands.ts` (`member.remove`, `invite.accept`), `backend/src/superTabs/store.ts`
  (`join` clears the decline)
- Test: `backend/integration/superTabAutoJoin.test.ts`

- [ ] **Step 1: Write the failing tests:** leave, advance 2 min, read → not rejoined, row `autoJoinDeclined` holds them;
  removed by the owner → same; invited again and accepted → `autoJoinDeclined` no longer holds them; link join after
  leaving → cleared; removed from the Workspace (`WORKSPACE_ACCESS_REVOKED`) → not joined, declined, next read after
  2 min queries nothing for that Swarm; auto-joined then Workspace-removed → declined (Review Focus 4); declines kept
  across auto-join off and on.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `member.remove` adds `member.id` to `state.autoJoinDeclined` (set, kept sorted for stable writes);
  `invite.accept` and a `join` remove the person.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit test, then code.

### Task 5: Readers see `autoJoin` and `joinedVia`; pre-merge prod query

**Files:**
- Modify: `backend/src/superTabs/read/views.ts`, `backend/src/superTabs/read/contract.ts` (`HeadView.autoJoin?: true`)
- Create: `backend/scripts/publicDomainShares.ts` (read-only: count and ids of Swarms whose saved `domain` share is at
  a public domain; the PM runs it with the read-only login)
- Test: `backend/integration/superTabAutoJoin.test.ts`

- [ ] **Step 1: Failing test:** a member's first-load read has head `autoJoin: true` while on, absent when off; the
  joined person's member part has `joinedVia: 'domain'`; the head never carries `autoJoinDeclined` or `sharing`.
- [ ] **Step 2–5:** run → FAIL, implement, PASS, commit. Then the full Super Tab integration suite
  (`npm run test:super-tabs`) and `npm test`, `npm run typecheck`.

### Task 6: Desktop Share dialog and leave dialogs (parallel subagent)

**Files:**
- Modify: `desktop/lib/super_tabs/sharing.dart`, `desktop/lib/super_tabs/manage_page.dart` (leave dialog line), the
  Desktop model if members/head need the two fields
- Test: `desktop/test/super_tab_sharing_auto_join_test.dart` (new) and existing sharing tests

**Interfaces:** consumes the API contract above.

- [ ] **Step 1: Failing widget tests:** owner `ken@acme.com` sees "Everyone at @acme.com" with "Add them automatically"
  and its help line; saving sends `{mode:'domain',domain:'acme.com',autoJoin:true}`; "Other domain…" shows the typed
  field and disables the toggle with the partner copy; `ownDomainPublic` owner sees the option disabled with the gmail
  copy; `turnedOffDomain` shows "Invited people" and the turned-off note; `autoJoinFull` shows the 200 copy; a member
  with `joinedVia: 'domain'` shows "Joined with @acme.com"; both leave dialogs add the line when the head has
  `autoJoin: true`, and not otherwise.
- [ ] **Step 2:** `flutter test <file>` → FAIL.
- [ ] **Step 3:** Implement with the existing `AppSelectField`/dialog widgets (Harness design language, no new styles).
- [ ] **Step 4:** PASS; run the Desktop sharing/manage tests, `check-ui-style`, `laid_out_list_test`, `flutter analyze`.
- [ ] **Step 5:** Commit test, then code; golden-free screenshots of the dialog states for the PR.

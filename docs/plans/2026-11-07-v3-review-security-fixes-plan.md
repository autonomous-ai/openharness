# v3 Review Security Fixes Implementation Plan

> Task #4216. Written by the writing-plans skill as this project's Engineer works: one Engineer implements it task by task,
> test first, and the pull request's review is the one independent review.

**Goal:** Close the three findings of anh Dee's Buddy's review of main 0413586e that hold up when checked: a guest reading
the owner's Claude and Codex allowances, a Can chat grant or decider seat coming back when a person rejoins, and Stripe,
GitLab and npm tokens passing the chat's credential filter.

**Architecture:** Each fix sits where the rule already lives: the guest's default-deny list (cli/src/core/guestPolicy.ts),
the Swarm's join and leave hooks that already settle project owners (backend/src/superTabs/projects.ts admitPerson and
dismissPeople), and the credential rules (backend/src/superTabs/credentials.ts RULES).

**Tech Stack:** TypeScript, vitest.

**Spec:** the task brief (#4216). Verified on main 0413586e, 2026-11-07:

1. guestPolicy.ts:22 is real. `usage_read` is in the guest's ANY list, and services/usage.ts answers its default reading
   (this machine's Claude and Codex allowances, with their account key) to any asker. Its reason, "a guest's harness uses
   the owner's subscription through the relay", is gone: since 2026-11-07 a guest's harness runs on the guest's own sign-in
   and nothing spends the owner's subscription (lib/guestPaneCommand.ts, anh Dee).
2. boardRights.ts:28 is real. `project.canChat` and `project.decider` hold a bare person id. Leaving the Swarm
   (dismissPeople) leaves both as they are, and `readsProject` is true for any member of a public project, so a person
   removed and invited back has Can chat and the decider's P0 and pause rights again, though owning (ownsProject) and
   listed membership (canReadProject) already end with the membership.
3. credentials.ts:105 is real. No rule matches a Stripe key (`sk_live_…`: the OpenAI rule needs `sk-`), a GitLab token
   (`glpat-…`) or an npm token (`npm_…`), so each is stored as pasted.

## Global Constraints

- Test first: each failing test is its own commit before the code that passes it.
- Never read or print a secret or login: every token in a test is built at run time from fake parts (credentials.test.ts `noise`).
- Contracts only extend: a new credential kind adds a label; no client parses the kind (checked: no Dart or TS client reads
  `credentialsRemoved` kinds).
- No setting, no switch.

## Review Focus

1. A rejoining person's stale grant from before this fix (left before it shipped): cleared when they are admitted again.
2. A grant of someone who is still in the Swarm survives another person leaving or joining.
3. The credential filter takes no ordinary text: a docs placeholder (a Stripe prefix then one letter repeated) and prose that only
   names `npm_config_` variables or `glpat-` stay.
4. A guest's refused `usage_read` says so (GUEST_NOT_ALLOWED with its message), never a silent drop.
5. The owner's own apps and local callers still read usage (superTabs/start.ts inspectCapacity, machines.ts).

---

### Task 1: A guest no longer reads the owner's allowances

**Files:**
- Modify: `cli/src/core/guestPolicy.ts:21-22` (drop `usage_read` from ANY)
- Modify: `cli/src/services/usage.ts:77-78` (the comment that says the default reading is open to guests)
- Test: `cli/src/core/guestPolicy.spec.ts`, `cli/src/backendSocket.guest.spec.ts`

- [ ] **Step 1: Failing tests.** guestPolicy.spec.ts: `verdict('usage_read')` is `{ allow: false, error: 'GUEST_NOT_ALLOWED' }`,
  and `usage_read` leaves the allowed list. backendSocket.guest.spec.ts: a guest's `usage_read` never reaches the service
  router and is answered GUEST_NOT_ALLOWED; the "may ask what is allowed" case uses `guest_folders` instead.
- [ ] **Step 2: Run** `npx vitest run src/core/guestPolicy.spec.ts src/backendSocket.guest.spec.ts` in cli: FAIL on the new asserts.
- [ ] **Step 3: Code.** Remove `usage_read` and its comment from ANY; usage.ts comment says only the owner reads a profile's account.
- [ ] **Step 4: Run** the same: PASS. Then `npm run test:core` (CLI coverage gate for core/ and services/).
- [ ] **Step 5: Commit** test, then code.

### Task 2: Board rights end with the membership

**Files:**
- Modify: `backend/src/superTabs/projects.ts` (admitPerson, dismissPeople; new `settleBoardRights`)
- Test: `backend/src/superTabs/boardRights.test.ts`

**Interfaces:**
- Produces: `settleBoardRights(state: SuperTabState): void` in projects.ts — drops from every project's `canChat` and
  `decider` each id not in `state.people`, deleting an empty `canChat`. Called by dismissPeople after the people go and by
  admitPerson before the person is added (which clears a grant left from before this fix).

- [ ] **Step 1: Failing test** in boardRights.test.ts, "a person who leaves and is invited back gets no Board right back":
  boardFixture, switch on, grant `c` Can chat, name `d` decider; `member.remove` both (Swarm owner); `canChat` and `decider`
  are gone from the project; invite and accept each again; `canChat(state, project, 'c')` and `steers(state, project, 'd')`
  are false, and `c` posting in the project chat is refused CHAT_NOT_ALLOWED. A second case: a grant written before the fix
  (state edited so `c` left with the grant kept) is cleared when `c` is admitted again. A third: `c`'s grant stays when `d` leaves.
- [ ] **Step 2: Run** `npx vitest run src/superTabs/boardRights.test.ts` in backend: FAIL.
- [ ] **Step 3: Code** `settleBoardRights` and its two calls.
- [ ] **Step 4: Run** the same and `src/superTabs/projectOwners.test.ts`: PASS.
- [ ] **Step 5: Commit** test, then code.

### Task 3: Stripe, GitLab and npm tokens are removed

**Files:**
- Modify: `backend/src/superTabs/credentials.ts` (CredentialKind, CREDENTIAL_LABELS, RULES)
- Test: `backend/src/superTabs/credentials.test.ts`

**Interfaces:**
- Produces: kinds `'stripe'` ("Stripe secret key"), `'gitlab'` ("GitLab token"), `'npm'` ("npm token").

Formats (the vendors' documented prefixes, one rule each, same boundaries and `random` check as the GitHub rule):
- Stripe: `(?:sk|rk)_(?:live|test)_` then 24 or more letters and digits (secret and restricted keys).
- GitLab: `gl(?:pat|oas|dt|rt|rtr|cbt|ptt|ft|imt|agent|soat|ffct)-` then 20 or more of `[A-Za-z0-9_-]`, with the routable
  suffix `.xx.yyyyyyyyy` of new tokens included when present.
- npm: `npm_` then 36 letters and digits.

- [ ] **Step 1: Failing tests.** Add to the "every kind it removes" table: a live and a test Stripe secret key, a Stripe
  restricted key, a GitLab personal access token, a routable GitLab token, a GitLab deploy token, an npm token. Add to the
  ordinary texts: a Stripe live prefix followed by a run of one repeated letter (built at run time), `npm_config_registry=https://registry.npmjs.org`, "set your glpat- token".
- [ ] **Step 2: Run** `npx vitest run src/superTabs/credentials.test.ts` in backend: FAIL on the new kinds.
- [ ] **Step 3: Code** the three kinds, labels and rules.
- [ ] **Step 4: Run** the same and the credential cases of `src/superTabs/commands.test.ts`: PASS.
- [ ] **Step 5: Commit** test, then code.

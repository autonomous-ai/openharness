# People at the owner's email domain join a Swarm by themselves

Status: spec for Ken's confirmation · 2026-11-03 · requested by Ken.
Builds on Swarm sharing (`backend/src/superTabs/sharing.ts`, `desktop/lib/super_tabs/sharing.dart`) and Workspaces
(`docs/plans/2026-10-27-swarm-workspaces.md`).

## Why

Ken: someone who signs in with their company email should land in the company's Swarms without an invitation, the way
Slack lets "anyone with an @acme.com email" into a workspace. Slack still asks for one click ("Workspaces you can
join"); Ken wants no click at all.

Ken's decisions (2026-11-03):

- **Per Swarm, owner's choice.** A person joins only the Swarms whose owner turned it on, not every Swarm of the company.
- **No click.** The Swarm is simply in their sidebar the next time their app reads its list.
- **The account's email is the only trust signal**, for Google, Apple and emailed-code sign-in alike, as the SSO gives
  it. No Google-only limit and no DNS proof of the domain: people must be able to use it (Ken, after River's review:
  "lam phai user xai dc"). The SSO profile carries no verified flag; asking the SSO owner to confirm every path checks
  the mailbox is a follow-up, not a blocker.
- **Workspace role: Guest** (River's review, 2026-11-03). Most Swarms live in their owner's personal Workspace; Member
  would also open the owner's other Workspace-open Swarms, the Workspace people list and Swarm creation there. Inside
  the Swarm a guest works as any member with the Swarm role the owner picked. A Workspace-level switch later can give
  Member.

Done when: a person who signs in as `x@acme.com` finds every acme Swarm with auto-join on in their list, with no
invitation, link or click; nobody at a public email domain is ever let in by domain; a person who left is not pulled
back; old apps see the joined Swarm; two independent security reviews passed; merged.

## Goals, non-goals, anti-goals

- **Goal:** zero-step join for colleagues, turned on per Swarm by its owner in the Share dialog that exists today.
- **Non-goal:** one switch for a whole company or Workspace (no client has Workspace screens yet). The pull join, the
  domain rules and the declines below are what a Workspace-level switch would reuse later.
- **Non-goal:** removing people whose company account was closed. The backend is not told (see Known limits).
- **Anti-goal:** a stranger gets in because a domain looked like a company's. That is a failure even if everything else
  works.
- **Anti-goal:** someone who left keeps reappearing in the Swarm.

## What exists today (main 8c3469058)

- **Swarm sharing** (`sharing.ts`): General access is `invited`, `domain` (`{ role, domain }`) or `link`. With `domain`,
  anyone signed in at that domain **who has the link** `harness://swarm/join/<id>` joins with `POST
  /api/super-tabs/:tabId/join` (`store.join`). That join adds them to the Swarm's Workspace as **guest**
  (`store.ts:1135`), refuses someone the Workspace removed (`WORKSPACE_ACCESS_REVOKED`), and keeps an existing member's
  role.
- The sharing setting lives in the head part's JSON (`state.sharing`). It cannot be queried by domain.
- Nothing checks the domain. The owner types it (`sharing.dart`, prefilled from their own email). `gmail.com` or another
  company's domain is accepted. Machine sharing already refuses both (`routes/machineShares.ts:132`,
  `isPublicEmailDomain`).
- **Sign-in** goes through Autonomous SSO (`lib/sso.ts`) with Google, Apple or an emailed code. The backend gets the SSO
  profile's email (`AuthUser.email`), with no verified flag (see Known limits). It gets no Google `hd` claim and does not know which method was used.
- **Public domains**: `lib/publicEmailDomains.ts`, a hand-kept list, already holding Apple's private relay
  (`privaterelay.appleid.com`) and `pending.harness.invalid`.
- **Lists** a client reads: `GET /api/super-tabs/list` (`SwarmReads.list` in `read/service.ts`, polled every few
  seconds; Swarms whose `SuperTab.memberIds` hold the person) and `GET /api/super-tabs/workspaces` (`listWorkspaces`).
  Desktop, phone and CLI read the first.
- **Leaving / removal**: the `member.remove` command, of oneself or by the owner (`commands.ts:2710`).

## Trust

| Sign-in | Email the backend sees | Joins by domain |
|---|---|---|
| Google, company account at acme.com | `x@acme.com` | yes |
| Google, personal Gmail | `x@gmail.com` | no: public domain |
| Apple, real email shared | `x@acme.com` | yes |
| Apple, Hide My Email | `…@privaterelay.appleid.com` | no: public domain. Needs an invitation |
| Emailed code | `x@acme.com` | yes |

A verified email proves the person reads that mailbox, not that the domain is a company's. The remaining risk is a free
mail provider missing from the public list. It is held by:

1. **Auto-join only at the owner's own domain.** The server takes it from the saving owner's `AuthUser.email`; turning
   auto-join on for any other domain is refused (`DOMAIN_NOT_YOURS`, 400). A `domain` share without auto-join (link
   needed) keeps any non-public domain, so sharing with a partner's domain keeps working as today.
2. **Never a public domain** (`PUBLIC_DOMAIN`, 400), checked on save and again on every join (`authorizeSwarmJoin`), so a
   domain added to the list later stops working at once.
3. **The owner turns it on by hand**, with plain words (Copy).
4. **The owner sees who came by domain** and can remove them; a removed person does not come back by domain.
5. **The public list grows** in the same PR by the free providers common in Vietnam and Asia (for example Zing, VNN,
   FPT mail, Rediff). The builder picks the exact list.

## The model

### Setting

- `GeneralAccess` `domain` gains `autoJoin?: boolean` (`sharing.ts`). Saved with the existing `POST
  /api/super-tabs/:tabId/sharing`, owner only, as today.
- Absent in a save means **keep the saved value**; only `false` turns it off. An older Desktop that saves sharing
  without the field therefore never turns it off by accident. Any mode other than `domain` clears it.
- Turning it off stops new joins. People who already joined stay.
- `sharingDetails` returns `autoJoin` so the dialog shows it.

### Index on the Swarm row

Two new fields on `SuperTab`, written in the same transaction as the sharing save (and kept by `commitParts` like
`memberIds`):

- `autoJoinDomain String?`: the domain while `mode === 'domain' && autoJoin`, otherwise absent.
- `autoJoinDeclined String[]`: user ids who must not be joined again (below).
- Index `[autonomousEnv, autoJoinDomain]`, registered in `hotFilters.allowed.json`.

The builder may instead keep these in a separate collection if the row layout argues for it; the query shape must stay
a single indexed read.

### When the join happens: on the person's own list read

`autoJoin(user)` (new, `superTabs/autoJoin.ts`) runs at the start of the list read clients poll every few seconds,
`SwarmReads.list` (`superTabs/read/service.ts`, first page only, no `after`), and of `workspaceList`, before the list is
built. Because that read is a poll, a person is tried at most once every **2 minutes** (a per-user Redis key with that
TTL, written before trying; Redis down means try, as other poll memories do). A join can therefore take up to 2 minutes
after the owner turns it on (my call).

1. `domain = emailDomain(user.email)`. Stop when it is none or public, or the session is a team session.
2. One indexed read: `SuperTab` where `autonomousEnv`, `autoJoinDomain = domain`, not deleted, `memberIds` does not hold
   `user.sub`, `autoJoinDeclined` does not hold `user.sub`; limit 10. More are joined on later reads.
3. For each, the existing join path with `{ operationId: stableId('auto-join', tabId, user.sub) }`. In that path, for an
   auto-join:
   - The Workspace role given is **guest**, as a link join gives. Someone already active in the Workspace keeps the role
     they have.
   - Someone the Workspace removed (`WORKSPACE_ACCESS_REVOKED`) is added to `autoJoinDeclined` instead, in its own small
     write, so the read stops finding the Swarm.
   - The Swarm role is the sharing role the owner picked (Can collaborate / Can view). An existing member keeps theirs.
   - The new person is marked `joinedVia: 'domain'` in `state.people`.
4. Each join is its own transaction. A failure is logged with `tabId` and `userId` and skipped; the list is answered
   anyway, including the Swarms that did join, and the rest are tried after the 2-minute key expires.
5. **Cap: 200 people per Swarm** (my call), the most a private project can name (`project.sharing` `memberIds` max 200).
   A Swarm at 200 is skipped by auto-join; invitations and links still work. The Share dialog shows
   **"Automatic joins stopped: this Swarm has 200 people."**

The person is joined as themselves (their own `AuthUser`), never by the owner or a machine.

### Leaving is final for auto-join

- `member.remove` (leaving, or removed by the owner) adds the person's id to `autoJoinDeclined` of that Swarm.
- An invitation accepted (`invite.accept`) or a link join removes it, so the person can come back on purpose.
- The list is kept across turning auto-join off and on; it goes with the Swarm.

### Old Swarm settings that break the new rules

A saved `domain` share at a public domain stops answering joins from this release. A share at a partner's domain is
unchanged. Before merging, a read-only prod query lists them (count and Swarm ids, in the PR); their owners are told. The
Share dialog shows such a Swarm as "Invited people" with a one-line note (Copy).

## Copy and screens (Desktop Share dialog, `desktop/lib/super_tabs/sharing.dart`)

Owner `ken@acme.com`:

```
General access
[ Everyone at @acme.com ▾ ]        ← was "Anyone at a domain" + a typed domain
[ Can collaborate ▾ ]

[■] Add them automatically
    Anyone who signs in with an @acme.com email joins
    this Swarm. You can remove anyone.
Private projects stay private.
```

- The option names the owner's domain by default. **Other domain…** keeps today's typed field for a partner; with a
  typed domain the auto-join toggle is disabled with **"Automatic joins work only for @acme.com, your own domain.
  People at partner.com join with the link."**
- Owner at a public domain: the option is shown disabled, with
  **"Not available for @gmail.com: anyone can make an address there. Invite people or share a link."**
- People list: under each person who came by domain, a quiet **"Joined with @acme.com"**.
- Old setting that broke the rules: **"Sharing with @gmail.com was turned off: anyone can make an address there."**
- Leave dialog, in a Swarm with auto-join on (the member read carries `autoJoin: true` for this): add
  **"You won't be added back automatically. Ask the owner to invite you if you want to return."**
- The person who joins sees no notice: the Swarm is in their sidebar.

Phone: nothing to build; the joined Swarm appears in Swarm Home through its list read. CLI: nothing to build; `harness
super-tab` list reads trigger the join too. Web: no Share dialog today; nothing to build.

## Design (docs/feature-design-rules.md)

1. **Growth.** `autoJoinDomain` is one field per Swarm, cleared with the setting. `autoJoinDeclined` grows by one id per
   person who left or was removed, shrinks on a re-invite, and goes with the Swarm's purge. A Swarm with 1,000 leaves
   holds about 25 KB on its row; review if a row passes 1,000 entries.
2. **Concurrency.** Each join is today's join transaction on the Swarm head, so a join racing a sharing change or a
   removal conflicts and retries, as today. Two list reads of the same person racing use the same stable operation id;
   the second finds the member and writes nothing. A decline write and a join of the same person race on the same row:
   the join reads `autoJoinDeclined` inside its transaction and stops if it is there.
3. **Read cost.** Per first-page list poll: one Redis get. At most every 2 minutes per person: one indexed read that
   usually matches nothing (no `$or`, no scan). Public domains skip both. Writes happen only when there is someone to
   join.
4. **Scale.** Today: about 6 people per Swarm. At 10x, 60. A company Swarm with auto-join could reach every employee:
   the metric that warns first is people per Swarm (every read and fan-out of that Swarm grows with it). Log it on each
   auto-join; review when one Swarm passes 100.
5. **Compatibility.** Joins happen on the server in reads every app already makes, so old Desktop, phone and CLI see the
   Swarm. An old Desktop cannot turn auto-join on and, by the "absent keeps" rule, cannot turn it off by saving. An old
   Desktop that types a public domain, or turns nothing on, gets the server's refusal message, which it already shows.
6. **Migration and rollback.** No data migration: new fields default to absent. Rollback to an older backend ignores the
   fields; joined people stay ordinary members; domain shares at a public domain start answering again (the
   pre-merge list says which).
7. **Audience.** Server-enforced: the domain comes from the owner's token, the join from the joiner's token; the public
   list is checked on save and on join; reading a Swarm still needs its membership; private projects stay private.
8. **Identity.** Every join acts as the joining person. Nothing acts as the owner.
9. **Failure.** A join that fails is logged with ids and tried again on the next read, while the list is still answered.
   Refused saves say why (`PUBLIC_DOMAIN`, `DOMAIN_NOT_YOURS`). A share turned off by the new rules says so in the dialog.
10. **Platforms.** Backend does the work; Desktop changes the Share dialog and the leave dialog; phone, CLI and web need
    nothing.

## Known limits

- A person who leaves the company stays in the Swarm until the owner removes them: the SSO does not say when a company
  account is closed. They can no longer sign in once their company deletes the account.
- A person whose email changes to another domain keeps what they joined, and joins the new domain's Swarms only once
  their token carries the new email.
- The owner's own domain is read at save time. If the owner's email later changes domain, the saved domain stays until
  the owner saves sharing again.

- An account whose SSO email was never checked against its mailbox could claim a company address and be joined. The
  owner sees "Joined with @acme.com" and removes them; the SSO owner is asked to confirm every sign-in path verifies
  the email (follow-up).

## Release gates (River's review)

- **Two independent security reviews**, since this changes who can reach a Swarm.
- **Ken's go before the backend release**: the release builds the new `[autonomousEnv, autoJoinDomain]` index on the
  production `SuperTab` collection.

## Build order (reviewable PRs)

1. Backend: the domain checks on save and join, `autoJoin` in sharing, the row fields and index, `autoJoin(user)` on
   both list reads, Workspace guest role for auto-joins, `joinedVia`, declines on `member.remove` and their removal on
   re-invite or link join, public list additions, the pre-merge prod query. Integration tests below.
2. Desktop: Share dialog option and toggle, disabled state, "Joined with" label, leave dialog line.

## Tests that fail first

- `x@acme.com` reads `/list` → is a member of the acme Swarm with auto-join on (Workspace **guest**, Swarm role the owner
  picked, `joinedVia: 'domain'`); not of an acme Swarm with `domain` sharing but auto-join off; not of an invite-only one.
- `x@gmail.com`, `…@privaterelay.appleid.com`: nothing joined. A gmail owner saving `domain` → `PUBLIC_DOMAIN`; an acme
  owner turning auto-join on for `partner.com` → `DOMAIN_NOT_YOURS`; saving `partner.com` without auto-join → accepted, link join works.
- A saved share at `gmail.com` (written directly) → link join answers `JOIN_UNAVAILABLE`.
- Leave, read again → not rejoined. Removed by the owner, read again → not rejoined. Invited again and accepted →
  `autoJoinDeclined` no longer holds them.
- Removed from the Workspace → not joined, added to `autoJoinDeclined`, next read does not try again.
- Someone already a Workspace member → joined to the Swarm, stays member.
- Saving sharing without `autoJoin` keeps it on; `false` turns it off; mode `link` clears it and `autoJoinDomain`.
- Turning auto-join off racing a join → no membership written after the turn-off commits.
- 11 Swarms waiting → 10 joined on the first read, the 11th on the next.
- Team session list read → no join.

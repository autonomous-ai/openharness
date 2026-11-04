# Account Profile (name and @username) Implementation Plan

> Written by the Engineer of task #2654 by the project's way of working (docs/plans, test first, one pull request,
> one independent review on it). No subagent-driven-development and no execution handoff: the Engineer implements it.

**Goal:** A signed-in person changes their own account name, and their @username in the Swarm they are in, from one
Profile sheet in the avatar menu (and from Settings ▸ Account), so nobody edits the production database by hand again.

**Architecture:** The backend gets `PATCH /api/auth/me` (`{ name }`), which writes only the caller's own `User.name`
after validation and answers the same body `GET /api/auth/me` does. The CLI daemon proxies that route for Desktop like
the other account routes; the web build calls the backend directly. Desktop's new Profile sheet saves the account name
through it, and in the open Swarm saves the same name as the Swarm name (`member.name`) and the username
(`member.username`) through the existing commands and their rules (River's choice A, 2026-11-04: no user-table read
on Swarm loads). Swarm lists show the Swarm name, so they show the new name at once.

**Tech Stack:** Fastify + Prisma (MongoDB), vitest; Node CLI daemon (`cli/src/hookServer.ts`), vitest; Flutter
Desktop/web, flutter_test widget tests with a memory store and a fake sign-in.

**Spec:** task #2654 brief (conversation 7bcaebbaee8b75c294a41dcb), quoted in the pull request.

## Global Constraints

- Name: trimmed, tabs and space runs folded to one space, NFC, 1–60 characters (code points), no control, format
  (invisible, bidi), line or paragraph separator characters; empty is refused. Error: 400 `INVALID_NAME`
  "Use 1 to 60 characters, with no hidden ones."
- Only the caller's own row: no user id anywhere in the request. A Team machine sign-in is refused (403, by the
  existing team allowlist).
- `GET /api/auth/me` returns the new name on the next read; the PATCH answers `{ user, avatarUrl: null, description: null }`.
- One flat sheet titled "Profile": Name, Username (`@` prefix, "in <Swarm>"), Cancel, Save. No explanatory sentences.
  Errors in one short line under their field.
- Username row only when a Swarm is open and the reader is a member of it.
- No schema change, no new collection, no new index.
- Desktop tests: memory store and fake sign-in; never the real CLI logout.
- Swarm code stays out of `cli/src/core` (the proxy wiring line in `cli/src/core/main.ts` is account, not Swarm, code).

## Review Focus

1. A name of spaces only, or with a zero-width / bidi character → refused, nothing written (backend test).
2. A 60-character name in an emoji-heavy script → accepted; 61 → refused (counted by code points; backend test).
3. A username taken in this Swarm → the account name may already be saved; the sheet stays open, says why under
   Username, and a second Save sends only what is still different (widget test).
4. An older CLI daemon without the PATCH route (404) → the sheet says "Update Harness to change your name." and keeps
   the typed name (widget test).
5. A Swarm name clash (another member already shows that name) → the sheet says why under Name; the account name
   stays saved (widget test).

## Design

- growth: N/A because it updates one field of an existing row; nothing new is stored.
- concurrency: one `prisma.user.update` by id; last write wins, the person is the only writer of their own name.
- read cost: no new read on any hot path; Swarm loads read no user rows (choice A).
- scale: 10x people changing names is a handful of writes a day; the metric that warns first is none needed.
- compatibility: old Desktop never calls the route; new Desktop on an old daemon gets 404 and says to update Harness;
  old backend answers 404 to the web the same way.
- migration + rollback: none; rolling back removes the route, stored names stay valid.
- audience: the server takes the user from the session, never from the request.
- identity: the caller's own session; a Team session (machine owner's login on a shared Mac) is refused.
- failure: every refusal is shown in the sheet in words.
- platforms: Desktop macOS/Linux/Windows through the daemon; web direct; phone in a follow-up task.

---

### Task 1: Backend: validate and save the caller's own account name

**Files:**
- Create: `backend/src/lib/accountName.ts`, `backend/src/lib/accountName.test.ts`
- Modify: `backend/src/routes/auth.ts` (next to `GET /api/auth/me`)
- Test: `backend/src/routes/authMe.test.ts`

**Interfaces:**
- Produces: `parseAccountName(input: unknown): { ok: true; name: string } | { ok: false }` and
  `MAX_ACCOUNT_NAME_LENGTH = 60`; `PATCH /api/auth/me` body `{ name: string }` → 200 `{ user, avatarUrl, description }`,
  400 `INVALID_NAME`, 404 `NOT_FOUND`.

- [ ] Step 1: failing tests. `accountName.test.ts`: `'  Elvis  '` → `Elvis`; `'Minh\t  Nguyen'` → `Minh Nguyen`;
  `''`, `'   '`, `42`, `null` refused; `'a​b'`, `'a‮b'`, `'a\nb'`, `'a\u0007b'` refused; 60 `'😀'` accepted, 61
  refused. `authMe.test.ts` (real middleware and route, faked user store): PATCH as user u1 changes only u1's row
  (u2 untouched, body `id`/`email`/`role` ignored); a following GET answers the new name; `'   '` → 400 `INVALID_NAME`
  and no write; no token → 401; a team session → 403 `TEAM_SESSION_LIMITED`.
- [ ] Step 2: run `npm test -- src/lib/accountName.test.ts src/routes/authMe.test.ts`; expect failures (module and route missing).
- [ ] Step 3: implement `parseAccountName` (reuse `printable` from `superTabs/profile.ts`), the route with
  `userService.update(req.user!.sub, { name })`.
- [ ] Step 4: rerun; PASS. Also `npm test -- src/lib/teamSession.test.ts` (route table pin).
- [ ] Step 5: commit tests first, then code.

### Task 2: CLI daemon: proxy `PATCH /api/auth/me`

**Files:**
- Modify: `cli/src/hookServer.ts` (handler `onAuthMeUpdate?: (body: unknown) => Promise<PairOutcome>`, route next to
  `GET /api/auth/me`, CSRF-guarded by `x-adapter-local` like the desk's ops), `cli/src/core/main.ts` (wire
  `proxyBackend('PATCH', '/api/auth/me', body)`)
- Test: `cli/src/hookServer.spec.ts`

- [ ] Step 1: failing test: without the local header → 403 and handler not called; with it → body passed through and
  the backend's answer returned; bad JSON → 400.
- [ ] Step 2: run `npx vitest run src/hookServer.spec.ts`; FAIL (404).
- [ ] Step 3: implement. Step 4: rerun; PASS. Step 5: commit test, then code.

### Task 3: Desktop: the Profile sheet

**Files:**
- Create: `desktop/lib/widgets/account_profile_sheet.dart`, `desktop/test/account_profile_sheet_test.dart`
- Modify: `desktop/lib/api/api_client.dart` (`Future<Map<String, dynamic>?> updateMe({required String name})`),
  `desktop/lib/state/app_state.dart` (`Future<String?> setAccountName(String name)`: PATCH, set `currentUser` from the
  answer, keep it in the profile cache; answers the error line or null)

**Interfaces:**
- Produces: `Future<void> showAccountProfileSheet(BuildContext context, AppNotifier app)`; keys
  `account-profile-name`, `account-profile-username`, `account-profile-save`, `account-profile-name-error`,
  `account-profile-username-error`.
- Consumes: `SuperTabController.setName`, `setUsername` (`super_tabs/profile_actions.dart`), `app.activeSwarm.superTabId`,
  `app.superTabs.peek`.

- [ ] Step 1: failing widget tests: Save with both changed sends the account PATCH, then `member.name` and
  `member.username`, closes, and the avatar menu shows the new name; a taken username (409 `USERNAME_TAKEN`) keeps the
  sheet open with the server's words under Username; `'   '` shows the invalid-name line and sends nothing; 404 from
  the daemon shows "Update Harness to change your name."; no open Swarm → no Username row.
- [ ] Step 2: run `flutter test test/account_profile_sheet_test.dart`; FAIL.
- [ ] Step 3: implement on `DesktopPromptSurface` (Cancel, Save). Save sends only changed fields: account name, then
  Swarm name, then username; stops at the first refusal and shows it under its field.
- [ ] Step 4: rerun; PASS. Step 5: commit test, then code.

### Task 4: Desktop: open it from the avatar menu and Settings ▸ Account

**Files:**
- Modify: `desktop/lib/widgets/account_menu.dart` (`AccountMenuChoice.profile`, row "Profile" first),
  `desktop/lib/screens/swarm_screen.dart` (case opens the sheet), `desktop/lib/settings/sections/account_section.dart`
  (an Edit button beside the name opens the sheet)
- Test: `desktop/test/account_profile_sheet_test.dart`, `desktop/test/account_menu_version_test.dart`

- [ ] Step 1: failing tests: the avatar menu's Profile row opens the sheet; Settings ▸ Account's Edit opens it.
- [ ] Step 2: run; FAIL. Step 3: implement. Step 4: rerun with `test/settings_account_copy_test.dart`,
  `test/web_chrome_menus_test.dart`, `test/web/web_app_menu_test.dart`; PASS. Step 5: commit.

### Task 5: Evidence

- [ ] Light and dark screenshots of the sheet (golden-style screenshot test run, files attached to the PR).
- [ ] `python3 scripts/check-ui-style.py` and `flutter test test/laid_out_list_test.dart` (guard tests); `npm test` in
  backend; red/green evidence as a PR comment.

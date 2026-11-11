# Profile on the phone Implementation Plan

> **For agentic workers:** Written by the writing-plans skill as the project's instructions adapt it (Engineer role).
> The Engineer implements it task by task, test first, in this session; the pull request's Review step is the one
> independent review. No execution handoff.

**Goal:** From the phone's account row (its avatar, at the top of Settings), Profile opens a sheet where the person
changes their account Name (everywhere) and their @username in each Swarm they are in, with Desktop's words.

**Architecture:** `ApiClient.updateMe` sends `PATCH /api/auth/me` straight to the backend with the phone's sign-in (the
route #2917 added, which validates the name); `AppNotifier.setAccountName` shows the saved name at once and answers a
refusal in one line, as Desktop's does. The sheet (`phone/account_profile_dialog.dart`) is the phone's dialog look
(`widgets/rename_agent_dialog.dart`): Name, then one Username field per Swarm ("@name in Pilot") from the account's
Swarm inbox, through `SwarmProfile.setUsername` (`member.username`). Save sends only what changed, in order (name,
usernames, then a Swarm's own name where it followed the account name), stops at the first refusal and shows it under
its field. Settings' account sheet gets Profile above Sign out.

**Tech Stack:** Flutter (mobile), flutter_test, offscreen screenshots.

**Spec:** task #2655's brief; #2917's Desktop sheet (`desktop/lib/widgets/account_profile_sheet.dart`) and backend rule
(`backend/src/lib/accountName.ts`).

## Global Constraints

- Desktop's words: Profile, Name, Username, `in <Swarm>`, Cancel, Save; "Use 1 to 60 characters, with no hidden ones.",
  "Update Harness to change your name." (a backend from before the route), "Your name was not saved. Try again.".
- Mobile tokens and flat rows; light and dark screenshots; phone tests headless; never install on a phone.
- The per-Swarm "Your profile" sheet stays as it is (Tony's #2919 changes its row).

## Review Focus

- A name saved and a username refused: the name stays saved, the username's refusal shows under it, Save again sends
  only the username.
- An empty or too-long name is refused here, before any call.
- A Swarm the person may not rename in (access revoked) offers no Username field.
- A refusal from the backend is shown in its words, under the Name field.

## Design

N/A for storage: nothing new is stored; it calls the routes #2917 and the Swarm already serve. Failure: every refusal is
shown under its field; a call lost on the way says so.

### Task 1: The account name from the phone

**Files:** `lib/api/api_client.dart` (`updateMe`), `lib/state/app_state.dart` (`setAccountName`); test
`test/api/api_client_test.dart`, `test/phone_edge/account_profile_test.dart`.

- [ ] Failing tests: `updateMe` sends `PATCH /api/auth/me {name}`; `setAccountName` updates `currentUser`, answers a 400's
  message, and 404 as "Update Harness to change your name.".
- [ ] Implement; run.

### Task 2: The Profile sheet and its entry

**Files:** create `lib/phone/account_profile_dialog.dart`; modify `lib/phone/settings_page.dart`; test
`test/phone_edge/account_profile_test.dart`, screenshots.

- [ ] Failing widget tests: Profile above Sign out opens the sheet with the name; Save sends only what changed; empty
  name refused here; a refusal under its field; one Username per Swarm with `@` and `in <Swarm>`; a revoked Swarm offers
  none.
- [ ] Implement; run; light and dark screenshots.

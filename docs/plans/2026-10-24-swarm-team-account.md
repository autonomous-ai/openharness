# Swarm team account implementation plan

> **For agentic workers:** run each behaviour test red, implement, then verify green. Branch from current `main`; one PR per task.

**Goal:** A teammate's agents can work on my Mac without reading my personal data, and their commits never use my GitHub login. With both in place, a Swarm can pool every company machine's spare capacity safely.

**Why:** Company machines also hold personal mail, photos, browser sessions and personal accounts. In one live Swarm (6 people, 26 agents, 21–23 Oct 2026), 18 of 113 agent starts were one person's Lead starting an agent on another person's machine. Each ran as that machine's owner with full permissions: the owner's files, GitHub login and subscription. People asked which machine their work went to, asked for work on their own machine, and removed a machine from the Swarm.

**Decision:** a separate standard macOS user for team work, not a VM. It keeps native toolchains (Xcode, Flutter desktop), costs one admin password, and separates company work from personal data. A VM stays for a future public Swarm or jobs that need administrator rights.

## The experience

1. A person's Mac joins a Swarm. macOS asks once for an administrator password. There is no Harness setup screen.
2. Harness creates a hidden standard user, makes the owner's home folder private, and runs a second Harness daemon as that user. In the Swarm it is not a machine of its own: the Swarm's views show the Mac once (see **One machine**). Outside the Swarm, Harness lists it as its own machine, e.g. "MacBook Pro · Team", as before.
3. Teammates' work only runs on Team machines. The owner's own agents keep running as the owner, as today.
4. The owner approves Claude Code and Codex for team work once, in the browser. That is an explicit choice to share that subscription.
5. Agents push and open PRs with a Harness GitHub App token for that one repository. The machine owner's GitHub login is never used.

A machine used only for agents (a Mac mini, a Linux or Windows box) opts in as a whole with `harness team on`; it needs no second user.

## Findings that shape the design

- **Sign-in exists.** A signed-in computer can mint a one-time handoff code (`POST /api/auth/handoff`, 90 s, single use) that a new client redeems for its own session (`backend/src/lib/harnessSession.ts`).
- **Identity is per user.** The computer id lives in the daemon's data folder (`cli/src/config/env.ts`), so a daemon running as another user gets its own machine id.
- **A normal computer session is too strong.** The agent client reaches the account's other machines through the relay (`cli/src/agentClient/daemon.ts`, `machine_select`). A team daemon signed in as an ordinary computer would let a team agent run `harness ps --machine <owner's Mac>` or read the owner's personal harnesses. The team daemon needs its own session kind.
- **A second account alone is not private.** On macOS the home folder defaults to `drwxr-x---` with group `staff`, and every local account is in `staff`. Folders like `~/code` (755) and files like `~/.gitconfig` (644) are readable by any other local account. Setup must make the home folder `700` and prove it.
- **GitHub user tokens cannot be narrowed to one repository.** Installation tokens can (repository and permission scoped, one hour). Version one uses installation tokens and attributes the requester as GitHub's Copilot coding agent does: the PR is opened by the Harness app, assigned to the person who delegated, with that person as commit co-author. A "John via Harness" user-token mode can follow if wanted; it trades the one-repository limit for the attribution line.

## Constraints

- Never weaken an existing permission: a team session can do strictly less than a computer session.
- Never fall back to running a teammate's work as the machine owner when the team account is missing, failing its privacy check, or offline. Report it on the machine instead.
- Credentials stay out of chat and out of the team account where possible: no copying the owner's GitHub, Claude or Codex login into it.
- Tests use disposable data folders, disposable MongoDB and the fresh-Mac VM rig. Never create a user, change permissions or install a launchd job on a developer's own Mac in tests.
- Existing contributed machines keep their running agents. New cross-person starts follow the new rule; the release notes say so.

## Task 1: Team session kind (backend)

Files: `backend/src/lib/harnessSession.ts`, `backend/src/routes/auth.ts`, the relay's machine selection in `backend/src/lib/deviceWs.ts`/`bus.ts`, Super Tab host routes.

- [x] Tests: a team session cannot select another machine, list or attach the account's harnesses, mint a handoff, change account settings or sign phones in; it can run its own daemon, receive Swarm starts for its own machine and post as its Swarm agents.
- [x] Add `team` to `HarnessSessionKind`. A computer session mints a team handoff code; redeeming it creates a team session bound to the redeeming computer id.
- [x] Enforce the limits server-side in the relay and routes, not in the CLI.

How it works (`backend/src/lib/teamSession.ts` has the full list):

- **Minting.** `POST /api/auth/handoff` with `{ "kind": "team" }` from a computer session or an Autonomous sign-in returns `{ code, expiresIn, kind: "team" }` (90 s, single use; the code is `hnh_` plus 43 URL-safe characters). Without a body, or with `{ "kind": "viewer" }`, it mints a viewer code exactly as before, and the answer now also says `kind: "viewer"`. A team or phone session can never mint. `POST /api/auth/handoff/redeem` takes `{ code, label, computerId }` and returns `{ token, refreshToken, expiresIn, autonomousEnv, kind }`, where `kind` is `team` or `viewer`. A client should store a team sign-in only when the answer says `kind: "team"`. Any failure gets the same 401 `HANDOFF_INVALID`: a spent or expired code, a team code without a valid `computerId`, or a team code for a computer the account already runs under a normal sign-in. A team session may use `/api/auth/refresh` and `/api/auth/revoke` like any session.
- **A computer converting itself (`harness team on`).** `{ "kind": "team", "computerId": "<this computer>" }` asks for a code that turns that computer into a team machine and keeps its computer id, so its Swarm contributions and history survive. Only the computer itself may ask:
  - its own Harness computer session, whose recorded computer id matches (QR sign-ins record it from now on); or
  - any sign-in of the account, with `"proof": { "machineId", "at", "sig" }`. `sig` is base64 ed25519 over `teamConversionMessage(userId, computerId, machineId, at)` (`lib/teamSession.ts`), signed by that machine's key on the account's device key log. It must be within 5 minutes of the server's clock and is accepted once. This is the route for a computer signed in with Autonomous, whose sign-in names no computer.

  Every other caller gets 403 `HANDOFF_NOT_ALLOWED`, so a computer id already in ordinary use stays refused to everyone else. The code redeems only with that same `computerId`. Redeeming ends the computer's Harness computer sessions, marks its machine rows `team` and creates the team session, all in one transaction. A socket still connected under the old sign-in is then closed (4009). The backend cannot end an Autonomous sign-in. The CLI must discard it, because if it connects again the machine becomes an ordinary machine again and the team session can act for nothing.
- **Team tokens.** A team session's access and refresh tokens are `hta_…` and `htr_…`, not the `hna_`/`hnr_` of other Harness sessions. A server running code from before team sessions read any Harness session it did not recognise as a phone's, which reaches every machine and route. Under the new prefixes such a server, during a rolling deploy or after a rollback, refuses a team token instead.
- **Deny by default.** Authentication refuses a team session unless the caller opts in. Only two callers opt in: the REST gate and the machine socket. The web relay (`machine_select`, attach), the device socket, Agent Messages, the observer socket and the phone's routes all refuse it. Over REST, a team session may call only the routes in `TEAM_ROUTES`. Every other route answers 403 `TEAM_SESSION_LIMITED`.
- **Its own machine only.** The machine socket accepts a team session only as its bound computer's machine. A team session may use Super Tab host routes only for that machine, and may speak only as agents running there, never as the person. It cannot contribute, pause or remove a machine, or start, add or drive an agent on another machine. It may share only its own harnesses, and only for a Swarm (the read-only views of Swarm members). It may remove only its own key from the device key log, and it reads the log without marking any key as in use. What it records from a native terminal reaches the Lead as from the agent, never as from the person who opened the terminal. Deleting a machine signs out any team session bound to that machine's computer, whichever sign-in served the machine last.
- **GitHub token (Task 4).** `POST /api/super-tabs/:tabId/github-token?asAgentId=…` with `{ machineId }` is on the list. A team session must name one of its agents and its own machine. A body naming any other machine, or none, is refused before the route runs. The store's `githubAssignment` resolves the agent through `actor()`, which refuses a team session speaking for an agent on another machine. Computer sessions are unchanged. Team tokens (`hta_`, `htr_`) are among the Harness tokens Swarm chat removes when pasted (Task 5).
- **Visible for Task 3.** `Machine.sessionKind` is `team` or `computer`: how the computer signed in on its last connection. When a normal sign-in takes over a team machine, the field changes to `computer` before that socket attaches, so the machine stops being a team machine at once. Null on older rows, which are never team machines. A team session acts only for a row marked `team`. The owner's machine list (`GET /api/machines`) also returns it as `sessionKind`. A Super Tab machine observation gets `observation.sessionKind` from the session that reported it, never from the report.

## Task 2: Team account setup and privacy check (CLI)

Files: new `cli/src/team/` (setup script, launchd job, privacy check), `cli/src/superTabs/host.ts` (observation), CLI help.

- [ ] `harness team setup` builds one privileged script and runs it behind the macOS administrator prompt: a hidden standard user with a random password, its home folder, the owner's home set to `700`, the Harness runtime copied into the team home, and a `/Library/LaunchDaemons` job running the team daemon as that user.
- [ ] The owner's daemon mints a team handoff code and passes it to the team daemon over a file only the team user can read; the code is single use and expires in 90 seconds.
- [ ] Privacy check, run as the team user: reading a sentinel file in the owner's home, listing it, reading `~/.gitconfig`, the login Keychain folder and a browser profile path must all fail. The result is published as the machine's observation and shown as **Private ✓** or the failing item.
- [ ] `harness team on|off` marks a whole dedicated machine as a team machine.
- [ ] `harness team remove` undoes setup: stops the job, deletes the user and its home, leaves the owner's folder permissions as set.
- [ ] Engine sign-in in the team account: Harness starts Claude Code's long-lived token setup and Codex device sign-in there and surfaces the approval link to the owner.
- [ ] End to end in the VM rig: setup from a signed-in owner, the check passes, a Swarm start lands in the team account, removal leaves nothing behind.

## Task 3: Routing rule and automatic setup (backend, CLI)

Files: `backend/src/superTabs/machines.ts`, `store.ts`, `routeDecisions.ts`; `cli/src/superTabs/host.ts`.

- [x] Tests: a start for a project owned by someone other than the machine's contributor is refused on a personal machine and admitted on a Team machine whose privacy check passed; routing proposes only eligible machines and says why the others were skipped.
- [ ] Joining a Swarm, or contributing a Mac, asks the CLI to run `harness team setup` once. A declined or failed prompt leaves the Mac serving only its owner's projects, with one line on the machine saying why.
- [x] Migration: existing contributions keep running agents; new cross-person starts follow the rule.

How it works (`backend/src/superTabs/machines.ts`, `teamWorkCheck`):

- **A teammate's work** is a start, an assignment, a Reviewer added to a group, or a route pick for a project whose owner is not the person whose grant runs the machine: the contributor of a contributed machine, or the agent's own contributor. It is admitted only on a contributed machine that is a Team machine (its account row's `sessionKind` is `team`, or its reading came from a team session) and whose `privacy` is `dedicated`, or `account` with `passed: true` and fresh. Everything else is refused with a code and a sentence: `TEAM_ACCOUNT_REQUIRED` ("MacBook Pro has no Harness Team account yet, so it runs only its owner's projects."), `PRIVACY_UNCHECKED`, `PRIVACY_CHECK_FAILED` (names the item), `PRIVACY_CHECK_STALE` and `MACHINE_OFFLINE`. A machine off the Swarm's Machines list reports no privacy, so it never takes a teammate's work.
- **Privacy** is kept from a reading only when a team session sent it; an ordinary computer's claim is dropped. Each check is dated by when the server first received it, so the Mac's clock does not matter. A passed check counts for 15 minutes (`PRIVACY_FRESH_MS`): the team account checks every 5, so that allows two missed checks. A failing check counts at once. Only the machine's contributor reads a failing check's `detail`; everyone reads the item.
- **Enforced** in `admitMachineStart` (on `agent.start` and again on `agent.startDispatch`), on starts off the Machines list, `work.assign`, `conversation.agent` adding a Reviewer, `route.record` and `route.override`. A queued start whose Team machine refuses it for good (no team account, no check, failing check) fails with that reason when its host tries to launch it; one waiting on a stale check keeps waiting.
- **Routing.** The tab read gives each machine `teamWork`: `{ allowed: true }`, or `{ allowed: false, code, reason }`. The CLI's route leaves those machines out for a teammate's project and lists the reason in `excluded[]`. The backend does the same with any candidate an older CLI still sends, and refuses a pick there ("… Route again.").
- **Migration.** Nothing is stopped. Agents already running on personal machines keep their current task, its reports, messages and their sessions. New starts, new assignments and new Reviewer groups for another person's project follow the rule. A personal machine contributed with scope "swarm" now serves only its owner's projects. So does a machine contributed before projects (no scope) by someone other than the Swarm's owner: the Swarm's first project is the owner's.
- **Switch.** The backend shipped (1.3.28) before the CLI that makes team accounts. So the rule is held to every machine only with `SWARM_TEAM_ACCOUNT_REQUIRED=1` (`machines.ts` `teamAccountRequired`). Until then, a machine without a team account takes a teammate's work as it did before, and a machine with one already follows the rule. Turn it on with the CLI and Desktop release that makes team accounts.

## Task 4: Harness GitHub App (backend, CLI)

Files: new `backend/src/github/` (app auth, token endpoint), `cli/src/superTabs/start.ts` (environment), a `harness git-credential` helper.

- [ ] Register the app (contents and pull requests write, checks and actions read). The owner installs it on the organization.
- [ ] Endpoint: a Swarm agent's daemon asks for a token for its current assignment; the backend checks the assignment and the project's repository and mints an installation token for that one repository, one hour.
- [ ] Team account sessions get `credential.helper = !harness git-credential` and `GH_TOKEN` from the same source, refreshed before expiry. The owner's `gh` and git credentials are never read.
- [ ] Commits carry `Co-authored-by:` the requesting person and trailers naming the agent and machine; the PR is assigned to the requester.
- [ ] Tests with a fake GitHub: wrong assignment, other repository and expired token are refused.

## Task 5: Secrets in Swarm chat (backend)

Files: `backend/src/superTabs/commands.ts` (`message.send`), a small detector module.

- [ ] Tests for JWTs, GitHub tokens, OpenAI and Anthropic keys, AWS keys, Slack tokens and private key blocks; ordinary hashes and commit ids pass.
- [ ] Redact before storing, keep the rest of the message, and tell the sender what was removed and that the credential should be revoked.

## One machine

Owner, 24 Oct 2026: "The isolated team account is just an under-the-scenes mechanism." A Mac with a Harness Team account is one machine in the Swarm's views, for the owner and for teammates: the machines view, Add machine, and wherever an agent's computer is named. Swarm is a hidden feature, so this lives in Super Tab code only (`desktop/lib/super_tabs/`, `cli/src/superTabs/`, `cli/src/team/`, and the backend's Swarm state and team sign-in). App-wide lists are unchanged: Desktop's rail, Machines, pickers, menus and web onboarding, `harness machines` and hn list the team account as its own machine, as before.

- **The link.** The team machine records the Mac it lives on, `Machine.hostMachineId`. `POST /api/auth/handoff` with `{ "kind": "team" }` records the Mac in the code. From a Harness computer session, that is one of the computer's own machines, and naming another is refused. Any other sign-in passes `hostMachineId`: one of the account's ordinary machines (not a team one), in the same environment. Otherwise the answer is 403 `HANDOFF_NOT_ALLOWED`, and nothing is minted. `harness team setup` sends its own machine id. If that id is refused (stale or deleted), setup mints again without it, so the team account still signs in, listed as its own row. The team session keeps the Mac (`HarnessSession.hostMachineId`), and its machine copies it each time it registers. A repair run also updates a team machine that already exists. Nothing a team session sends sets or changes it. A dedicated machine (`harness team on`) has no Mac and stays its own row.
- **Both rows stay in the API.** `GET /api/machines` returns `hostMachineId` on a team machine that lives on a Mac, and null on every other machine. The team account's daemon still reads the account's machines with `sessionKind`, so roster sync keeps leaving team machines out (`machineKinds.ts`). App-wide clients do not read it: Desktop's shared `Machine` model, `harness machines` and hn list the team machine as a row of its own, as before.
- **In a Swarm.** The team machine's pool carries `hostMachineId` too, stamped by the store from the account row. Wherever its owner adds the Mac, the Mac's own daemon adds the team account: the roster names it (`joinTeam`), the team account prepares its own folder and engines through the relay, and the Mac's daemon contributes it as the person (`ifMissing`). The pool takes the Mac's name, agent slots and pause. Pausing, reconfiguring or removing the Mac does the same to it. An account removed and set up again leaves its old pool listed beside the new one: both go with the Mac, and only the last to report, not being removed, takes work. Desktop's Swarm machines view folds from the pools alone: a pool whose `hostMachineId` names another pool of the same person in this Swarm is shown inside that Mac's row, with its agents, and Add machine does not offer it. A team account not yet in the Swarm is still offered there under its own name; adding the Mac adds it. Agents in the team account read as on the Mac. Teammates see the team account's status (it runs while the owner is logged out of macOS); the owner sees their own daemon's.
- **Routing.** A start on the Mac for a project its contributor does not own goes to the Mac's team account, in that account's folder, if `teamWorkCheck` passes. Otherwise it is refused with the team account's reason, and it never falls back to the owner. The owner's own projects stay with the owner's daemon. A start that names the team machine still works. The Lead's route offers the Mac once: the team account for a teammate's project, the owner's daemon for the owner's own. A machines rule naming the Mac allows its team account.
- **The only new copy** is a line on a Swarm machine row, shown only when teammates' agents cannot run there: `Teammates' agents paused: privacy check failed`. The other endings are `Harness Team account offline`, `not set up`, `privacy not checked yet` and `privacy check out of date`, one for each `teamWorkRefusal` code. There is no badge, setup button or setting.

## Out of scope

VMs; team accounts on Windows and Linux (dedicated machines use `harness team on`); blocking the team user from the owner's local network services with per-user firewall rules (next); pooling or reselling subscriptions.

## Validation, 24 Oct 2026 (VM)

`harness team setup`, `status`, `remove`, `on` and `off` from `main` at #1695, end to end in a fresh macOS VM from the fresh-Mac rig (macOS 26.6.2, `ghcr.io/cirruslabs/macos-tahoe-vanilla`). The VM's `admin` (an administrator, signed in at the console) is the owner. Nothing ran on a developer's own Mac.

**How.** The CLI was bundled from this branch and installed by the real installer (`cli/scripts/install.sh`) from a local manifest: managed Node 22.23.2, managed tmux 3.7c, `~/.harness/cli/cli.js` and the `harness` launcher, where `layout.ts` expects them. The owner's home started at `drwxr-x---` (750), the macOS default. It also got a world-readable `~/.gitconfig`, a 755 `~/code` and an `~/.ssh`. Harness sign-in needs a person to scan the QR code, so the owner's sign-in and the backend were stand-ins. The sign-in was a session file in the shape `harness login` writes. The backend was a small server on the VM's loopback that answers `/api/auth/handoff`, `/handoff/redeem` and `/revoke` as the deployed backend does today (`backend/src/routes/auth.ts` before #1691): minting ignores `kind`, and redeeming returns a phone-style `hna_`/`hnr_` session without `kind`. Owner commands ran with `WEB_URL`/`BACKEND_WS_URL` pointing at it and `ADAPTER_UPDATE_DISABLE=true`, which setup carries into the team daemon. Nothing reached production.

| Step | Result |
|---|---|
| 1. Build and install | ✓ as above |
| 2. Owner sign-in | Stand-in only; real sign-in not exercised |
| 3. Administrator prompt | ✓ `harness team setup` from Terminal in the console session. macOS showed `SETUP_PROMPT`, answered over VNC on the first try; 54 s from start to finish, engine installs included. 5 setups and 2 removals went through the real prompt |
| 4. Verify | ✓, except that Users & Groups does not list the account (open bug 5) |
| 5. Negative check | ✓ |
| 6. Idempotency | ✓ |
| 7. Removal | ✗ through `harness team remove` (open bug 6); ✓ the same script run as root over ssh |
| 8. `team on` / `team off` | ✓ safe refusals; nothing changed |

**Step 4.**
- `dscl . -read /Users/harnessteam`: RealName `Harness Team`, UniqueID 600, PrimaryGroupID 20, `/bin/zsh`, Password `*`, `No such key: IsHidden`. `dseditgroup -o checkmember -m harnessteam admin`: `no harnessteam is NOT a member of admin`.
- `ls -ld /Users/admin /Users/harnessteam`: both `drwx------+`. The sentinel `/Users/admin/.harness-team-privacy` is `-rw-r--r-- admin`, 199 bytes.
- `launchctl print system/ai.autonomous.harness.team`: `state = running`, `username = harnessteam`, `group = staff`. `lsof -iTCP:18493 -sTCP:LISTEN`: `harnessd- … harnessteam … 127.0.0.1:18493 (LISTEN)`.
- The team daemon's log: `[team] sign-in failed: This Harness backend does not make team sign-ins yet, so nothing was signed in.`, then `[team] privacy check passed` and `[team] engines: claude installed, codex installed`. The stand-in logged the mint (`{"kind":"team"}`), the redeem, and the revoke of the returned `hnr_` 6 ms later. The team account's `~/.harness/auth/` stayed empty. `harness team setup` therefore exits 1 today, with `✗ The team account did not sign in: …` before `✓ Private: the team account cannot read your files.`
- `/Library/Application Support/Harness/` (root, 755) holds `team.json` (root, 644) and `Team/` (harnessteam, 755) with `status.json`. `harness team status` and `--json` show: account exists, daemon running, sign-in failed (that sentence), `Private ✓`, home `mode 700 ✓`, and Claude Code and Codex `✓ installed · ✗ not signed in`.
- Engines: `~/.local/bin/claude` (Claude Code 2.1.310) and `~/.local/bin/codex` (codex-cli 0.164.0), installed by the team account itself.
- As `harnessteam`: `cat /Users/admin/.harness-team-privacy`, `ls /Users/admin`, `cat /Users/admin/.gitconfig` and `ls /Users/admin/code` each get `Permission denied`.
- After the VM was powered off hard (see the rig note below), launchd started the team daemon at boot and the check passed again.

**Step 5.** With `chmod 750 /Users/admin`, the team account could read the sentinel. `launchctl kickstart -k system/ai.autonomous.harness.team` logged `privacy check FAILED (sentinel): The team account could read the privacy sentinel in your home folder.`, and status showed `privacy ✗ sentinel: …` and `mode 750 ✗ should be 700`. After `chmod 700` and another kickstart it logged `privacy check passed` and status showed `Private ✓`.

**Step 6.** Ran setup a second time through the prompt and diffed snapshots: only the job's pid and run count changed. One account (uid 600), one plist (same SHA-256), one sentinel, one launchd job, no leftover staging folders or `.next` files, and the same team computer id on redeem.

**Step 7.** See open bug 6. The script `buildRemoveScript` makes from `team.json`, run with sudo over ssh, printed `harness: removed the Harness Team account, its home folder and its daemon`. The user, its home, the plist, the job, `team.json`, `Team/` and the sentinel are gone, and `/Users/admin` stays 700. `harness team status` then prints `No Harness Team account on this computer.`, and `harness team remove` prints `No Harness Team account on this Mac; nothing to remove.`

**Step 8.** With the account present, `team on --yes` refuses with `TEAM_ACCOUNT` (`This Mac has a Harness Team account, which runs its team work. …`), and `team off` prints `This computer does not run team work only; nothing to change.` Neither calls the backend. Without the account, `team on` asks for `--yes`, and `team on --yes` prints `✗ This Harness backend does not make team sign-ins yet, so nothing was signed in. Nothing was changed on this computer.` after the mint, the redeem and the revoke of the session it got. The session file's SHA-256 is unchanged throughout. Against the stand-in answering `kind: "team"`, `team on` stored a `kind: "team"` session (`hta_`/`htr_`) and revoked the previous refresh token, and `team off` revoked it and removed the session.

**Fixed in this change** (each with a spec that fails on `main`):
1. *A repair run whose code cannot be minted leaves the team daemon stopped.* `harness team setup` with minting refused (401) ends with status `daemon ○ installed, not loaded`, and `launchctl print` prints `Could not find service "ai.autonomous.harness.team" in domain for system`. Step 4 boots the daemon out, and step 7 exited before step 8 started it again. This happens on every run while the team account is signed out (every run today) and with `--sign-in-again`. Now step 7 records the reason, step 8 runs, and the script then exits 7 with `…; the team daemon runs without a new sign-in`. Checked in the VM: the daemon runs again and no sign-in file is written.
2. *The failure message was garbled.* Before: `✗ The Harness Team account was not finished: 0:296: execution error: ✗ Harness would not give a team sign-in code: Invalid or expired token⏎harness: could not get a sign-in code from your Harness sign-in Run …`, where ⏎ is a CR that makes a terminal overprint the line. `do shell script` ends stderr lines with CR, and `admin.ts` split on LF only. It now splits on both. `lib/guestHelperInstall.ts:172` parses the same way; that was not exercised or changed.
3. *The script's reason ran on into "Run `harness team setup` again".* Setup and remove now end the reason with a full stop.
4. *Codex could not start in the team account's terminals.* In a login shell with the team daemon's environment, `codex --version` and `codex login --device-auth` (the sign-in step `harness team status` prints) both gave `env: node: No such file or directory`, while status said `Codex ✓ installed`. Codex's launcher is `#!/usr/bin/env node`, and the team account has no Node on its PATH: engine launches add Harness's Node, plain terminals do not. Setup now links the team account's Node as `~/.local/bin/node`, as it links tmux. Checked in the VM: `codex-cli 0.164.0`, and `codex login --device-auth` starts its device-code steps.

**Open, for a decision:**
5. *Users & Groups does not list the account.* System Settings > Users & Groups showed only `admin` and Guest User. The record has `Password: *` and no `AuthenticationAuthority`. A test user made the same way was not listed either; the same user given a random password with `dscl . -passwd` (a `ShadowHash` authority) was listed as Standard. So "shown in Users & Groups" in setup's and status's text, and the reason given in `layout.ts`, do not hold today. Options include a random password nobody knows (the plan's original wording) or another way to make it visible.
6. *`harness team remove` cannot delete the account on macOS 26.6.2.* Two runs through the real prompt each printed `✗ The Harness Team account was not fully removed: <dscl_cmd> DS Error: -14120 (eDSPermissionError). Run \`harness team remove\` again.`, with no permission prompt. Deleting a test user with `sudo dscl . -delete` from Terminal raised `"Terminal" would like to administer your computer. Administration can include modifying passwords, networking, and system settings.`; over ssh it succeeded. `dscl . -create` is not gated this way. By the time the delete fails, the script has signed the team account out, booted out its daemon and deleted the plist. The account and its home stay, without a daemon (`daemon ○ not installed`, `sign-in ✗ signed-out`). Possible directions: check that deletion is allowed before changing anything; ask for the Administration permission in Privacy & Security; or delete from a context that permission allows.
7. Removal leaves an empty `/Library/Application Support/Harness` folder.

**Notes.** The administrator dialog is titled "osascript", and a repair run still says "Harness wants to create a separate account". From a folder it cannot read, `claude --version` as the team account fails with a misleading "low max file descriptors (Current limit: 256)". The daemon works from the team home, where it runs, so this is not a product bug. Rig: tart's `--vnc-experimental` server crashed the VM four times (`EXC_BAD_ACCESS` in `-[_VZVNCServer _vncServerClientConnectionCreated:]` when a VNC client connected). Each crash powered the VM off; it was restarted with `vmn-start`.

**Not exercised.** A real owner sign-in, and minting and redeeming against production. A real owner today takes the stand-in's path: the code is minted without `kind`, and the redeemed session has no `kind`, so it is revoked. Also not exercised: a team daemon signing in through setup; Desktop's automatic setup (join, contribute, startup); the 5-minute recheck while serving a Swarm (kickstart was used instead); finishing engine sign-in (a device code needs a person); and a Swarm start landing in the team account.

Tests: `npx vitest run src/team src/superTabs/machines.spec.ts src/superTabs/service.spec.ts`: 209 passed. `npm run typecheck` is clean.

## Validation, second VM run (24 Oct 2026)

Fixes for open bugs 5, 6 and 7, checked in another fresh VM from the same image (macOS 26.6.2, build 25G83). The CLI was bundled from this branch and installed by the real installer from a local manifest. The owner sign-in and the backend were the loopback stand-ins of the first run; the stand-in also answered `GET /api/machines` and `DELETE /api/machines/:id`, and redeemed codes as `kind: "team"`, so the team account was signed in (`hta_`/`htr_`) throughout. Nothing ran on a developer's own Mac.

**What changed.**
- *Bug 5.* Setup gives the account a 40-character random password, made in the root script from `/dev/urandom` and handed to dscl on its input (`printf 'passwd …' | dscl .`; `printf` is the shell's own), never printed, logged, stored or on a command line. Only when the account has no `ShadowHash` authority, so a repair run keeps it and an account made by the first version gets one. Root sets it, so the account has no secure token.
- *Bug 6.* Removal deletes the account first, after only stopping the daemon. When macOS refuses, it starts the daemon again and exits 9 with nothing else changed. In a terminal, `harness team remove` runs the script with sudo there instead of the dialog. The team sign-in now ends from the owner's side after the account is gone: the script names the team computer, and the owner's CLI deletes that team machine from the account, which signs its session out (#1691). The script no longer runs `team __signout`.
- *Bug 7.* Setup marks `/Library/Application Support/Harness` when it creates it; removal deletes it only when marked and empty. A folder made by the first version is left in place.
- A repair run's dialog says "Harness wants to repair the Harness Team account…". The dialog's title stays "osascript": osascript cannot change it.
- `lib/guestHelperInstall.ts` splits osascript's stderr on CR and LF, as `team/admin.ts` does.

**What macOS 26 lets delete an account.** Each was run as root through the real administrator prompt on throwaway accounts, except where noted.

| Mechanism | Result |
|---|---|
| `dscl . -delete /Users/x` | ✗ `DS Error: -14120 (eDSPermissionError)` |
| `sysadminctl -deleteUser x` | ✗ record kept, `### Error:-14120`, but exit 0, after it had already killed the account's processes and deleted its home (`-keepHome` "is not available on this system") |
| one-shot LaunchDaemon (`launchctl bootstrap`) running `dscl . -delete` | ✗ -14120 |
| the same job running `sysadminctl -deleteUser` | ✗ as above |
| `launchctl submit … dscl . -delete` | ✗ -14120 |
| `sudo dscl . -delete` in Terminal | macOS asks "Terminal would like to administer your computer". Don't Allow: -14120; Allow: ✓ |
| System Settings > Users & Groups > Delete User | ✓ |
| setting a password (`dscl` from input, `dscl . -passwd`), deleting an attribute | ✓ through the prompt |

The unified log gives the reason. opendirectoryd has sandboxd ask TCC for `kTCCServiceSystemPolicyAllFiles`, then `kTCCServiceSystemPolicySysAdminFiles`, for the responsible process. Behind the prompt that process is `authtrampoline`, and TCC answers "Platform binary prompting is 'Deny'", so no prompt appears. A Terminal decision lives in the person's TCC database, and `tccutil reset SystemPolicySysAdminFiles com.apple.Terminal` makes macOS ask again. Over ssh, the first run's delete worked because `sshd-keygen-wrapper` has Full Disk Access (Remote Login's).

| Step | Result |
|---|---|
| Setup through the real prompt | ✓ create dialog, exit 0, `✓ The Harness Team account is signed in.`, `✓ Private`. A `ps` sampler during setup (2.1 million lines) saw the root `dscl .` with no other argument and no 40-character token anywhere |
| Listed in Users & Groups | ✓ "Harness Team · Standard" (it was hidden in the first run). `Password: ********`, `;ShadowHash;HASHLIST:<SALTED-SHA512-PBKDF2,SRP-RFC5054-4096-SHA512-PBKDF2>`, `Secure token is DISABLED`, not in `admin` |
| Login window | ✓ lists Harness Team. A guessed password is refused (`Authentication failed … ODErrorCredentialsInvalid` for its GeneratedUID); `dscl /Local/Default -authonly harnessteam ''` and a guess give `eDSAuthFailed` |
| Privacy check | ✓ `Private ✓`; `cat`/`ls` of the sentinel, `/Users/admin`, `~/.gitconfig` and `~/code` as `harnessteam` each give `Permission denied` |
| Repair run | ✓ repair dialog. Before/after snapshot: same uid 600, same password (`ShadowHashData` SHA-256 `895034f17cc5a78b`), same session file, same plist; only the job's pid changed |
| Removal through the prompt (not a terminal) | ✗ as expected, safely: `✗ macOS kept the Harness Team account: could not delete the account harnessteam: macOS did not allow it (eDSPermissionError). Nothing was removed: the Harness Team account and its daemon run as before.`, then both ways to finish. Afterwards: account, password, session file, plist and shared folder unchanged, daemon running again (`privacy check passed` 8 s later), `sign-in ✓`; the stand-in saw no revoke, no machine call |
| Removal in Terminal | ✓ `sudo` asked for the password with the dialog's sentence, macOS asked to let Terminal administer the computer, Allow: `✓ Removed …`, `✓ Took its computer off your Harness account, which signs it out.` The stand-in logged `GET /api/machines` and `DELETE /api/machines/<the team machine>` only, never the owner's |
| Removal in Terminal, Don't Allow | ✓ nothing removed and the daemon runs again; the message gives `tccutil reset SystemPolicySysAdminFiles com.apple.Terminal` |
| Users & Groups, then `harness team remove` again | ✓ with "Don't change the home folder" (macOS renames it `/Users/harnessteam (Deleted)`, owned by uid 600) the removal stops the account's leftover processes, deletes that folder and the rest, and takes its computer off the account |
| Nothing left behind | ✓ no account, home, plist, job, uid-600 process, sentinel, staging folder or `/Library/Application Support/Harness`; `status`: `No Harness Team account on this computer.` |
| `/Users/admin` | ✓ `drwx------` after every removal |

Three bugs found here were fixed and checked again in the VM. The team computer id is read from `~/.harness/computer-id`, not the data folder. A home left by an account deleted elsewhere is judged by uid, because `stat -f %Su` prints such an owner as `(600)` on macOS 26; the first version's check refused it. The removal also handles the `(Deleted)` folder Users & Groups leaves. Setup, the Users & Groups fallback and removal in Terminal were run again with that bundle. One more fix came after the VM was deleted. The backend keeps a computer id lower case and without dashes (`normalizeComputerId`), while the stand-in listed the id as the team account's file holds it. The CLI now compares both in the backend's form; a spec covers it, and the VM did not run it.

**Not exercised.** Removal through the prompt with the deletion allowed (macOS 26 has no way). `harness team remove` from a terminal other than Terminal.app, or inside a Harness pane, where the responsible process is the daemon's Node. A real owner sign-in, production minting, redeeming and machine deletion: the stand-ins answered, so the team session ending with its machine rests on #1691's backend tests. Desktop's automatic setup. A team account made by the first version, repaired to get a password. The guest helper's install: its parsing fix has a spec only. In the VM image `admin` has passwordless sudo; that file was moved aside to see sudo's prompt, then put back. Rig: tart's VNC server crashed the VM five times on connect; `vmn-start` brought it back each time.

Tests: `npx vitest run src/team src/lib/guestHelperInstall.spec.ts src/superTabs/machines.spec.ts src/superTabs/service.spec.ts src/services/guestLaunches.spec.ts src/services/sharedMachines.spec.ts src/cliCommand.spec.ts src/architecture.spec.ts`: 318 passed. `npm run typecheck` is clean. No coverage gate covers `src/team` or `src/lib/guestHelperInstall.ts`.

## Validation, third VM run (24 Oct 2026)

`main` at #1702, end to end in a fresh VM from the same image (macOS 26.6.2), against a disposable backend: current `main`'s backend on the host, its own MongoDB and Redis, and a fixture identity service with two people, the owner and a teammate. The VM had the Command Line Tools installed (a Swarm start needs git). The CLI was bundled from `main` and installed by the real installer. Unlike the first two runs, nothing was a stand-in for Harness: the owner signed in with `harness login --code`, approved through the backend by the owner, so setup minted and redeemed real team codes. The teammate's machine and Lead were recorded through the API, and the owner's second and third computers were isolated daemons on the host. Engines were installed but not signed in; to probe from an agent's shell, the team account's `codex` launcher was replaced by an interactive shell. The backend ran first without a GitHub App, then with a fake one (`api.github.com` answered locally) and a public repository.

| Scenario | Result |
|---|---|
| Regular Mac, nothing set up | ✓ startup offer `not-shared`, no `harness team` line in `--help`, no shared folder or account |
| Contribute → prompt, Cancel | ✓ nothing changed, `team-setup.json` `declined`, later `startup` and `join` offers answer `declined` with no prompt |
| `harness team setup`, accept | ✓ Users & Groups lists "Harness Team · Standard", home 700, `Private ✓`, `hta_` session, machine row `team` with the Mac as `hostMachineId`. ✗ never joined the Swarm (bugs 8, 9) |
| Teammate's project on the Mac | ✓ (after working around 8 and 9) uid 600 in `/Users/harnessteam/harnesses/worktrees/…`; from its shell the owner's home, `~/code`, `~/.gitconfig`, `~/.ssh` and `Library/Keychains` all `Permission denied`. The owner's own project ran as `admin` |
| Team session limits, real token | ✓ 403 `TEAM_SESSION_LIMITED` for the machine list, another machine's host routes, handoff (viewer and team), settings, routing policy, contribute, pause and delete; the web relay closes `4403` on `machine_select` |
| Privacy check fails | ✓ home 750: within 80 s the pool reads `PRIVACY_CHECK_FAILED (sentinel)`, starts naming the Mac or the team machine are refused, nothing runs as the owner. 700 again: passes at the next 5-minute check |
| Team daemon offline | ✓ `MACHINE_OFFLINE` about 40 s after `bootout`; the owner's own start still ran as the owner; back 4 s after `bootstrap` |
| Switch | ✓ unset: a regular machine of the owner admits a teammate's start. `=1`: that machine refuses `TEAM_ACCOUNT_REQUIRED`, the Mac's team account still takes it |
| Repair | ✓ repair prompt; same uid, password hash, plist and session. ✗ `--sign-in-again` kept the old sign-in (bug 10) |
| Roster sync | ✓ the owner's VM and host daemons pin each other, both write `team-machines.json` with the team machine, background sessions run only between the owner's own machines |
| Removal | ✓ through the prompt: refused, nothing changed, daemon running. ✓ in Terminal with Allow: everything local gone, home 700. ✗ the team machine stays on the account and its session stays live when the owner signed in by QR (open 12); ✗ the old pools stay in the Swarm (open 13) |
| `team on` / `off` | ✓ same computer and machine id, `team` then `computer` again after `harness login`; the host daemons' `team-machines.json` added it, then forgot it |
| Reboot, backend restart | ✓ the LaunchDaemon comes back at boot and checks again; both daemons reconnect after a backend restart |

**GitHub App.** Without the App, every teammate start on a Team machine fails at once with "This Harness server has no GitHub App, and a Harness Team account has no git login of its own, so it cannot fetch the project." That holds for a project without a repository too (`projectFolder.ts` asks for a token before anything else). With the switch unset, regular machines still take teammates' work as their owners. So no teammate's work can run in a Harness Team account until the server has the App.

**Fixed in this change** (each with a spec that fails on `main`):
8. *The team daemon ran as its computer id.* `harness start` writes a session's machine id; launchd runs the team daemon's master directly, so its session never had one. Its gateway counted it signed out, so its key never reached the device key log, its Mac's daemon could not reach it (`Could not add this Mac's Harness Team account to its Swarm: That machine is not linked to this one`, retried with backoff forever), and its host would have polled under an id that is not a machine. `team __start` now resolves the machine before the daemon starts, which also names it "<Mac> · Team" in app-wide lists (it carried the Mac's bare hostname, so `harness machines` showed two identical rows).
9. *The team account's Swarm host never started.* The Mac's daemon adds it to a Swarm without waking it, and a host wakes on connect only with a journal, which only a wake writes. The pool stayed `MACHINE_OFFLINE`. A team daemon's host now runs from its first connection.
10. *`--sign-in-again` did nothing.* `team __start` ignored a handed-over code when a session existed, yet setup printed `✓ The Harness Team account is signed in.` It now redeems it, ends the previous session, and keeps it when the code is refused.
11. *Smaller.* A team daemon asked for the owner's Swarm grids every minute and logged the refusal; it no longer asks. A Mac's offline team account was reported as "<Mac> is offline" while the Mac was online; it now says the Harness Team account on that Mac is offline.

Checked again in the VM with a bundle of this branch: a fresh setup signed in with a machine id, registered its key, was added to the Swarm by the Mac's daemon, woke its host, passed its check and took a teammate's start in the team account with no step by hand; `--sign-in-again` ended the previous session.

**Open, for a decision:**
12. *Removal leaves the team machine and its session when the owner signed in by QR.* `harness team remove` prints `! Its computer is still on your Harness account (Billing needs your Autonomous sign-in…)`: `DELETE /api/machines/:id` refuses every Harness-issued token before it looks at the machine, though `machineService.destroy` needs one only for a billed machine. The team session stayed refreshable until the machine was deleted with an Autonomous sign-in. Its tokens were deleted with the home, so nothing holds them. The fix is in the shared route (ask for the Autonomous token only for a billed machine), so it is not in this change.
13. *Removal leaves the team pools in the Swarm.* Even with the machine deleted, the Mac keeps its old team pools, so a teammate's start on the Mac is refused `MACHINE_OFFLINE` instead of running as before (switch unset) or `TEAM_ACCOUNT_REQUIRED` (switch on). Options: `harness team remove` also removes the pools of the account it deleted, or routing skips a team pool whose machine is no longer a team machine.
14. Signing the Mac out of Harness, or into another account, leaves the team account signed in to the previous account and taking its Swarm's work. `--sign-in-again` (bug 10) moves it to the current account.

**Rig notes.** tart's VNC server crashed the VM four times, twice with no client of ours connected; the VM ran without VNC except to answer a prompt. Each power-off doubled as a reboot test. Over VNC, shifted characters type unshifted.

Tests: `npx vitest run src/team src/superTabs src/lib/e2ee/machineKinds.spec.ts src/architecture.spec.ts src/cliCommand.spec.ts` (CLI, 936 passed) and `npx vitest run src/superTabs src/lib/teamSession` (backend, 417 passed). `npm run typecheck` is clean in both.

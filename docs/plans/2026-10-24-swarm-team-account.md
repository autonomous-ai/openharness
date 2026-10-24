# Swarm team account implementation plan

> **For agentic workers:** run each behaviour test red, implement, then verify green. Branch from current `main`; one PR per task.

**Goal:** A teammate's agents can work on my Mac without reading my personal data, and their commits never use my GitHub login. With both in place, a Swarm can pool every company machine's spare capacity safely.

**Why:** Company machines also hold personal mail, photos, browser sessions and personal accounts. In one live Swarm (6 people, 26 agents, 21–23 Oct 2026), 18 of 113 agent starts were one person's Lead starting an agent on another person's machine. Each ran as that machine's owner with full permissions: the owner's files, GitHub login and subscription. People asked which machine their work went to, asked for work on their own machine, and removed a machine from the Swarm.

**Decision:** a separate standard macOS user for team work, not a VM. It keeps native toolchains (Xcode, Flutter desktop), costs one admin password, and separates company work from personal data. A VM stays for a future public Swarm or jobs that need administrator rights.

## The experience

1. A person's Mac joins a Swarm. macOS asks once for an administrator password. There is no Harness setup screen.
2. Harness creates a hidden standard user, makes the owner's home folder private, and runs a second Harness daemon as that user. It appears as its own machine, e.g. "MacBook Pro · Team", marked **Private ✓** once the privacy check passes.
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

## Out of scope

VMs; team accounts on Windows and Linux (dedicated machines use `harness team on`); blocking the team user from the owner's local network services with per-user firewall rules (next); pooling or reselling subscriptions.

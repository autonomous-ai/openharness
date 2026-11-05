# New Project can create a new GitHub repository (task #1788) Design

Status: design only, for Ken's security read and Dee's mockup read. No code until both agree.

## Goal

Dee (11-01): "how do I start a new project with a new repo?" Today a person makes the repository on GitHub, then pastes
its link into New Project. This adds a **New repository** choice to New Project on the phone and on Desktop: a name,
private by default, made in the Swarm's GitHub organization, and the project starts in it.

Positioning: "Tell the PM what you want, and your crew ships it." A new idea should reach a working crew from Harness
alone, without a detour through GitHub's website first.

## What exists today (read 2026-11-05 on main 2c5ac721f)

- **Phone**: `mobile/lib/swarm/swarm_new_project_sheet.dart`. The Repository row opens a list of the repositories this
  Swarm's projects already use, then "Enter a link". Create sends `project.create`, `message.send`, `lead.start
  {repositoryUrl}`, `project.rename`.
- **Desktop**: New Project is the New Harness composer (`desktop/lib/widgets/new_harness_form.dart`,
  `desktop/lib/state/new_harness.dart`, `desktop/lib/super_tabs/launch.dart`). The "Choose repo" menu offers Open
  Folder, New Folder, Clone Repository (paste a GitHub URL) and recent folders. It sends the same four commands.
- **Backend**: the Harness GitHub App (`backend/src/github/app.ts`) mints installation tokens with explicit,
  narrow permission sets (`TOKEN_PERMISSIONS` and the read-only sets). It has no Administration permission. A
  repository is used for teammates' agents only after someone GitHub says can push to it approves it
  (`backend/src/github/approvals.ts`). They approve by signing in through the app's own sign-in ("Continue in GitHub").
  That sign-in's short-lived user token is used once, revoked at once and never stored.
- Nothing in Harness knows a Swarm's "GitHub organization". The closest fact is the owners of the repositories its
  projects already use.

## Permission model

### What the app is allowed to do (GitHub side)

GitHub added two narrow repository permissions for apps (October 2026), so creating a repository no longer needs
**Administration**. Administration would also let a token delete or transfer any repository the app is on.

| Permission | Level | Why | Used with |
| --- | --- | --- | --- |
| Repository creation | Read and write | `POST /orgs/{org}/repos` | The person's own user token only |
| GitHub App installation repository access | Read and write | Add the new repository to the app's installation, only where the installation is on *Only select repositories* | The person's own user token only |

- **Administration is never requested.**
- An owner of each organization accepts the new permissions once: **Settings → GitHub Apps → Harness → Configure →
  Accept new permissions**. Until they do, New repository says so for that organization, and everything else works as
  today. This is the same rollout as Workflows and Issues (docs/swarm-github-app.md, "Workflows and issues").

### Whose token creates it: the person's, not the app's

The repository is created with the **person's own user token from the app's sign-in**, the same "Continue in GitHub"
step that approves a repository today. It is not created with an installation token. So:

- **GitHub decides who may create.** A user token can do only what both the app and the person may do. If the
  organization lets only owners create repositories, or the person is not a member, GitHub refuses, and Harness
  shows that refusal. Harness adds no allow-list of its own that could drift from GitHub's.
- **The record names a person.** GitHub's audit log shows the person as the creator, "via Harness". The machine
  owner's login is never used (identity rule). The person becomes the repository's admin, as if they had made it on
  GitHub.
- **The token lives seconds.** It makes at most three calls (create, add to installation, read back), then it is
  revoked (`DELETE /applications/{client_id}/token`), as `GitHubSignIn.permission` does today. It is never stored or
  logged.
- **The approval comes with it.** The creator can push, so the new repository is approved for this project in the same
  step. No second "Continue in GitHub".

### Installation tokens never carry the new permissions

Every installation token Harness mints names its permissions. None of those sets will ever include
`repository_creation` or `installation_repositories`. A unit test pins this (every exported `*_PERMISSIONS` set, and
the granted-permission filter, exclude both), so a later change cannot widen agents' tokens by accident.

### Residual risk, for Ken's self-audit

- **A leaked app private key** could mint an installation token that asks for the new permissions, in organizations
  that accepted them. With them it could create repositories and add any of the organization's repositories to the
  installation, which widens what a leaked key reaches. Today a leaked key already writes contents on every installed
  repository. The key stays in the backend's secret store only (unchanged), and the installation-access permission is
  needed only for *Only select repositories* installs.
  - **Option A (recommended)**: request both permissions. New repository works on either kind of install.
  - **Option B**: request **Repository creation** only. Where the install is on *Only select repositories*, the new
    repository is made, but an owner of the organization must add it to Harness by hand before teammates' agents can
    use it (failure state F7). Smaller blast radius for a leaked key, and one more step for those organizations.
- **Spike before code (15 minutes, on a test organization)**: confirm (1) that a user token with Repository creation
  but no Administration can call `POST /orgs/{org}/repos`, (2) whether GitHub already adds a repository created through
  the app to a *select repositories* installation by itself (if it does, Option B costs nothing), and (3) that
  `PUT /user/installations/{id}/repositories/{repo_id}` accepts the user token. The answers go in this doc before the
  plan.

### Who may use it (Harness side)

- **People only.** The backend refuses an agent (`HUMAN_REQUIRED`), as `project.create` and `lead.start` do. No PM or
  Engineer creates repositories.
- **Any member who may create a project in this Swarm** may start the flow. GitHub then decides whether they may create
  in that organization (above).
- **The organization is one the Swarm already uses**: the owners of the GitHub repositories its projects use, most
  recently active first, and only those where the app is installed. The person may type another organization name.
  GitHub still checks it, and the app must be installed there.
- **v1 creates in organizations only.** A personal account (`github.com/<you>/...`) keeps today's way: create it on
  GitHub, paste the link. Nobody asked for it, and an app user token cannot target a personal account the app is not
  installed on.

### What is created

`POST /orgs/{org}/repos` with `{ name, private: true unless the person switched it off, auto_init: true }`. `auto_init`
makes the first commit (a README), because a repository with no commit cannot be cloned into a worktree (task #3211
refuses one). Nothing else is set: no team, no template, no branch rules. The organization's own rulesets apply (the
"require pull requests on the default branch" step in docs/swarm-github-app.md still matters, and New repository does
not set it).

## How it flows

```
 Phone / Desktop                 Harness backend                         GitHub
 ───────────────                 ───────────────                         ──────
 Create ──► project.create ─────► project made (no PM yet)
        ──► POST .../github/repository {owner, name, private}
                                 checks: person, project, name rules,
                                 app installed on owner, permission
                                 accepted ──► signed state (10 min)
        ◄── authorizeUrl
 opens browser ──────────────────────────────────────────────────────► sign-in (one tap if
                                                                        already allowed)
                                 /api/github/callback ◄──────────────── code + state
                                 user token ──► POST /orgs/{owner}/repos ─►
                                            ──► add to installation (select installs)
                                            ──► revoke token
                                 approval recorded {created: true}
                                 page: "acme/notes is ready. Go back to Harness."
 back in the app: reads
   .../github/repository ◄────── {state: created, url}
        ──► lead.start {repositoryUrl}  (as today)
        ──► project.rename (as today)
```

The sheet stays open while the browser is out. Coming back (app resume on the phone, window focus on Desktop) reads the
result once. A "Check again" button covers a missed resume. Nothing polls in the background.

## Failure states

Every one is shown in the sheet in plain words. None of them leaves a half-made project silently: the project from
`project.create` exists, and the sheet's existing "The project is made. Its Product Manager didn't start: …" line
covers it, with **Try again**.

| # | When | Where it's caught | What the person sees |
| --- | --- | --- | --- |
| F1 | Name breaks GitHub's rules (not letters, digits, `-`, `_`, `.`; over 100; `.` or `..`) | In the sheet, as they type | "Use letters, numbers, - _ or . (up to 100)." Create stays off. |
| F2 | Name already taken in that organization | GitHub's 422 at create | Back in the sheet: "acme/notes already exists. Choose another name, or pick it under Repository to use it." The name field is focused. |
| F3 | GitHub says the person may not create repositories there (not a member, owners only, private not allowed) | GitHub's 403/422 at create | "GitHub didn't let you create a repository in acme: *GitHub's reason*. Ask an owner of acme, or create it on GitHub and pick Enter a link." |
| F4 | Harness isn't installed on that organization | Backend, before sign-in | "Harness isn't on acme's GitHub yet." **Install on GitHub** (the install link, as Project details offers today) and **Copy message** for an owner. |
| F5 | Installed, but the organization hasn't accepted the new permission | Backend, before sign-in (installation's granted permissions, read as for Workflows today) | "An owner of acme needs to accept Harness's new permission once: GitHub Settings → GitHub Apps → Harness." **Copy message**. |
| F6 | Server has no app sign-in configured (`GITHUB_APP_CLIENT_ID`/`SECRET` unset) | Backend | The New repository choice isn't shown. |
| F7 | Created, but couldn't be added to a *select repositories* installation (Option B, or GitHub refused) | At create | "acme/notes is made, but Harness can't reach it yet. An owner of acme adds it under Settings → GitHub Apps → Harness → Configure." **Copy message**, **Check again**. The project keeps the address, and the PM starts once it's reachable. |
| F8 | Person cancels sign-in, or the link is over 10 minutes old | Callback | "Nothing was created." Back in the sheet: **Try again**. |
| F9 | Network, or GitHub is down | Backend call | "GitHub didn't answer. Nothing was created." **Try again**. |
| F10 | Create succeeded but Harness lost the answer (timeout, server restart) | Next try | Try again finds the name taken by a repository this person created through Harness in the last 10 minutes. That counts as created, not F2. |
| F11 | Project deleted while they were in GitHub | Callback | "The project was deleted meanwhile. acme/notes was still made on GitHub." The repository is never deleted by Harness. |
| F12 | Swarm paused, no machine for the PM | Sheet, before anything is created (existing checks) | The existing blocked notes. Nothing is created on GitHub. |

## Mockups

### Phone: Repository subpage gets a "New repository" row

```
 ‹ Back            Repository
 ┌───────────────────────────────────────────┐
 │ ⑂ openharness                          ✓  │
 │   github.com/autonomous-ai/openharness    │
 │ ⑂ website                                 │
 │   github.com/autonomous-ai/website        │
 ├───────────────────────────────────────────┤
 │ ＋ New repository                       › │   new
 │ 🔗 Enter a link                         › │
 └───────────────────────────────────────────┘
```

### Phone: New repository subpage

```
 ‹ Back          New repository
 ┌───────────────────────────────────────────┐
 │ Owner                  autonomous-ai    › │   the Swarm's org; list if more than one
 ├───────────────────────────────────────────┤
 │ Name                                      │
 │ ┌───────────────────────────────────────┐ │
 │ │ notes-app                             │ │
 │ └───────────────────────────────────────┘ │
 │ github.com/autonomous-ai/notes-app        │
 ├───────────────────────────────────────────┤
 │ Private                              [●━] │   on by default
 │ Only people with access on GitHub see it  │
 └───────────────────────────────────────────┘
  GitHub asks you to confirm, then Harness
  creates it with you as its admin.

 [              Use this name              ]
```

### Phone: the sheet after choosing it

```
 New project                                  ✕
 ┌───────────────────────────────────────────┐
 │ What should this project work on?         │
 │ A notes app with sync…                    │
 └───────────────────────────────────────────┘
 ┌───────────────────────────────────────────┐
 │ Visibility                      Private › │
 │ Repository             New · notes-app ✦ › │
 │                autonomous-ai/notes-app     │
 │ PM runs on                   Mac Studio › │
 │ Agent           Claude Code · Opus 5.5 › │
 └───────────────────────────────────────────┘
 [       Create and continue in GitHub       ]
```

While out in GitHub, and on coming back:

```
 [  Creating autonomous-ai/notes-app…  ]       then the usual
     Check again                                "Starting the PM…"
```

A failure replaces the button's note line, for example F2:

```
 autonomous-ai/notes-app already exists. Choose another
 name, or pick it under Repository to use it.
 [                 Try again                 ]
```

### Desktop: "Choose repo" menu gets a "New Repository" row

```
 [Agent ▾] [💻 Mac Studio ▾] [📁 Choose repo ▾]                       ✕
            ┌──────────────────────────────────────────┐
            │ 🔍 Search repos                          │
            ├──────────────────────────────────────────┤
            │ 📂 Open Folder                           │
            │    Enter a path or browse folders        │
            │ ＋ New Folder                            │
            │    Name a new folder                     │
            │ ⑂ Clone Repository                       │
            │    Paste a GitHub repository URL         │
            │ ✦ New Repository                         │   new
            │    Create one on GitHub                  │
            ├──────────────────────────────────────────┤
            │ recent folders…                          │
            └──────────────────────────────────────────┘
```

### Desktop: New Repository prompt (same style as the Clone repository prompt)

```
 ┌ New repository ─────────────────────────────────────────┐
 │ Owner  [ autonomous-ai ▾ ]   Name [ notes-app          ] │
 │ ☑ Private                                               │
 │ ✦ Create autonomous-ai/notes-app · you confirm in GitHub │
 └──────────────────────────────────────────────────────────┘
```

### Desktop: the composer after choosing it

```
 [Agent ▾] [💻 Mac Studio ▾] [✦ autonomous-ai/notes-app · new ▾]      ✕
 ┌──────────────────────────────────────────────────────────────────┐
 │ What would you like to work on?                                  │
 │ A notes app with sync…                                           │
 │ 📎                          [Private ▾]  [ Continue in GitHub ]  │
 └──────────────────────────────────────────────────────────────────┘
   Creates autonomous-ai/notes-app on GitHub, then clones it on Mac Studio
```

Both apps follow the Harness design language (`docs/naming-system.md`, the existing sheets' rows and prompts). Light
and dark screenshots of each changed screen come with the pull request.

## Design

- **Growth**: one `GitHubRepositoryApproval` row per created repository (an existing collection), with a new optional
  `created: true` and the creator's user id. It is deleted with its project or Swarm, as approvals are today. Nothing
  else is stored. The user token is never stored.
- **Concurrency**: GitHub's unique name per organization is the lock. Two creates of the same name: one gets 201, the
  other F2 (or F10 if it is the same person's retry). The approval row's existing unique index makes recording it
  idempotent.
- **Read cost**: the app reads one small endpoint once on resume or focus, or on Check again. No polling and no new
  Swarm-state field. Organization choices come from repositories the client already has.
- **Scale (10x)**: creation is a rare, person-paced action (a few a day). The first metric to warn is GitHub's
  secondary rate limit on content creation per user. Repository creation is far below it. Each create uses at most
  four GitHub calls on the person's own quota, plus the installation lookup that is already cached for 10 minutes.
- **Compatibility**: a new endpoint and a new menu row. Old apps don't show the row and keep paste and clone. A new app
  on an old server gets 404 on the endpoint and hides the row. `lead.start` is unchanged.
- **Migration and rollback**: no data migration. Rollback is the previous backend (endpoint gone, so the apps hide the
  row). Repositories already created stay on GitHub, as if made there. The GitHub-side permissions can be removed from
  the app's settings at any time.
- **Audience**: the server checks that the caller is a person who may read the project and that the state's signature
  binds person, Swarm, project, owner and name. GitHub enforces who may create in the organization.
- **Identity**: the person's own GitHub sign-in through the app, never the machine owner's git login and never an
  installation token.
- **Failure**: every state in the table above is said in the sheet. A created repository is never deleted by Harness.
- **Platforms**: phone (iOS, Android) and Desktop (macOS, Windows, Linux). Opening GitHub uses the system browser
  everywhere. On Windows the browser opens through the existing link launcher, so no console window ever flashes
  (Windows rule 1).

## Checks this design will need

- Two independent security reviews (sign-in, tokens, access: the two-review rule) and a PM read.
- A Reviewer for the design PR, then for the code PR.
- A Tester: phone in the simulator, Desktop on a Mac, against a test organization (not autonomous-ai).

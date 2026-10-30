# A Swarm project's GitHub access, set up from the app

2026-10-28. Follows [the Swarm team account](2026-10-24-swarm-team-account.md), Task 4 (the Harness GitHub App).

## The problem

A teammate's agent works on a project in a Harness Team account, which has no git login: it fetches, pushes and opens
pull requests only with the Harness GitHub App (`docs/swarm-github-app.md`). The app does that only on repositories
where it is installed. Nothing in the app said so before a start failed: the Lead relayed "The Harness GitHub App is not
installed on owner/repo" after the fact, and only an organization owner on github.com could fix it. With the app made
installable by any account, a developer outside autonomous-ai can use it on their own repositories, public or private,
once they install it there.

## The experience

- The Swarm owner, or anyone in the Swarm, sees each project's GitHub access where the project is: in Project details,
  and as one line under the project in the sidebar when teammates' agents cannot push there. The line shows only once
  the Swarm has another person in it, since only teammates' work needs the app.
- States, in plain words:
  - **Covered**: "GitHub ✓ Teammates' agents can push and open pull requests on owner/repo."
  - **Not installed**: "Teammates' agents can't push to owner/repo yet." with **Install on GitHub** (opens GitHub's
    install page for the app), **Copy link** (for the person who may install it: an owner of the repository's
    organization, or the repository's owner) and **Check again**. Coming back to the app checks again by itself.
  - **Not on GitHub** (a GitLab address, say): "Teammates' agents can't work on this project: its repository isn't on
    GitHub."
  - **No repository yet**: "This project has no repository address yet." The Lead or the owner sets it
    (`project.repository`).
  - **Unavailable**: the server has no GitHub App; nothing is shown.
- Private and public repositories work the same: the installer chooses which repositories the app covers.

## Approval: who may use a repository

A project's repository address is text its owner types, and once the app is public it is installed on many people's
repositories: anyone could name one as their project's and borrow the app's write access to it (found 2026-10-28, with
the app already on autonomous-ai/openharness). So a project gets tokens for a repository only once someone GitHub says
can push to it approved it, for that project or for every project of the Swarm:

- **Approve for this project** / **Approve for every project here** sign the person in to GitHub through the app (its
  Client ID and secret). The backend reads, with their own short-lived token, whether they can push (`push`, `maintain`
  or `admin`), revokes that token at once and stores only the approval: Swarm, project or `*`, repository, who, their
  GitHub login. **Install on GitHub** carries the same signed state, so installing approves too.
- Both token routes (a start's preparation and a task's own token) refuse an unapproved project with
  `GITHUB_REPOSITORY_NOT_APPROVED`. The status says `not-approved`, with the buttons, until then.
- The signed state names the person, Swarm, project, repository and scope, lasts ten minutes, and is signed with a key
  derived from the app's private key. The callback trusts nothing else.
- **Rollout:** approvals are rolled out with the team account (`SWARM_TEAM_ACCOUNT_REQUIRED=1`, held to the Swarms of
  `SWARM_TEAM_ACCOUNT_OWNERS`). Every other Swarm gets tokens as before and reads `covered`, so a bug here cannot stop
  anyone else's Swarm. The same owner list keeps Harness Team accounts out of other Swarms altogether: they do not join
  them, teammates' work there stays on the Mac, and their reads say `teamAccounts: false`, so neither the Mac's daemon nor
  Desktop offers the team account (and macOS's administrator prompt) on joining or adding a Mac to one.

## Build

1. **Backend** `GET /api/super-tabs/:tabId/projects/:projectId/github[?refresh=1]` → `{ state, repository?,
   installUrl? }` for any person who may open the project. It uses `GitHubApp.resolve` (a renamed repository included)
   and its caches; `refresh=1` (Check again, the app coming back to the front) forgets a remembered "not installed" for
   that repository, at most once every 15 seconds per repository.
2. **Desktop** `super_tabs/project_github.dart`: the status and its actions, in Project details, and the sidebar line
   from the controller's per-project cache (read when the Swarm has another person in it, again after 5 minutes, and on
   Check again).
3. **GitHub, once**: the app is made installable by any account (its settings, Advanced → Make public), and optionally
   its Setup URL points at a Harness page so GitHub sends the installer back.

## Design

- **Approvals (stored):** one row per Swarm, repository and project (or `*`); deleted with nothing yet, so at most
  projects × repositories per Swarm, a few hundred. A unique index makes approving again an update. Reads are one
  indexed lookup per token request. Old clients never approve: their teammates' starts get `GITHUB_REPOSITORY_NOT_APPROVED`
  until someone approves in a new one. Rolling back leaves the rows unused.
- **Growth:** nothing else stored. The backend keeps its existing in-memory lookup caches (ten minutes for an installation,
  one minute for none), bounded by the projects asked about.
- **Concurrency:** a read only; no lock. Two reads at once may both ask GitHub; the cache keeps that to one per minute.
- **Read cost:** one GitHub lookup per repository per cache window; Desktop reads per project at most every 5 minutes
  and on Check again, and only in a Swarm with another person in it.
- **Scale:** 10x projects is 10x lookups per window, each one GitHub call; GitHub's app rate limit (5,000 an hour per
  installation, more for larger ones) is the metric that warns first. `refresh` is held to once per 15 s per repository.
- **Compatibility:** an older backend answers 404 for the route: Desktop shows nothing, as before. An older Desktop
  never asks. The Lead's refusal stays the fallback either way.
- **Migration and rollback:** nothing to migrate; rolling back removes the line.
- **Audience:** the server checks the reader may open the project (a private project's members only); the answer holds
  only the repository's name and the public install link, never a token.
- **Identity:** no one's login is used; the app's own credentials read whether it is installed, as for a token.
- **Failure:** GitHub not answering reads as "Couldn't reach GitHub. Check again", never as covered.
- **Platforms:** the backend and every Desktop; the install page is GitHub's, in the browser.

# Swarm GitHub App

When a Swarm agent works on another person's project, it pushes commits and opens
pull requests with the **Harness GitHub App**, not the GitHub login of the computer
it runs on. Each token is for the project's one repository and lasts at most an hour.
Harness revokes it as soon as the agent's task ends.

The agent's commits name the person whose project it is as co-author, along with the
agent and the computer. This is step 4 of the
[Swarm team account plan](plans/2026-10-24-swarm-team-account.md).

## Set it up

An owner of the GitHub organization does this once. A Harness server administrator
then adds three settings.

### 1. Create the app

On GitHub, open the organization, then **Settings → Developer settings → GitHub Apps
→ New GitHub App**, and fill in:

| Field | Value |
| --- | --- |
| GitHub App name | A name of your choice, for example `Harness for Acme`. GitHub needs it to be unique. |
| Homepage URL | `https://harness.autonomous.ai` |
| Callback URL, Setup URL | Leave empty. |
| Webhook → Active | Clear it. Harness subscribes to no events. |
| Repository permissions | **Contents:** Read and write. **Pull requests:** Read and write. **Checks:** Read-only. **Actions:** Read-only. **Metadata:** Read-only (GitHub sets this one). Leave every other permission at *No access*. |
| Organization and account permissions | No access. |
| Where can this GitHub App be installed? | **Only on this account** |

Click **Create GitHub App**. These settings match this manifest, if you prefer to
register with [GitHub's manifest flow](https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):

```json
{
  "name": "Harness for Acme",
  "url": "https://harness.autonomous.ai",
  "public": false,
  "hook_attributes": { "active": false },
  "default_permissions": {
    "contents": "write",
    "pull_requests": "write",
    "checks": "read",
    "actions": "read",
    "metadata": "read"
  },
  "default_events": []
}
```

On the app's page:

1. Note the **App ID** near the top.
2. Under **Private keys**, click **Generate a private key**. GitHub downloads a
   `.pem` file. It is the app's only credential: keep it in your secret store.
3. Note the app's name in its public address, `https://github.com/apps/NAME`.
   This is the slug.

### 2. Install it

On the app's page, click **Install App** and choose the organization. Select **Only
select repositories** and pick the repositories your Swarm projects use, or choose
**All repositories**. Click **Install**. You can add repositories later from the
organization's **Settings → GitHub Apps → Configure**.

If a project uses a repository the app is not installed on, its agents cannot push.
They receive the install link to pass on to an organization owner.

### 3. Require pull requests on the default branch

A token that can write contents can push straight to any branch that nothing
protects. On each repository, or once for the organization, open **Settings → Rules →
Rulesets → New branch ruleset**. Target the default branch, turn on **Require a pull
request before merging**, set **Enforcement status** to *Active* and save. Leave the
app off the bypass list.

Harness checks this when it hands out a token. It still gives the token when the
default branch is unprotected, but it reports `defaultBranchProtected: false`. Each
time git uses that token, `harness git-credential` warns the agent, so the agent can
tell its Lead and the Lead can warn people. Harness reads rulesets with the app's metadata
permission. It cannot read classic branch protection rules without administration
access, which it does not request. A branch protected only by a classic rule
therefore reports `defaultBranchProtection: "classic"` and
`defaultBranchProtected: false`. A ruleset removes that false warning.

### 4. Configure the Harness server

Set these on the backend and deploy it:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | The App ID (the app's Client ID also works). |
| `GITHUB_APP_PRIVATE_KEY` | The `.pem` file's contents. You can paste them as they are, with line breaks written as `\n`, or as base64: `base64 < key.pem \| tr -d '\n'`. |
| `GITHUB_APP_SLUG` | The app's name from `https://github.com/apps/NAME`. Optional; it adds the install link to refusals. |

| `GITHUB_APP_CLIENT_ID` | The app's Client ID (`Iv23…`), for its sign-in. |
| `GITHUB_APP_CLIENT_SECRET` | A client secret: the app's page, **Client secrets → Generate a new client secret**. Keep it with the private key. |

The last two let a person approve a repository for a Swarm project (below). Set both or neither: one alone stops the
backend at startup. Without them, no repository can be approved, so the app gives no tokens.

On the app's settings page on GitHub, so that GitHub sends people back to Harness:

- **Callback URL** and **Setup URL**: `https://harness-api.autonomous.ai/api/github/callback` (your server's address).
- **Request user authorization (OAuth) during installation**: on. Installing then also approves the repository.
- **Redirect on update**: on.

If both of the first two are empty, the feature is off and nothing changes. If only
one of them is set, or the key cannot be read, the backend stops at startup with a
message that never shows the key. Once the key is configured, delete the downloaded
copy.

To try it, start an agent from a Lead on someone else's computer, for a project
whose repository has the app installed. When it has a task, `git push` and
`gh pr create` work in its terminal. `git log -1` shows the trailers, and on GitHub
the push and pull request appear as the app.

## Approving a repository for a project

A project's repository address is text its owner types, and the app is installed on other people's repositories too.
So the app gives a project tokens only once someone GitHub says can push to the repository approved it, for that
project or for every project of the Swarm (`backend/src/github/approvals.ts`). In Harness: Project details, **GitHub
access**, **Approve for this project** (or **for every project here**). The person signs in to GitHub through the app;
their own short-lived token reads whether they can push, is revoked at once and is never stored. **Install on GitHub**
in the same place approves too, once installed. A project without an approval gets
`GITHUB_REPOSITORY_NOT_APPROVED`.

## Which agents use it

Harness wires the app into an agent when the start meets all of these conditions:

- The agent is a Claude Code or Codex agent started by a Swarm Lead.
- The project's owner is not the owner of the computer the agent runs on.
- The server has the app configured.

A person's own agents, starts on a server without the app, and computers whose Harness
is too old to understand the request keep using the computer's own git and gh
configuration. The decision is recorded with the session, so a relaunch keeps it.
In a team account (a Mac's Harness Team account, or a computer after `harness team on`),
every Swarm agent qualifies, because the owner's login is not there. Windows is not
wired yet.

## Preparing the folder before the agent starts

Before a contributed computer creates the agent, it clones the project into its Swarm
folder and fetches the default branch the worktree starts from. For another person's
project it does this with the app too, never with its owner's git login:

1. The host asks `POST /api/super-tabs/hosts/:machineId/starts/:tabId/:startId/github-token`.
   For another person's project the answer is a token that can only read the project's
   repository (`contents: read`, `metadata: read`), and whom the work is for. For the
   machine owner's own project the answer is `{ "github": false }` and the owner's login
   prepares it as before. A team account sends `{ "always": true }`, because it has no
   login of its own.
2. The clone and the fetch run with that token alone: the owner's global and system git
   config are not read, `git@github.com:` addresses go over HTTPS, and nothing prompts.
   The token is in the git process's environment only.
3. The agent is created with `swarmGitHub`, and the daemon does not fetch again.
4. The read-only token is revoked as soon as the clone and the fetch are done, or have failed. The agent gets a token of
   its own for its task.

If the token cannot be had (the app is not installed on the repository, the project has
no GitHub address, or a team account's server has no app), the start fails with that
reason. It is never prepared with the owner's login instead. A server's host rows say
`githubApp: true` when it has the app; a server without the app, or one from before this
endpoint, leaves an owner's computer preparing as before.

## How git and gh get the token

Everything reaches the agent through environment variables, because those survive
what its shells do. Codex runs every command in a login shell, and Claude Code
replays the person's startup files. On a Mac, both put Homebrew's folders back at
the front of `PATH`. A `gh` wrapper placed first on `PATH` would be skipped, so
Harness does not use one.

- **git** reads `GIT_CONFIG_PARAMETERS`, the variable `git -c` uses, which overrides
  every config file:
  - For `https://github.com`, it clears the credential helpers git has read so far
    and sets `harness git-credential` as the only one. It also sets `useHttpPath`, so
    the helper sees which repository git wants.
  - `git@github.com:` and `ssh://git@github.com/` remotes are fetched and pushed over
    HTTPS, so no SSH key of the owner is used.
  - `core.hooksPath` points to Harness's hooks. Each one runs the repository's own
    hook first, from the repository's own `core.hooksPath` or `.git/hooks`.
  - `GIT_TERMINAL_PROMPT=0` makes a missing credential fail at once instead of
    waiting for input that never comes.
- **`harness git-credential get`** finds the calling agent from its tmux pane, the way
  `harness super-tab` does. It asks the local daemon for the token of that agent's
  task and answers `username=x-access-token` and `password=<token>`, but only for
  `https://github.com` and only for the task's repository. A request for another
  host or another repository gets no answer. It ignores `store` and `erase`.
- **gh** reads `GH_CONFIG_DIR`, a folder belonging to the session. The daemon writes
  the token into that folder's `hosts.yml`: when the task starts, again before the
  token expires, and every time git asks for it. When the task ends, the daemon
  empties the file. gh reads the file each time it runs, so it never holds a stale
  token. `GH_TOKEN` and `GITHUB_TOKEN` are cleared from what the agent inherits.
  gh never reads the owner's configuration.

The daemon checks its sessions' tasks once a minute, and only while such a session
is running. The backend returns the same token until ten minutes before it expires.

## Attribution

Each commit message gets these trailers, added by the `prepare-commit-msg` hook after
the repository's own hook has run:

```text
Co-authored-by: Ada Lovelace <ada@example.com>
Harness-Agent: Atlas
Harness-Machine: Studio Mac
```

The co-author is the project's owner, under their Harness account name and email
address. The `commit-msg` hook adds any missing trailers to a message written in an
editor. Trailers already in the message are not added again, so an amend keeps one
of each. An empty message still aborts the commit.

In a Harness Team account, the commits themselves are by the app's bot account
(`<app>[bot] <id+<app>[bot]@users.noreply.github.com>`), as its pull requests are: the
account has no git identity of its own, and its commits read `Harness Team
<harnessteam@<host>.local>` before. The token response names it as `commitAs` for a
team account only; the daemon writes it to the session's `gitconfig`, which the
session's git includes. A person's machine keeps its owner's git identity.

The `prepare-commit-msg` hook runs even with `--no-verify`. Two things leave a commit
without trailers: plumbing such as `git commit-tree`, and a command that sets its own
`-c core.hooksPath`.

The agent is told to start each pull request body with `Requested by <owner's email>
through Harness.` The token response also carries `pullRequestLine` with the owner's
name. This line depends on the agent following its instructions. Harness does not
assign the pull request, because it does not know the person's GitHub login.

## The token endpoint

`POST /api/super-tabs/:tabId/github-token?asAgentId=AGENT` with body
`{ "machineId": "MACHINE" }`.

The caller must be the account that hosts the agent, sending from the computer that
runs it. The agent must have a task in progress: working, waiting on a person, stuck,
or out for review. The response is:

```json
{
  "token": "ghs_…",
  "expiresAt": "2026-10-24T13:00:00Z",
  "repository": "acme/app",
  "defaultBranch": "main",
  "defaultBranchProtected": true,
  "defaultBranchProtection": "pull_request",
  "requestedBy": { "name": "Ada Lovelace", "email": "ada@example.com" },
  "agent": "Atlas",
  "machine": "Studio Mac",
  "trailers": ["Co-authored-by: Ada Lovelace <ada@example.com>", "Harness-Agent: Atlas", "Harness-Machine: Studio Mac"],
  "pullRequestLine": "Requested by Ada Lovelace (ada@example.com) through Harness."
}
```

`defaultBranchProtection` takes one of these values:

- `pull_request`: a ruleset requires a pull request.
- `classic`: classic protection is on, but its settings cannot be read.
- `none`: nothing protects the branch.
- `unknown`: GitHub could not say.

The endpoint refuses with these codes:

| Code | Status | When |
| --- | --- | --- |
| `GITHUB_APP_NOT_CONFIGURED` | 503 | The server has no app. |
| `AGENT_REQUIRED` | 400 | No `asAgentId`. |
| `FORBIDDEN` | 403 | Another account's agent, or the agent runs on another computer. |
| `NO_ASSIGNMENT` | 409 | The agent has no task in progress. |
| `REPOSITORY_NOT_GITHUB` | 409 | The project has no repository address, or one outside github.com. |
| `GITHUB_APP_NOT_INSTALLED` | 409 | The app does not cover the repository. When the slug is set, the response includes `installUrl`. |
| `GITHUB_APP_PERMISSIONS` | 409 | The installation has not accepted the permissions above. |
| `GITHUB_APP_MISCONFIGURED`, `GITHUB_UNAVAILABLE` | 503/502 | GitHub refused the app's credentials, or did not answer. |

Each token is cached per agent and task, sealed with a key derived from the app's
private key, in the backend's shared Redis. The backend serves the cached token until
ten minutes before it expires. Then it mints a new one and leaves the old one to its
last ten minutes, so a push that took the old token before the renewal is not broken.
That token is for the one repository and the task's own session. When the task is
done, cancelled or stopped, when the agent is removed, or when the agent starts a new
task, every token the task holds is revoked (`DELETE /installation/token`) and
dropped, replaced ones included. If a revocation fails, Harness logs it without
the token and the task's change goes ahead. The token then expires within the hour.
The server never logs a token.

## Known limits

- A Lead that starts an agent on its own computer for another person's project starts
  the worktree from what that computer's checkout has: nothing fetches it first.
- On a personal computer, startup files that export `GITHUB_TOKEN` reach Claude
  Code's and Codex's commands again. gh then uses that token. The team account has
  no such files.
- The team account has gh of its own: a Homebrew it cannot read leaves it none, so its
  daemon installs GitHub's release of gh (pinned by checksum in `cli/src/team/gh.ts`)
  in its home and links it from `~/.local/bin`.
- If Redis is unavailable, Harness still issues tokens but cannot revoke them when
  the task ends. They expire within the hour.
- In the first minute of a task, gh can be without a token until the daemon's next
  check or the agent's first git command that needs credentials.

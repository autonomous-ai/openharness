# Buddy read access: open reading, still no writes, new commands asked first

Status: approved by the Lead (10-30), with my recommendations; built in group #1389 (PR #2310), with the fixes from its
two security reviews. Requested by Ken (10-30). Ken chose the sandbox setting in section 3 (10-30). Engineer: Rowan.

There is no on/off switch (Ken's rule against switches): removing the Buddy turns it off. Turning it off for a whole Swarm
would need a release.

## Goal

A Buddy can read what its person needs to support them. Examples: backend CPU and DB size on prod through read-only
access, CI logs, ArgoCD state, prod logs, and files outside its folder on its person's own machine.

Three limits stay:

1. No code changes, pushes or pull requests. The PM assigns work.
2. No writes to prod or any shared system.
3. A command the Buddy has not run before is asked of its person first.

Done when Ken's Buddy can re-measure backend CPU and DB size and read CI and prod logs, while an instruction planted in
a PR, issue or task still cannot make it write anything or leak a secret.

## What existed before

- **Claude Buddy** (`cli/src/lib/buddyGuard.ts`). It runs in Claude Code's `dontAsk` mode. A PreToolUse hook allows its
  read tools inside its folder, a fixed list of plain read commands, and its own `harness super-tab` actions. It refuses
  everything else, and nobody is asked.
- **Codex Buddy.** The server refuses to create one (`CODEX_BUDDY_REFUSAL`).
- **Ways out to other people.** Posts in its own chat, and a `buddy.propose` into the project chat. A proposal needs the
  owner's own message asking for it, but its text is the Buddy's own.
- **Trusted channel from the person.** Before delivering a message, the host (`superTabs/host.ts` `fromOwnPerson`)
  checks that it comes from the Buddy's own person: current membership, their own Buddy chat, and whether the Buddy runs
  on that person's machine.

## What was built

### 1. Wide mode: who gets it, and what it reads

The launch (`buddyLaunchWide`) turns wide mode on only when all of these hold:

- The machine is macOS, or Linux with bubblewrap, so Claude Code's sandbox can run.
- The account is not a Harness Team account.

The server already starts a Buddy only on its person's own machine (`BUDDY_OWN_MACHINE_REFUSAL`), but the launch does
not trust that alone. The host checks it locally, at each message the Buddy's person sends (`superTabs/host.ts`,
`grantBuddyWide`, security reviews of #2310):
- the Swarm names them as the Buddy's person, in their own chat, on a machine it says is theirs;
- the account signed in on this machine is theirs.

Only then does the host grant wide mode in the session's list, which only the host writes. It takes the grant back when
a later message fails the check. The guard reads beyond the folder and runs wider commands only while it is granted.

A grant holds for one launch, one account and an hour (delta reviews of #2310):
- **Launch:** each launch draws a random id. It goes into the guard and into a read-only file in the Buddy's folder, from
  which the host copies it into the grant. A grant from before a relaunch is void, and each launch takes back the grant
  before it.
- **Account:** the host records the account signed in on this machine at its start, and none until it knows. A sign-in
  or sign-out restarts the daemon, so a grant made under another account is void.
- **Time:** an hour at most from the person's message.

`run:` approvals are dated by when the person sent the message, so a delivery tried again adds no time.
Until the person's first message, and whenever the check fails, the Buddy reads its folder alone, as before.

Ruling: the check runs at each message, not at launch. Why: the launch does not know the Buddy's person, least of all on
a relaunch. Cost if wrong: wide mode starts at the person's first message, not at launch.

**Files outside the folder** (Read, Grep, Glob, LS, and `cat`, `head`, `tail`, `wc`, `ls`, `grep`, `rg` in the shell).
They are allowed unasked (Lead, 10-30), but only in the person's home and in named system folders (`/etc`,
`/usr/share`, `/var/log`, and on macOS `/usr/local/etc`, `/opt/homebrew/etc`, `/Library/Logs`). Everything else is
closed: `/proc`, `/sys`, `/dev` and every temporary folder included. On Linux, `/proc/<pid>/environ` held the read-only
DB URL while db-size ran; on macOS, `/private/var/folders` held other processes' files (security reviews of #2310).
Within those folders, these stay closed:

- Every engine's data (`BUDDY_ENGINE_HOMES`, typed by the engine list so a new engine names its own): Claude Code,
  Codex, Cursor, OpenCode, Pi, OMP, Hermes, Command Code, Devin, Muse, Amp, Kilo, Grok, Antigravity (`~/.gemini`),
  Copilot.
- Terminal's per-session histories (`~/.zsh_sessions`), fish's history, and hub's GitHub token (`~/.config/hub`).
- Secret stores in the home folder: `~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.gnupg`, `~/.kube`,
  `~/.docker`, `~/.config/gh`, `~/.config/argocd`, `~/.argocd`, git credentials, `~/.password-store`, `~/.config/op`,
  `~/Library/Keychains`.
- Browser profiles, cookies, Safari, Messages and Mail.
- Shell and database histories, which keep typed secrets.
- Secrets by name, anywhere:
  - `.env*` and `*.env` files
  - `.secrets`/`secrets` folders and files (the read-only prod login is kept in
    `~/.secrets/mongodb-prod-readonly.env`; the sandbox also denies `~/.secrets` by path)
  - keys and certificates (`*.pem`, `*.key`, `*.p12`, `id_*`, and so on)
  - `credentials*`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`
  - `.harness*`, and names like `ro-prod` or `prod-db`
- Other people's Swarm data on this machine:
  - `~/.claude` (transcripts, `paste-cache`, `history.jsonl`) and `~/.claude.json`
  - `~/.codex`
  - Harness's data folder
  - Claude Code's temporary folders (`/tmp/claude-<uid>`), which hold other sessions' tool output

  An agent here (a Lead, say) keeps deliveries from the Leads conversation, private chats and other projects in these
  places.
- Other people's home folders.

Each check uses the real path (a native realpath, so on a case-insensitive Mac `.SSH` reads as `.ssh`). A link into a
closed place is closed too.

Ruling: outside the folder, content search (Grep, `grep`, `rg`) takes single files only. Glob refuses a folder that holds
a closed place. Why: a folder-wide search would read any `.env` or key file inside it. Cost if wrong: the Buddy finds
files with Glob, then reads them.

**Wider commands**, each by an allowlist of subcommands and options, every option by its whole word:

| Tool | Allowed | Never |
|---|---|---|
| `gh run` | `list`, `view` (`--log`, `--log-failed`, `--job`, `--attempt`, `--json`, `--jq`) | `rerun`, `cancel`, `delete`, `watch`, `download`, `--web`, `-R` |
| `gh api` | GET only (`-X`/`--method GET` at most); a path under `repos/OWNER/NAME` of the project's own repositories (from its git remotes), with no `secret`, `key`, `token` or `hook` part; `--jq`, `--paginate`, `--cache`, `--include` | other methods, `-f`/`-F`/`--field`/`--raw-field`/`--input` (they make gh POST), `-H`, `--hostname`, `graphql`, `user` |
| `argocd app` | `list`, `get`, `get-resource` (never a Secret or a ConfigMap), `resources`, `history`, `logs` (`--kind`, `--name`, `--group`, `--since-seconds`, `--tail`, `--filter`, …) | `sync`, `set`, `patch`, `patch-resource`, `delete`, `delete-resource`, `rollback`, `terminate-op`, `actions`, `manifests`, `get --refresh`, `logs -f`, `--server`, `--auth-token`, `--config` |
| `argocd` | `version` | `login`, `logout`, `account`, `cluster`, `repo`, `proj` |
| `kubectl` | `get`, `describe`, `top`, `logs`, `version`, `api-resources`, `config current-context`; a ConfigMap by name only (`get` with every `-o` being `name` or `wide`, as kubectl takes the last; any word with `configmap` in it, or `cm` followed by `.`, `/` or nothing) | any Secret, a ConfigMap described or printed whole, `--raw`, `exec`, `cp`, `port-forward`, `apply`, `delete`, `edit`, `patch`, `scale`, `rollout`, `label`, `annotate`, `-w`, `-f`, `--server`, `--token`, `--kubeconfig`, `--as` |
| Recipe | `harness buddy-read db-size` | anything added to it |
| Anything else | (none) | `curl`, `wget`, `nc`, `ssh`, `sh`, `python`, `node`, `env`, `printenv`, `security`, `mongosh`, `osascript`, `open` |

The measurements use Juno's read-only methods (Lead, 10-30), nothing wider:

- **API CPU per pod**: `argocd app logs production-autonomous-code-be --kind Deployment --name autonomous-code-be
  --group apps --since-seconds 3600`. The backend logs a `cpu by kind` line every minute per pod, with `processCpuMs`
  (`backend/src/lib/selfProfile.ts`).
- **Pods, restarts and HPA**: `argocd app get-resource … --kind Pod -o json` and `--kind HorizontalPodAutoscaler`.
- **DB**: `harness buddy-read db-size` (`cli/src/lib/buddyRecipes.ts`). It reads `MONGODB_PROD_RO_URL` from
  `~/.secrets/mongodb-prod-readonly.env` in the person's home itself, one fixed place wherever it runs (run from a Swarm
  worktree, the clone's file was not found on Ken's Mac, 10-30), and gives it to `mongosh` (`--nodb --quiet --norc`) only through
  the environment, never on its command line, with mongosh's telemetry off for the run. Before reading anything it asks
  the server for the login's privileges (`connectionStatus` with `showPrivileges`). It refuses any role other than
  `read` or `readAnyDatabase`, and any action beyond what MongoDB 8.0 grants them (`builtin_roles.yml` on branch v8.0:
  `changeStream`, `collStats`, `dbHash`, `dbStats`, `find`, `killCursors`, `listCollections`, `listIndexes`,
  `listSearchIndexes`, `planCacheRead`, and `listDatabases` on the cluster; 8.2's `performRawDataOperations` is left out); `clusterMonitor` is refused, as its actions include setting
  changes. It reads `estimatedDocumentCount` per collection and a `$sum` of `size` on
  `SuperTabAttachment`, and prints no connection string, its errors included.

Rulings:
- No recipe for CPU. Why: a fixed command needs no wrapper. Cost if wrong: the Buddy sums the per-pod numbers itself.
- No Atlas CLI. Why: the goal does not need it.
- No `gh -R`. Why: the folder's own repository is the project's.

### 2. "Not run before: ask the person first"

1. A wider command with no approval is refused, and the Buddy is told to ask its person in its chat, showing the exact
   command.
2. The person approves with a line of their own: `run: <exact command>`. Backticks are fine. "Yes", "ok", a quoted
   line or a passing mention approves nothing.
3. The host judges the message's `run:` lines with the Buddy's own guard (`--classify`, one run per message), so there
   is one set of rules and no copy. Judging happens before the delivery lease. A command the grammar refuses is never
   recorded, and the Buddy is told it can never run. The host does this only for the person's own message, in their
   own Buddy chat, on their own machine (`fromOwnPerson`, `onTheirMachine`).
4. The approvals are recorded before the Buddy hears the message.

**Storage.**
- Location: `ADAPTER_DATA_DIR/buddy-approvals/<sha256(personId:generation)>.json`. The folder is mode 700 and the file
  600. It stays on this machine and is never sent anywhere.
- Contents: each entry holds the exact words (argv), when it was approved, and the message that approved it. Matching is
  by exact words, never a prefix.
- Expiry: an approval lasts 30 days, and approving it again renews it. A person keeps at most 200. `forget runs` clears
  them all. A file untouched for 30 days is deleted.
- How the guard finds it: the session's list (`buddy-reads`) points at the file, and only the host writes that list. The
  guard reads approvals only through that pointer, and only inside Harness's approvals folder.

### 3. Writes stay impossible: two layers, and read-only logins

1. **The guard's grammar.** Pipes, `;`, `$()`, redirects and globs refuse the whole command, as before. Writes and
   secret reads can never be approved, so a careless approval of a planted command unlocks only a read.
2. **Claude Code's sandbox** for the Buddy's shell (`buddySandboxSettings`; each point tried with Claude Code 2.1.314):
   - **Writes**: none anywhere. Claude Code otherwise allows three places, so each is denied by name: the folder it
     runs in; the person's clone and its git folder, where a `git commit` from a worktree otherwise landed; and every
     session's folder in Claude Code's temporary folder (`/tmp/claude-<uid>/-*`). The worktree test found both of the
     last two. That temporary folder itself stays writable: Claude Code writes a file there for each command from inside
     the sandbox. No command the guard allows writes a file.
   - **Network**: only `api.github.com`, `github.com`, GitHub's log hosts (`*.actions.githubusercontent.com` and its
     `productionresultssa0`-`19` storage accounts, not every Azure account), and the ArgoCD and cluster hosts named in
     the person's own settings (only the host names are read from those files). No local ports: Harness's own commands,
     which reach its daemon, run outside the sandbox.
   - **Reads**: the guard's closed places, except two things the tools need. Their own sign-ins, which gh, argocd and
     kubectl read to sign in. And Claude Code's temporary folder, where every command's output goes; with it closed,
     even `cat` failed ("cat: stdout: Operation not permitted"). The guard keeps both closed to the Buddy's own reads.
   - **Escape**: `allowUnsandboxedCommands: false`, and the guard refuses any call that sets `dangerouslyDisableSandbox`.
     A guard "allow" must not stand in for the approval Claude Code would ask for.
   - **Exceptions**: `harness super-tab *` and `harness buddy-read *` run outside the sandbox. They need the daemon,
     the terminal and a direct database connection. The guard pins exactly which of those commands may run.
   - **Missing sandbox**: `failIfUnavailable: true`, so a launch where the sandbox cannot start fails loudly. It never
     runs unsandboxed.

   **Ken's choice (10-30): `enableWeakerNetworkIsolation: true`.**
   - What it does: gh, argocd and kubectl are Go tools, and inside the sandbox they verify TLS only through macOS's
     certificate service. With the setting off, every TLS check failed. With it on, an expired, a self-signed and an
     untrusted-root certificate were still refused, and GitHub worked.
   - The cost: the certificate service makes its own requests (certificate status and issuer lookups) outside the
     host list, a small path out. The setting applies to every sandboxed command of the Buddy's session, not per tool,
     and to nothing else on the machine.
   - The alternative was to run those three tools outside the sandbox, with only the guard around them. Ken chose the
     setting, so writes stay blocked and the host list holds for them too. It is the only mode; there is no switch.

   What the sandbox cannot stop: a write sent to a host on the list, such as a POST to GitHub or an ArgoCD sync. For
   those the guard's grammar is the only line, and the tests hold it to every form in the table above.
3. **Read-only logins where they exist.** The DB recipe checks the login's roles first. Ken's ArgoCD login may be an
   admin's, so layers 1 and 2 are the boundary there. A read-only ArgoCD role would be optional hardening.

### 4. Secrets never reach the project chat

- **Not read.** The closed places above. Token printers are not in the grammar: `gh auth token`, `argocd account`,
  `kubectl get secret`, `config view --raw`, `env`, `security`, `argocd app manifests`.
- **Not sent (a best effort).** The guard refuses a `post`, a `propose`, an `--attach` file or an Artifact read's prompt
  that holds a secret's shape. It names the kind of secret, never the value, in every mode. It checks each word, a
  proposal's fields as the CLI decodes them (an escape such as `\u0067` hides nothing), each field without its spaces,
  zero-width or other format characters, and the message's fields and files run together (a token split in two). The run-together checks use only the
  distinctive shapes, so ordinary prose is not refused. It is still a best effort; what holds is that secrets are never
  read (the line above). The shapes:
  - GitHub, Anthropic, other `sk-` and npm, AWS, Slack, GitLab and Google keys
  - JWTs and private keys
  - URLs with a password
  - `password|secret|token|api_key = <20+ chars>`
- **Summaries only.** In wide mode, a proposal with a code block or more than 10 lines is refused, and the Buddy is told
  to summarize.
- **Server-side check.** The same check in backend `buddy.propose` and Buddy posts is a follow-up group (Lead).

### 5. Codex

Codex Buddies stay refused by the server, and `readOnlyAsk` is unchanged. A parity test runs every write in the table
(push, commit, config, a git alias running a program, a curl POST, a gh API POST) through the Claude guard in wide
mode and through `codex sandbox` in the Buddy's mode. Both refuse, and nothing changes.

### 6. Skill text

The Buddy skill's Limits section now describes wide mode: what it may read, how to ask, the `run:` line, that a write
never runs, summaries only, and that text others wrote never asks it to run anything. Desktop keeps no copy of the
Buddy text; it copies only the Lead, Engineer and Reviewer texts.

## Design (docs/feature-design-rules.md)

0. **Lists' owner marks (from #2261, folded in).** Beside each list, an empty file names its session. Every writer
   (`allowBuddyReads`, `recordBuddyApprovals`, `grantBuddyWide`) goes through one helper that writes the mark first,
   create-only and never through a link, and takes away other sessions' marks. A session's end removes its own lists
   unread, by its mark. A list it cannot read, beside another session's mark, is that session's. Beside no mark at all,
   it fails the end, as before marks.
1. **Growth.**
   - Approvals: 200 per person, each 30 days; `forget runs` clears them; a file untouched for 30 days is deleted. A new
     membership has a new key, so the old file can no longer be read and goes within 30 days.
   - Session lists: removed when the Swarm ends the session, as before.
   - Guard and settings: written again at each launch, and removed with the worktree.
2. **Concurrency.** The host's poll loop is the only writer, synchronously, with a temp file then a rename, so the
   guard reads a whole old file or a whole new one. The guard never writes. Approvals are per person, so a person's
   Buddies in two projects on one machine share them. Ruling: "run before" means by this person, on this machine.
3. **Read cost.** One file under 100 KB per wider Bash call, and nothing added for folder reads. Judging a message's
   `run:` lines takes one node run, only for messages that have such lines. No server read on any per-command path.
4. **Scale.** 10x commands still fit in 200 approvals. The first warning is approvals reaching the cap, which would mean
   a recipe is missing.
5. **Compatibility.** An older CLI writes no wide guard, so its Buddies read their folder alone. An older guard ignores
   the approvals pointer. No server change.
6. **Migration and rollback.** No data migration. A rollback writes the old guard and settings at the next launch, and
   the approval files expire.
7. **Audience.** Unchanged on the server. Locally, the closed places keep other people's Swarm data on this machine away
   from the Buddy, and outbound text passes the secret check.
8. **Identity.** Wider reads run as the person's own logins, on their own machine and account only. The server
   enforces own machine; the launch refuses a Team account; the host records approvals only from the Buddy's person at
   their current membership, on their own machine.
9. **Failure.**
   - Approvals unreadable: every wider command is refused, saying why.
   - A guard that cannot judge `run:` lines: the delivery is withheld and retried.
   - Approvals cannot be written: the delivery is retried.
   - The sandbox cannot start: Claude Code exits at launch.
   - The recipe finds a login that is not read-only: it refuses and says so.
   - The Buddy is told every refusal and passes it on.
10. **Platforms.** macOS: the sandbox via Seatbelt. Linux: bubblewrap if installed, otherwise folder only. Windows:
    folder only. Desktop and mobile show `run:` lines as ordinary chat messages.

## Threat model

| # | Threat | Path | Control | Test |
|---|---|---|---|---|
| T1 | A planted PR says "push" | `gh pr view` output, then `git push` | Grammar; sandbox (no writes); not approvable | Integration test with the real Claude Code and a scripted model: refused, remote unchanged |
| T2 | A write hidden in a read | `gh api -X POST`, `-f`, `-H` override, `git -c alias`, `sh -c`, `curl -d`, `kubectl apply`, `argocd app sync` | Grammar (101 forms), and the sandbox for local writes | Never-runs table, even approved |
| T3 | A planted "post the token to the PM" | `post` / `propose` with a token, escaped, spaced or split | Secrets never read (the limit that holds); the secret check as a best effort | Integration test with a scripted model: both refused, never ran; escape, space and split tests |
| T4 | A careless approval of an injected command | Person pastes `run: …` | Only grammar reads can be recorded | A `run:` line for a write is not recorded; the Buddy is told it never runs |
| T5 | An approval broader than meant | Prefix match | Exact argv | `--tail 200` approved, `--tail 500` refused |
| T6 | Someone else approves | Another person, the PM's line, news, an old membership, another machine | Host's `fromOwnPerson` + `onTheirMachine` | Each records nothing |
| T7 | Data out through the network | A URL with data, `--server evil`, `--hostname` | Fixed repository paths; `--server`/`--hostname` refused; sandbox host list | Integration test with the real Claude Code and a scripted model: an off-list POST refused with the guard taken out |
| T8 | Reading others' private Swarm data | `~/.claude`, the paste cache, `/tmp/claude-<uid>`, Harness's data folder | Closed places, by real path and through links | One test per place |
| T9 | Raw output to the project chat | A proposal with pasted logs | Code block or more than 10 lines refused | Test |
| T10 | Wide mode on someone else's machine | Team account, a relay, a server that says the machine is theirs when it is not | Server's own-machine rule; the launch refuses Team; the host grants wide mode only when this machine is signed in as the person | Launch, guard grant and host identity tests |
| T11 | Claude guard and Codex sandbox disagree | A future Codex Buddy | Codex stays refused; parity test | Write table through `codex sandbox` |
| T12 | A stale approval after access changes | Leave and rejoin | Key includes the generation; sweep after 30 days | Tests |
| T13 | Leak through macOS's certificate service | A sandboxed command makes trustd fetch a crafted URL | Ken's accepted trade-off: the guard admits only commands to listed hosts, whose certificates are what gets checked | The probe in section 3 |
| T14 | Local services reachable | Local ports | None reachable from the sandbox; no command in the grammar takes a free host | Settings test |
| T15 | Escaping the sandbox | `dangerouslyDisableSandbox` | `allowUnsandboxedCommands: false`, and the guard refuses the flag | Unit and real-Claude tests |
| T16 | A DB login with write roles | A misconfigured `.secrets` file, or a custom role named "read" | The recipe checks the login's privileges and refuses before reading anything | Recipe tests |
| T17 | Writing through the clone | `git commit` in the worktree, or a file in its git folder | The sandbox denies the clone and its git folder by name | Worktree case of the real sandbox test |
| T18 | Another process's secrets | `/proc/<pid>/environ`, `/private/var/folders` | Reads outside the folder: only the home and named system folders | Unit tests per place |
| T19 | Data out through an Artifact read | The read's prompt goes to claude.ai | The secret check on the prompt (a best effort) | Unit test |

Not covered:
- Another local process that swaps a file or a link between the guard's answer and Claude Code's open. The same holds as
  before (the Lead's ruling on #2092); the Buddy itself has no command that writes.
- Linux's bubblewrap sandbox: the real sandbox tests run on macOS only.
- A plain file at the top of Claude Code's temporary folder, which must stay writable (section 3).

# Buddy read access: open reading, still no writes, new commands asked first

Status: draft for the Lead's go (step 1 of group #1389). No code until approved.
Requested by Ken (10-30). Owner of this design: Engineer Rowan.

## Goal

A Buddy can read what its person needs to support them. Examples: backend CPU and DB size on prod through read-only
access, CI logs, ArgoCD state, prod logs, and files outside its folder on its person's own machine.

Three limits stay:

1. No code changes, pushes or pull requests. The PM assigns work.
2. No writes to prod or any shared system.
3. A command the Buddy has not run before is asked of its person first.

Done when Ken's Buddy can re-measure backend CPU and DB size and read CI and prod logs, while an instruction planted in
a PR, issue or task still cannot make it write anything or leak a secret.

## What exists today

- **Claude Buddy** (`cli/src/lib/buddyGuard.ts`). It runs in Claude Code's `dontAsk` mode. A PreToolUse hook allows
  only these:
  - Read, Grep, Glob and LS inside its folder (by real path), plus files and Artifact links its person sent it.
  - One plain Bash command at a time, from a fixed list: git and gh reads of this repository, and `ls`, `cat`, `rg`,
    `head`, `tail`, `wc`, `grep`.
  - `harness super-tab` status, messages, message, decisions, post, propose and help.

  Everything else is refused and nobody is asked.
- **Codex Buddy.** The server refuses to create one (`CODEX_BUDDY_REFUSAL`, backend `commands.ts` `buddy.create`).
  Codex runs commands that the person's rules files allow outside its sandbox without asking. The launch mode
  `readOnlyAsk` (read-only sandbox, no network) exists and is tested in `cli/src/engines/codex/buddySandbox.spec.ts`.
- **Ways out to other people.** A Buddy can post only in its own chat, and can send a `buddy.propose` into the project
  chat. A proposal needs the owner's own message asking for it (newest, or under an hour old, once per message). The
  Buddy writes the proposal text, so today a proposal could carry anything the Buddy has read.
- **Trusted channel from the person.** Before delivering a message, the host (`superTabs/host.ts` `fromOwnPerson`)
  checks that it is the Buddy's own person, current membership, in their own Buddy chat, and whether the Buddy runs on
  that person's machine. Only then does it list the person's files for the guard (`allowBuddyReads`). The list lives
  outside the Buddy's folder, so no commit or pull can add to it.

## Proposal

### 1. Two kinds of reads

| Kind | What | Asked first? |
|---|---|---|
| Folder reads (unchanged) | Today's list, inside the Buddy's folder | No (as today) |
| Wider reads (new) | Files outside the folder, and network reads of CI, ArgoCD, prod logs, metrics and DB size | Bash commands: yes, by exact command. File tools: no, but a deny list applies (below) |

Wider reads are switched on only when the host confirms all four of these: the Buddy runs on its person's own machine,
under their own account (not a Harness Team account, not someone else's Mac), on macOS or Linux, with the OS sandbox
available (section 3). The host writes `wide: true|false` into the guard at each launch. If any check is unsure, the
value is false and the Buddy gets folder reads only, as today.

**Files outside the folder (Read, Grep, Glob, LS).** Allowed anywhere the person's account can read, except:

- Secret stores: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker/config.json`, `~/.config/gh`, `~/.netrc`,
  `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`, `~/Library/Keychains`, `~/.harness-ro-prod-db` and any `*ro-prod*`
  credential file the person names. Also any file named `.env*`, `*.pem`, `*.key`, `*.p12`, `id_*`, or
  `credentials*`.
- Other people's private Swarm data held on this machine: `~/.claude` (transcripts, `paste-cache`, `history.jsonl`),
  `~/.codex`, `~/.harness` and Harness's data folder (`ADAPTER_DATA_DIR`). An agent here (a Lead, say) keeps
  deliveries from the Leads conversation, private chats and other projects there. The Buddy's audience rule (backend
  `buddyReads`) must not be bypassed through those files.
- Personal app data: `~/Library/Messages`, `~/Library/Mail`, `~/Library/Cookies`, browser profiles.

All checks use the real path. A link that points into a denied path is denied.

**Wider Bash commands.** Each tool has a grammar: a fixed set of subcommands and an allowlist of long options, by whole
name. Today's word parser stays, so there are still no pipes, `;`, `$()`, redirects or globs. Absolute paths are allowed
in wider mode only for file arguments that pass the deny list above.

| Tool | Allowed | Refused (examples; anything not allowed is refused) |
|---|---|---|
| `gh run` | `list`, `view` (with `--log`, `--log-failed`, `--job`) | `rerun`, `cancel`, `delete`, `watch`, `--web` |
| `gh api` | GET only: a path under `repos/autonomous-ai/…`; `--paginate`, `--jq`, `-q` | `-X`/`--method` other than GET, `-f`/`-F`/`--field`/`--raw-field`/`--input` (these make gh POST), `--hostname`, `graphql` |
| `gh pr`/`gh issue` | Today's verbs, plus `--repo` for repositories the project names | Every write verb |
| `argocd app` | `list`, `get`, `resources`, `history`, `logs` (with `--tail`, `--since-seconds`) | `sync`, `set`, `patch`, `delete`, `rollback`, `terminate-op`, `actions run`, `manifests` (renders Secrets), `--server`, `--auth-token` |
| `argocd` other | `version --client` | `login`, `logout`, `account` (tokens), `cluster`, `repo`, `proj`, `context` |
| `kubectl` (if present) | `get`, `describe`, `top`, `logs` (with `--since`, `--tail`), `version`, `api-resources` | Any `secret(s)` resource, `-o` jsonpath on secrets, `--raw`, `exec`, `cp`, `port-forward`, `proxy`, `apply`, `create`, `delete`, `edit`, `patch`, `scale`, `rollout`, `label`, `annotate`, `set`, `drain`, `cordon`, `config` (except `current-context`), `--server`, `--token`, `--kubeconfig` |
| DB | Only fixed recipes (below), never `mongosh`, `--eval`, `node` or a script | Everything else |
| `git` | Today's verbs | `-c`, `--config-env`, `config`, `alias`, `push`, `commit`, `fetch` (writes `.git`), `--exec-path`, `-C` outside the folder |
| Anything else | (none) | `curl`, `wget`, `nc`, `ssh`, `scp`, `sh`, `python`, `node`, `env`, `printenv`, `security`, `open`, `osascript` |

**Recipes** (`harness buddy-read <name>`). These are fixed, read-only measurements that Harness ships, so a routine
re-measure never needs a free-form shell. Each one prints numbers and names only, never a connection string or a
document body.

- `db-size`: `dbStats`, plus the ten largest collections by storage size. It reads the person's read-only URL from the
  file they named once. It first checks `connectionStatus`. If the login has any role beyond `read`,
  `readAnyDatabase` or `clusterMonitor`, it refuses and says the login is not read-only.
- `backend-cpu`: whatever source Ken's Mac uses today (see open question 2). It prints per-pod CPU and memory, the
  replica count and the HPA target.

A recipe is a command like any other, so it is asked the first time too.

### 2. "Not run before: ask the person first"

1. The guard refuses a wider command that has no approval. Its reason tells the Buddy: "Not run before. Ask your
   person in your chat, showing the exact command, why you want it and what it reads."
2. The person approves by sending the exact command in their own message in the Buddy chat, on a line of its own:
   `run: gh run view 123 --log-failed`. "Yes", "ok" or a reaction approves nothing. Typing or pasting the command
   means they have seen it.
3. The host already checks each message from the person (`fromOwnPerson`). For a message that passes, and only if
   wide mode is on, the host takes its `run:` lines. It parses each one with the guard's own grammar. A line the
   grammar refuses (a write, a secret read) is never recorded. The Buddy is told that it "can never run", so the person
   learns it was not a read.
4. The approval is written before the message is delivered, the same way `allowBuddyReads` works.

**Where approvals live.** `ADAPTER_DATA_DIR/buddy-approvals/<sha256(personId:membershipGeneration)>.json`, mode 0600,
on this machine only. They are per person and per machine, never sent to the server and never shared. Each entry holds
`argv` (the parsed words, compared exactly), `approvedAt` and the approving message id.

**Exact command, not prefix.** `argocd app logs backend --tail 200` approved does not approve `--tail 500`, or
`argocd app logs worker`. Recipes keep routine measurement to a few exact commands.

**What stops a planted instruction from getting approved without being read.**

- Writes and secret reads are not approvable at all. The grammar refuses them before approvals are looked up. A
  careless approval can only unlock a read that the person themselves could do, from a host on the allowlist.
- The approval has to restate the exact command in the person's own words. An instruction cannot approve anything.
- Network reads reach only the person's configured endpoints: GitHub's API for the project, their ArgoCD server and
  their DB host. There is no free host or URL to send data to.
- Whatever is read reaches only the person's own chat, or a proposal they asked for, and both pass the secret check
  (section 4).

### 3. Writes stay impossible (three layers)

1. **Guard grammar** (section 1). This is the first refusal. Any word it cannot parse refuses the whole command, as
   today.
2. **OS sandbox for Bash** (Claude Code's own `sandbox` settings, present in 2.1.314: `allowWrite`/`denyWrite`,
   `denyRead`, `network.allowedDomains`, `allowUnsandboxedCommands`). Settings in the Buddy's folder:
   - `enabled: true`, `allowUnsandboxedCommands: false`
   - writes allowed only in a temp folder of the Buddy's own
   - `denyRead` = the deny list above
   - `allowedDomains` = `api.github.com`, `github.com`, the ArgoCD server and the DB host from the person's settings

   This catches what a grammar mistake would let through: a `kubectl apply` hidden behind an alias, a git `-c`, or a
   new flag in a newer tool. Edit, Write, MultiEdit and NotebookEdit stay denied.
3. **Read-only credentials where they exist.** The DB login is checked as read-only by the recipe. For ArgoCD, Ken's
   CLI login is probably an admin, so layers 1 and 2 are the boundary there. I recommend a read-only ArgoCD role
   (`get` only) as optional hardening, not a blocker.

### 4. Secrets never reach the project chat

- **Don't read them.** Use the deny list. Commands that print tokens are refused: `gh auth token`, `gh auth status -t`,
  `argocd account generate-token`, `kubectl get secret`, `kubectl config view --raw`, `env`, `printenv`, `security`,
  `argocd app manifests`.
- **Don't send them.** The guard already sees every `harness super-tab post` and `propose` before it runs. It refuses
  either one when the text, or an `--attach` file, contains:
  - a known token shape: `ghp_`, `gho_`, `github_pat_`, `sk-ant-`, `sk-`, `AKIA…`, `xox[abp]-`, `glpat-`
  - a JWT, a `-----BEGIN … PRIVATE KEY-----` block
  - a URL with credentials (`mongodb(+srv)://u:p@`, `postgres://u:p@`, `https://u:p@`)
  - a `key|token|secret|password = <20+ chars>` pair

  The refusal names the kind of secret, never the secret. Refusing is safer than rewriting the text: nothing is sent
  half-redacted without the person knowing.
- **Proposals carry no raw output.** In wider mode, a proposal is refused if it has a code block or more than 10
  lines. The skill tells the Buddy to summarize ("CPU 23–30% on 8 pods") and attach nothing it read. Attachments stay
  as today: files the person sent, or files in the Buddy's folder. The Buddy cannot write files, so it cannot attach
  output.
- **Server-side check (follow-up, outside this group's code).** The same patterns in backend `buddy.propose` and
  Buddy `message.send`, as a second layer that also covers a future Codex Buddy.

### 5. Codex

Ruling: Codex Buddies stay refused by the server, and `readOnlyAsk` (read-only sandbox, no network) stays as it is.
Wider reads in this change are Claude only. Opening them for Codex needs three things:

- a Codex home for the Buddy alone, so the person's own `allow` rules don't apply
- exact-command rules (Codex's prefix rules are broader)
- approvals that reach the person's chat rather than a terminal nobody reads

That is its own group. Step 2 still covers Codex with a parity test: every write in the Claude refusal table, run
through `codex sandbox` in the Buddy's mode, is refused too. This keeps the two engines from drifting apart.

Why: Ken's Buddy is Claude, so the Done-when is fully met. If this is wrong, Codex owners wait longer, and there is no
safety cost.

### 6. Skill text

Only the Limits section changes, to describe wide mode, `run:` approvals and "summarize, never paste output". The
Desktop copy (`roles_editor.dart`) is kept in sync byte for byte.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer (another engine): ______

1. **Growth.** Approvals: at most 200 per file, dropped 30 days after approval (sending the same `run:` line again renews it; oldest first when full). A whole file goes
   when the person's membership generation changes (new key), when the person leaves the Swarm (the host's existing
   forget path, next to `forgetBuddyReads`), or when the person sends `forget runs`. Files untouched for 30 days are
   swept as `buddy-reads` lists are. The guard settings and the sandbox temp folder are written again at each launch
   and removed with the worktree.
2. **Concurrency.** The host's poll loop is the only writer: synchronous, temp file then rename, as with
   `allowBuddyReads`. The guard reads a whole old file or a whole new one. The guard never writes: a hook writing on every call
   would race, so expiry counts from `approvedAt`. Two Buddies of one person on one machine cannot happen (one per
   project per person), and approvals are keyed per person, so two projects share them. Ruling: that is intended.
   "Run before" means by this person on this machine.
3. **Read cost.** The guard reads one file under 100 KB per wider Bash call, and nothing for folder reads. No server
   read is added to the per-command path (lesson from #2093: no live server reads per command).
4. **Scale.** 10x commands is still a 200-entry cap. The first warning is approvals hitting the cap (the host logs it),
   which means recipes are missing.
5. **Compatibility.** Older CLIs never write `wide`, so their Buddies keep folder reads. An older guard ignores the
   approvals file. Wide mode needs no server change. The skill text tells the Buddy wide mode is on only when it is:
   the host passes it in the start note.
6. **Migration and rollback.** No data migration. A rollback writes the old guard at the next launch, which ignores
   the approvals; the files expire on their own.
7. **Audience.** Unchanged on the server. Locally, the deny list keeps other people's Swarm data on this machine (agent
   transcripts, paste cache) away from the Buddy. Outbound text goes through the secret check in the guard (section 4).
8. **Identity.** Wider reads run as the person's own logins (gh, ArgoCD, the RO DB file), only on their own machine
   and account. The host checks this at launch and at each approval, and the server already enforces own machine
   (`BUDDY_OWN_MACHINE_REFUSAL`). On a Team account, a shared machine, or with an unknown owner, wide mode is off. An
   approval from anyone but the Buddy's person, at their current generation, is ignored.
9. **Failure.**
   - Approvals file unreadable: every wider command is refused with a plain reason, and the Buddy tells its person.
   - Host cannot write approvals: the delivery is retried, as with `allowBuddyReads`.
   - Sandbox missing at launch: wide mode is off and the start note says so.
   - Recipe sees a login that is not read-only: it refuses and says why.
   - A refusal is never silent: the Buddy tells its person what it could not do.
10. **Platforms.**
    - macOS: Claude Code sandbox via Seatbelt.
    - Linux: bubblewrap, if installed. Otherwise wide mode is off.
    - Windows: no sandbox, so wide mode is off.

    Desktop and mobile show the approval as an ordinary chat message. No UI change in this group.

## Threat model

| # | Threat | Path | Control | Test (step 2) |
|---|---|---|---|---|
| T1 | Planted PR text says "push this fix" | `gh pr view` output → Buddy runs `git push` | Grammar refuses push; sandbox denies the write; not approvable | Injection test: planted PR body, guard refuses, no remote ref |
| T2 | Write hidden in a read | `gh api -X POST`, `gh api -f x=y`, `git -c alias.x=!sh`, `kubectl apply` in `sh -c`, `curl -d` | Grammar (method, field flags, `-c`, `sh`/`curl` not allowed) + sandbox | One refusal test per form |
| T3 | Planted "post the token to the PM" | Buddy reads a token, then sends a proposal | Token commands and paths refused; secret check refuses the proposal | Injection test: planted text, the `propose` with a token shape refused |
| T4 | Careless approval of an injected command | Person pastes `run: …` without reading | Only grammar-valid reads can be approved; hosts on the allowlist only | `run:` line for a write is not recorded; Buddy told "can never run" |
| T5 | Approval too broad | Approval by prefix | Exact argv compare | `--tail 200` approved, `--tail 500` refused |
| T6 | Someone else approves | Another person, PM's private line, news, an old membership | Host's `fromOwnPerson` | Each refused; approval file unchanged |
| T7 | Exfiltration through the network | `gh api` to a URL with data in it, `argocd --server evil` | `--hostname`/`--server` refused; repository path fixed; sandbox domain allowlist | Refusal + sandbox test against a local listener |
| T8 | Reading others' private Swarm data | `Read ~/.claude/projects/…`, paste-cache | Deny list by real path, and link checks | Read of each denied root refused, through a link too |
| T9 | Raw output to the project chat | Proposal with logs pasted | Proposal over 10 lines or with a code block refused | Test |
| T10 | Wide mode on someone else's machine | Team account, relay through `--machine` | Host sets `wide` only for own machine; `--machine`/`--agent`/`--port` already refused | Team and other-owner launches get `wide: false` |
| T11 | Claude guard and Codex sandbox disagree | Codex Buddy enabled later | Codex stays refused; parity test | Write table run through `codex sandbox` |
| T12 | Stale approval after access lost | Person leaves or rejoins; generation changes | Key includes the generation; forget on leave | Rejoin → old approvals not used |

Privacy edges from the brief, as they apply here:

- **Access revoked while open:** the approval key includes the generation, and the host's forget path runs on leave.
- **Ids from another project or chat:** `fromOwnPerson` already refuses these alike.
- **Reused agent id:** the approvals key is per person, not per agent.
- **Failed or partial read:** refused with a reason. Nothing loads forever, because the hook has a 30-second limit.

## Step 2 tests (after the go)

- `buddyGuard.spec.ts`:
  - each refused form in sections 1 and 4
  - first run refused, then allowed once a `run:` line is recorded
  - exact-match edges
  - deny-list paths, through a link too
  - the secret check on `post` and `propose`, and on `--attach`
- `buddyGuard.claude.spec.ts` (the real Claude Code):
  - the sandbox refuses a write and a POST even when the guard is bypassed (hook removed in a throwaway folder)
  - the injection test: a planted PR body asks for a push and a token post, and both fail
- `host.spec.ts`: `run:` lines recorded only from the owner's own message; not for news, the PM's lines or another
  person; not when wide mode is off.
- `buddySandbox.spec.ts`: Codex parity for the write table.
- Red then green for each test, posted in the PR as the brief asks.
- Dry run on Ken's Mac with Ken's go: `db-size`, `backend-cpu`, `gh run view --log-failed`, `argocd app logs` (by an
  agent, as the brief says).

## Open questions for the Lead (recommendation first)

1. **File reads outside the folder: unasked, with the deny list (recommended), or asked per folder?** Asking per
   folder is safer, but slows the main use. The deny list plus the outbound secret check cover the leak path.
2. **How does Ken's Mac read backend CPU today?** The notes say there's no kubectl and ArgoCD only. ArgoCD does not
   report CPU. Is it `kubectl top`, a cloud console CLI, or Grafana? This sets the `backend-cpu` recipe and the domain
   allowlist. Recommendation: ask the prod-watch agent on Ken's Mac before step 2.
3. **Approval UX: typed `run:` line (recommended for now, no server or app change), or an approve button in the chat?**
   The button is clearer, but needs backend, Desktop and mobile changes outside this group's owned code. It would get
   an ASCII mockup first.
4. **Server-side secret check on `buddy.propose` and Buddy posts:** a follow-up group (recommended), or in this one?
5. **Recipes need a small new `harness buddy-read` command** (`cli/src/lib/buddyRecipes.ts`), and the host change for
   `run:` lines (`superTabs/host.ts`, next to `allowBuddyReads`). Both are just outside the owned list. OK to own
   them?

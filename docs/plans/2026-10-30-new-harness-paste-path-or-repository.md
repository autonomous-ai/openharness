# New Harness: paste a folder path or a GitHub link into the project search

Status: ready for implementation. UI decided 2026-10-30 (option B of the A/B mock-up).

## Problem Statement

When someone starts a harness, the project menu's search box ("Search repos") only filters the recent
projects by folder name. Two things people naturally paste there do nothing useful:

- **A folder path** (`~/Pro2/x4`, `/Users/me/work/api`). An absolute path shows "No matches". A `~` path
  only matches when the folder is already recent, and then only by luck. To open a folder, the person has
  to find **Open Folder…** first and type the path again there.
- **A GitHub link copied from the browser** (`https://github.com/org/repo`) shows "No matches". To clone
  it, the person has to find **GitHub ›** first and paste it again there.

Even through the GitHub door, **private repositories often fail** although the person can reach them with
git. A clone uses only the selected computer's own git credentials, with every prompt turned off, and it
tries exactly the address that was pasted. Measured on a developer Mac on 2026-10-30 with `git ls-remote`
(same environment as a clone):

| Pasted | Repository A | Repository B |
|---|---|---|
| Browser HTTPS link | refused: no HTTPS credential stored | refused |
| `git@github.com:` | works | "Repository not found" |

Repository B is reachable only through an SSH host alias in `~/.ssh/config` (`Host gh-<account>`,
`HostName github.com`, another key): the person has two GitHub accounts on that computer. Nothing in the
browser link says which alias to use, and a pasted `git@gh-<account>:org/repo` is refused as "not a GitHub
URL".

## Solution

The project search recognizes what was typed and offers one action for it, at the top of the list and
already selected, so Enter does it:

- A path that names a folder → **Open ~/Pro2/x4** ("Folder on This Mac"). A path that does not name a folder
  yet (`~/Pro2/`, `~/Pro2/x9`) → **Browse ~/Pro2/ ›**, which moves to the Open Folder prompt and keeps what
  was typed, so the person carries on there.
- A GitHub repository link (HTTPS, `git@github.com:` or an SSH alias that points at github.com) → **Clone
  org/repo** ("into ~/harnesses/repo"; "over SSH as gh-<account>" for an alias; "on Mac mini · uses that
  computer's GitHub access" when the harness runs on another computer).
- A GitHub link that is not a repository → a disabled **Not a repository link** row ("Use
  github.com/owner/repo"). An SSH alias that does not point at github.com → a disabled **gh-x isn't a GitHub
  host** row when the selected computer is this one.
- Anything else filters the recent projects as today. Typing a bare `Pro2/x4` stays a search: it is never
  read as `owner/repo`.

Open Folder…, New Folder and GitHub › stay where they are.

When the harness is launched, cloning a private repository tries the ways the computer may have access,
stopping at the first that works:

1. the address that was pasted;
2. the same repository over the other transport (HTTPS ↔ SSH);
3. up to three SSH host aliases from the computer's SSH configuration whose host name is github.com.

It moves to the next only when GitHub **refused access** or ssh would not trust its host key. A network failure or a timeout stops at once. A host key among the failures is what the person is told, not "No access": GitHub was not asked.
While it runs, the composer shows the static line **Cloning org/repo…**. A checkout that is reused is no clone, so the line stays **Starting harness…**. When an alias was used, the person
sees one short line, **Cloned via gh-<account>**. The new checkout's `origin` is the address that worked, so
later pushes go through the same account. When every way is refused, the composer shows one line, **No
access to org/repo on this Mac** (the computer's name for another computer), keeps the task and every
choice, and Launch tries again.

## User Stories

1. As a person starting a harness, I want to paste a folder path into the project search, so that I don't
   have to find Open Folder first.
2. As a person starting a harness, I want Enter to open a pasted path that names a folder, so that opening a
   known folder is one paste and one key.
3. As a person typing a path that doesn't exist yet, I want the search to take me to the folder browser with
   what I typed, so that I can carry on choosing without typing it again.
4. As a person typing `~/`, I want the path understood on the selected computer, so that `~` means that
   computer's home.
5. As a person with a Windows computer selected, I want `C:\work\api` treated as a path, so that the search
   works the same there.
6. As a person typing a project name, I want search to behave exactly as today, so that nothing I rely on
   changes.
7. As a person typing `team/api`, I want it treated as a search, not as a GitHub repository, so that I'm
   never offered a clone I didn't ask for.
8. As a person who copied a GitHub link from the browser, I want to paste it into the project search, so that
   I don't have to find the GitHub door first.
9. As a person pasting a GitHub link, I want the Clone row selected, so that Enter clones.
10. As a person pasting `git@github.com:org/repo.git`, I want it accepted like the HTTPS link, so that either
    form works.
11. As a person pasting a GitHub link to an organization or a file, I want a clear "Not a repository link"
    row, so that I know why nothing happens.
12. As a person who reaches GitHub through an SSH alias, I want to paste `git@<alias>:org/repo`, so that the
    clone uses that account.
13. As a person pasting an alias that doesn't point at GitHub, I want to be told so, so that I don't wait for
    a clone that cannot happen.
14. As a person cloning onto another computer, I want the row to say it uses that computer's GitHub access,
    so that I understand whose credentials matter.
15. As a person who has GitHub access only over SSH, I want a pasted HTTPS link to clone anyway, so that I
    don't have to rewrite links.
16. As a person who has GitHub access only over HTTPS, I want a pasted SSH link to clone anyway, for the same
    reason.
17. As a person with two GitHub accounts on one computer, I want a browser link to clone through the alias
    that has access, so that I don't need to remember alias names.
18. As a person whose clone used an alias, I want a short "Cloned via <alias>" line, so that I know which
    account will push.
19. As a person whose clone used an alias, I want `origin` to stay on that alias, so that later pushes and
    pulls work without changes.
20. As a person whose clone is running, I want a simple "Cloning org/repo…" line, so that I know it's working.
21. As a person with no access to a repository, I want one short line, "No access to org/repo on this Mac", so
    that I know what failed without reading a log.
22. As a person who got "No access", I want my task and choices kept, so that I can fix my credentials and
    launch again.
23. As a person whose network is down, I want the clone to stop at the first network failure, so that I
    don't wait for more attempts that cannot work.
24. As a person who already cloned a repository through an alias, I want pasting its browser link to start in
    the existing checkout, so that I'm not told the folder already exists.
25. As a person launching on a computer that runs an older Harness, I want ordinary links to clone as before,
    so that a mixed setup keeps working.
26. As a person using the browser app, I want the same paste behaviour, so that the experience matches the
    desktop app.
27. As a keyboard user, I want the action row reachable and announced like any other row, so that I can use
    it without a mouse.
28. As a guest on a computer shared with me, I want clones to behave as they do today, so that my request
    never tries the owner's other GitHub accounts.
29. As a Swarm member, I want Swarm project clones to behave as they do today, so that this change does not
    alter how shared projects get access.
30. As a developer diagnosing a "No access" report, I want the attempts recorded in the log (which transport
    or alias, and how each failed), so that I can tell the person what to fix.

## Implementation Decisions

**Two places clone, and they must agree.** A harness on this computer is cloned by the desktop app itself.
A harness on another computer is cloned by that computer's daemon while it prepares the project folder.
Each place gets the same parser, the same repository identity and the same attempt order, written once in
Dart and once in TypeScript, and both held to one shared vector file (Testing Decisions).

**Parser.** Accepted repository addresses are HTTPS `github.com/owner/repo`, `git@github.com:owner/repo`
and, new, `git@<alias>:owner/repo`. An alias must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`. It never starts
with `-`, so it can never become an option to `ssh` or `git`. Owner and repository rules are unchanged. A bare
`owner/repo` is no longer offered as a clone from the project search. The GitHub prompt and the daemon still
accept it, for older callers. The parsed value records the transport (`https`, `ssh`, `alias`) and, for an
alias, its name.

**SSH host resolution.** A small module answers two questions on the computer that clones:

- `resolveHost(alias) → hostname | null`, by running `ssh -G <alias>`, which reads the configuration without
  connecting. It is bounded to four seconds and to 64 KiB of output.
- `githubAliases() → string[]`: the configuration's `Host` names, wildcards and negations left out,
  `Include` followed one level deep, each kept when `resolveHost` says `github.com`. The result is ordered
  as written and capped at 3.

It runs only on demand. A pasted alias is checked at parse time on the cloning computer. The alias list is
read only after access was refused. Nothing about SSH configuration is cached or sent anywhere except the
alias name that succeeded.

**Attempt order.** A pure function `cloneAttempts(parsed, aliases) → address[]` gives, without duplicates:
the pasted address; the other transport (HTTPS ↔ `git@github.com:`); then each alias as
`git@<alias>:owner/repo.git`. A pasted alias comes first and is followed by HTTPS and `git@github.com:`. The
runner tries each address in a fresh staging folder. It moves on only on an access refusal (the existing
classification: authentication, permission denied, could not read Username, repository not found). It stops
on success, a timeout, a network failure or a cancel. The five-minute deadline applies to each attempt.
Staging is removed after each attempt, as today.

**Repository identity with aliases.** When an existing checkout is compared with the requested repository
("already cloned here: start in it"), a host that is not github.com is resolved through `resolveHost` first.
A checkout whose origin is `git@gh-<account>:org/repo` is then the same repository as
`https://github.com/org/repo`.

**Who gets the wider attempts.** The fallback and the alias attempts apply to an owner's own New Harness
launch, on this computer or one of their own. A guest's launch on a shared computer keeps today's single
attempt; that path never prepares a project folder at all. Swarm clones keep their current behaviour: the
token path stays HTTPS only, and the non-token path keeps its own HTTPS ↔ SSH retry. A Swarm agent created
through the owner path (it has a Swarm role) gets no fallback either. The wider attempts are opt-in on the
daemon's project-folder preparation (`cloneFallback`), off by default. While building, the Swarm retry was
left where it is rather than moved onto the shared runner: its specs pin the exact preparation calls. Folding
the two together is a follow-up.

**Launch result contract (daemon → apps).** A successful creation that cloned may carry an optional
`clonedVia: { alias: string }`, present only when an alias was used. A failure after all attempts were
refused keeps the code `CLONE_FAILED` and carries a new optional `access: "denied"` beside the existing
`detail`. The apps word the short line themselves ("No access to org/repo on <computer>"). An older app shows
`detail` as today. A pasted alias that is not a GitHub host is refused with `INVALID_REPOSITORY` and a detail
naming the alias.

**Project search (desktop/browser controller).** In the project menu field, the controller classifies the
query:

- path: the existing path test;
- GitHub link: contains `github.com/` or matches `git@<host>:`;
- search: anything else.

For a path it requests the parent's listing through the existing listing request and builds one action
row: Open (the folder exists) or Browse (anything else). Browse moves to the Open Folder field with the query
carried over. A Browse row is left out when a recent project matches the half-typed path, so the matching
project keeps the highlight. This decision was added while building, because an existing rule
(`/work/team/payments` selects the recent `payments-processing`) would otherwise break. For a link it builds one Clone row from the parser, or one disabled row. The action row is
synthetic, sits above the three doors and takes the cursor. A recent project never outranks it. The
placeholder stays "Search repos".

**Composer lines.** While a creation that clones is running: "Cloning org/repo…" (static, no per-attempt
progress). On success with an alias: "Cloned via <alias>", shown once where the app reports a start's
outcome. On denial: "No access to org/repo on <computer>". The task and choices stay, and Launch retries.

**Logging.** Each attempt is logged with the transport or alias and the failure class, never the
credential-helper output. Addresses carry no credentials: the parser refuses them.

## Testing Decisions

A good test here drives the feature from the outside: it sets a query and reads what the menu offers and
what Enter does, or it asks for a clone and reads which addresses were tried and what came back. It never
asserts on private fields or on the order of internal calls.

1. **Project search, through the New Harness controller.** Set the query, then read the shown rows, the
   selected row and the result of accept. Cases:
   - name search unchanged;
   - existing path → Open;
   - partial or missing path → Browse, which carries the query into the Open Folder field;
   - Windows path;
   - HTTPS, `git@github.com:` and alias links → Clone with the right detail;
   - organization link → disabled row;
   - bare `owner/repo` → search only;
   - another computer selected → the "uses that computer's GitHub access" detail;
   - keyboard: cursor and Enter.

   Prior art: the entry-rules, controller-edges and project-context tests for New Harness, which build the
   controller over an in-memory app notifier.
2. **Shared vectors, run by both languages.** One JSON file of cases, each an input address with:
   - the expected parse (or the refusal);
   - the expected identity;
   - given a stated alias table, the expected attempt list.

   The Dart test and the TypeScript spec both load it, so the two implementations cannot drift. Prior art:
   the Windows pipe-auth vectors, which both the CLI and the desktop app hold to one fixture.
3. **Clone runs, through the existing injection points.**
   - Desktop: the repository clone with an injected process starter that refuses chosen addresses (access,
     network, timeout).
   - Daemon: project-folder preparation with an injected clone function, and an injected host resolver.

   Assert:
   - which addresses were tried, and that a network failure stops the run;
   - the final `origin`;
   - that an existing alias checkout is reused;
   - staging cleanup;
   - guest launches try exactly one address;
   - Swarm's token path stays HTTPS only.

   Prior art: the repository-clone test and the project-folder spec.
4. **Launch result in the core.** An agent creation that clones reports `clonedVia` and `access: "denied"`
   as specified. This runs under the core's 100 % coverage gate, which PR CI does not run: run it locally and
   record it in the PR.
5. **Windows.** One run of the Windows desktop workflow to confirm `ssh -G` from the Windows OpenSSH client.

## Out of Scope

- Detecting, before cloning, that a pasted link is already checked out somewhere on the computer (offering
  "Open" instead of "Clone").
- Using the Harness GitHub App's token for New Harness clones.
- Hosts other than GitHub (GitLab, Bitbucket, GitHub Enterprise).
- Live per-attempt progress while cloning.
- Changing how Swarm projects get access.
- Asking for credentials interactively (password, passphrase, device login).

## Further Notes

- Mock-up of the decided UI, with every state: the A/B page drawn for this decision (option B, private
  repository states P1–P6), kept outside the repository.
- Update the New Harness entry rules design note with the classification rules and the action row.

## Design (docs/feature-design-rules.md)

Reviewed revision: ______  Reviewer (another engine): ______

1. Growth: N/A because nothing is stored; staging folders are removed after each attempt, as today.
2. Concurrency: unchanged. Each attempt clones into its own staging folder and renames once. A destination
   that appeared meanwhile is reused when it holds the same repository (alias-aware) and refused otherwise.
3. Read cost: the SSH configuration is read only after an access refusal, bounded (64 KiB output per
   `ssh -G`, at most 3 aliases kept, `Include` one level). The project search issues no request beyond the
   listing path completion already makes.
4. Scale: worst case per launch is 5 attempts, each refused in about 1–2 s. The first warning is clone time
   in the creation logs.
5. Compatibility: a new app with an old daemon gets today's single attempt and `INVALID_REPOSITORY` for a
   pasted alias. An old app with a new daemon ignores `clonedVia` and `access` and shows `detail`. Existing
   readers of the creation result were searched: the desktop failure wording and the creation-status payload.
6. Migration and rollback: none. A previous release ignores the new optional fields.
7. Audience: the alias name is returned only to the account that asked for the creation on its own computer.
   Guests get no alias attempts.
8. Identity: a clone runs with the cloning computer's own git credentials, as today. The wider attempts run
   only for the computer owner's own launches, never for a guest, and never with the Harness GitHub App token.
9. Failure: refused everywhere → "No access to org/repo on <computer>", task kept, Launch retries. Network or
   timeout → today's messages. Every attempt is in the log.
10. Platforms:
    - macOS and Linux: `ssh -G` from OpenSSH.
    - Windows: OpenSSH client, to be confirmed in the Windows workflow.
    - Browser app: never clones locally, so the daemon does all of it.

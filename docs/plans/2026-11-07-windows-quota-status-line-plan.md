# Windows agents report quota from Claude Code's status line too: implementation plan

> Written by the project's Engineer way of working (project instructions, Engineer): plan first, then each task test first,
> the failing test committed before its code. No Execution Handoff.

**Goal:** task #4164 (requested by Dee through Harness, Swarm v3). Quota comes only from the CLIs' own reports (#4137, PR #3451).
On Windows, Harness's status line was left out whenever the person had a status line of their own, and whenever a path held a
character that needed quoting (`C:\Users\Jo Smith`), so a Windows Claude agent reported no quota and the router could not tell
whether it had any left. Codex's app-server read already runs on Windows (lib/codexRateLimits.ts, no window: `ownProcessGroup`).

**How Claude Code 2.1.316 runs a status line on Windows** (read from its bundle: the status line goes through its hook runner):

- In Git Bash when it finds one: `CLAUDE_CODE_GIT_BASH_PATH` (a `bash`/`sh` that exists), else `C:\Program Files\Git\bin\bash.exe`,
  else `C:\Program Files (x86)\Git\bin\bash.exe`, else the `git` on PATH's `..\..\bin\bash.exe`. It runs the line with that bash
  as Node's `shell` (`bash -c`), that bash's folder first on PATH, and a line whose first word ends in `.sh` as `bash <line>`.
- Otherwise in PowerShell (`-Command`).

**Architecture:**

- `claude/gitBash.ts` `claudeCodeGitBash`: the Git Bash Claude Code runs its status line in, found as it finds it.
- `kit/statusLine.ts` on Windows:
  - With that Git Bash: Harness's line is quoted for it as on a Mac (POSIX quotes, forward slashes), so a path with a space
    works, and the script is given `--bash <path>`. The person's own line is passed along as on a Mac.
  - Without one (PowerShell): Harness's line in PowerShell's form (kit/notifyHooks.ts `quoteHookCommand`). A person's own line is
    left as it is, and the CLI says so once in its log: this session reports no quota.
- `hook/statusline.mjs` with `--bash`: the person's own line runs in that bash exactly as Claude Code would run it (its folder
  first on PATH, the `.sh` rule). Without `--bash` nothing changes, so macOS and Linux run as before.
- No window: the person's line is a child of the status line, which Claude Code starts hidden; `windowsHide`, no `detached`.
- No login or credential file is read anywhere on this path.

**Tech Stack:** TypeScript CLI, the self-contained `hook/statusline.mjs`, vitest.

## Design

N/A because nothing is stored, synced or exposed beyond #4137's report file, which is unchanged.

## Platforms

Windows (the change), macOS and Linux (unchanged: their line is byte for byte as before, pinned by the existing specs). A Windows
Tester runs it on a Windows machine with Git for Windows, with and without the person's own status line.

## Tasks (all test first)

- [ ] `claudeCodeGitBash` finds the Git Bash Claude Code finds, in its order, and none without one.
- [ ] Windows with Git Bash: Harness's line quoted for bash (a path with a space), the person's own line passed with `--bash`.
- [ ] Windows without Git Bash: Harness's line in PowerShell's form; a person's own line left alone, said in the log.
- [ ] The script with `--bash` runs the person's line in that bash, its folder first on PATH, and a `.sh` line as `bash <line>`.

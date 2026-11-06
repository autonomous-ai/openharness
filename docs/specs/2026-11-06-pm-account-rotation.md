# A PM moves between its machine's Claude accounts by itself (Diego, 2026-11-06)

Mockup: `desktop/mockup/pm-account-rotation.html` (main checkout, gitignored).

## What Diego asked

A project's PM spends its Claude account fast. When the account runs out, the PM stops, every task waiting on it stops,
and the machine's owner has to sign in again by hand to change accounts. Diego wants:

- the owner signs in several Claude accounts on the machine that runs the PM;
- the PM moves to another of them by itself when its own runs low;
- the PM keeps working as before: **the same conversation**, nothing for anyone to do;
- it works on a machine with no screen (a server), from the command line.

His choices:
- keep the conversation, not a fresh PM from a handoff;
- move before the account runs out, between two turns;
- only accounts the machine's owner ticks for the PM;
- pick the ticked account with the most quota left.

## Proven on Diego's Mac (spike, 2026-11-06)

- A Claude session started on account A (`CLAUDE_CONFIG_DIR` = A's folder, one turn with thinking) was resumed with
  `claude --resume <id>` on the default account and answered from its history (`kiwi-7319`). There was no
  thinking-signature error, and it took 8 s.
- That turn re-created about 24k tokens of prompt cache and read about 11.6k from cache. The first turn after a move
  costs the new account somewhat more.
- An account out of quota answers `You've hit your weekly limit · resets Nov 10 at 6pm (Asia/Saigon)`. The 5-hour
  window says the same with its own words.
- Orca does this today. Each account is a `CLAUDE_CONFIG_DIR` folder, and its `projects/`, `history.jsonl`, `todos`,
  `file-history` and `session-env` are symlinks to `~/.claude`, so every account sees every session. Claude Code keeps
  one Keychain item per folder (`Claude Code-credentials-<hash>`). On Linux the token is `<folder>/.credentials.json`.
- Claude Code signs in from a terminal: `claude auth login` prints a link to open on any device; `claude auth status`
  checks it.

## How it works today (main e1b13d205)

- **Claude accounts on a machine:** `cli/src/lib/claudeProfiles.ts` (`listClaudeProfiles`, `linkClaudeProfile`,
  `profileHome`); Desktop's Add Claude account makes folders under `~/.harness/claude-profiles/`. A profile's
  `projects/` is its own folder, not shared.
- **Quota per account:** `lib/accountUsage.ts` `readAccountUsage`, parsed by `superTabs/capacity.ts` `quotaOf` into
  5-hour and weekly windows. `superTabs/machines.ts` reads each profile at most every 3 minutes (5 after an HTTP 429).
- **The PM here:** a roster row with `lead === true` whose agent runs on this machine (`superTabs/host.ts:1287`). Its
  registry row holds `sessionId`, `claudeHome` and `transcriptPath`.
- **A limit hit** is read off the screen every 15 s (`superTabs/terminal.ts` `LIMIT_LINE`, `limitOf`) and raised as
  `agent.alert limit`. Workers resume after the reset (`limitResume.ts`); a PM just stops.
- **Relaunch in the same pane:** `core/agents/swap.ts`, used by `agent_restart`, resumes the same session. But
  `claudeHome` is fixed once set (`lib/registry.ts:1626`), and no request changes it. The PM switch
  (`leadSwitchRequest.ts`) starts a new session from a handoff instead.
- `superTabs/pmAccounts.ts` is unrelated: it tells routing which accounts a PM runs on.

## Behaviour

### The PM's accounts

- On the machine that runs a PM, the owner picks which Claude accounts the PM may use: the default login and any linked
  or added profile. The list is the machine's, kept in the daemon's data folder, and only its owner can change it.
  Nothing about it leaves the machine except, as today, an account's short label and quota for routing.
- From the command line (works with no screen):
  - `harness pm accounts` lists this machine's Claude accounts: label, email, 5-hour and weekly quota left, and whether
    the PM may use it and runs on it now.
  - `harness pm accounts add` makes a new profile folder, runs `claude auth login` in it in the terminal (the person
    opens the link on any device), links it, and lets the PM use it.
  - `harness pm accounts use <account>…` and `harness pm accounts use --off <account>…` tick and untick.
- On Desktop, the machine's Claude accounts list gets a "PM may use" tick, quota meters and each account's state:
  PM is here, Ready, Out until …, Sign in again.
- With fewer than two ticked accounts, nothing moves. The PM runs on its account as today.

### When the PM moves

- **Low:** the PM's account has under **5%** left in its 5-hour or weekly window. The PM moves at its next pause between
  two turns. If it is never idle for **10 minutes**, it moves anyway at the next turn end.
- **Out:** the screen shows a limit line for the PM. It moves at once. When the new process is ready it types
  `Continue` (as `limitResume.ts` does for workers), so the interrupted turn is taken up again.
- **Which account:** among the ticked accounts that are signed in and have over 5% left in both windows, the one with
  the most left in its tighter window. On a tie, the one whose weekly window resets soonest.
- **How:** the same pane relaunches the same session, `claude --resume <sessionId>`, under the new account's
  `CLAUDE_CONFIG_DIR`. When the two accounts' `projects/` folders are different folders, the session's transcript is
  copied into the new one first; the old copy stays. Agent id, project, Swarm binding, pane and permission mode stay
  the same.
- One move at a time per PM, and no new move within **2 minutes** of the last one.
- While the PM is relaunching, deliveries wait in the queue, as they do for any restart.

### Telling people

- The machine's owner gets one line in their Buddy chat per move: "River moved to <label>: <old label> had <n>% of its
  <window> left. Same conversation." The PM itself sends it with `person.tell`.
- The move is written to the daemon log and to a history file on the machine: the last 200 moves, each with the time,
  from, to, why (low or out), and how long the PM was away. `harness pm accounts history` prints it.

### When every ticked account is out

- The PM stays stopped on its current account.
- The owner is told once per reset window: "River is paused: every Claude account it may use is out. The earliest
  resets at <time> (<label>)."
- At that reset the PM moves to that account (or continues on its own, if it is its own) and types `Continue`.
- Nothing waits silently: the existing `agent.alert limit` still marks the PM as limited for the Swarm.

### Out of scope

- The PM line and the "paused" banner for a project's members, and showing the move to anyone but the owner. They need
  the backend to carry the account; that is a follow-up.
- Codex and other engines. Claude only.
- Workers. They already route by quota.
- Moving a PM to another machine. That is the PM switch.

## Risks

- **Terms:** whether rotating one workload over several personal Claude subscriptions is allowed by Anthropic's
  consumer terms is not checked here. Diego or Ken should check before turning it on beyond our own Swarms. Accounts
  belonging to different people who chose to lend them fit Harness's contribution model better.
- **Cache cost:** each move re-creates the conversation's prompt cache on the new account (measured: ~24k tokens for a
  small session; more for a long-running PM).
- **Claude Code changes:** resume across accounts relies on Claude Code keeping a session usable under another login.
  The spike proved it on 2.1.319. A failed resume (the process exits or shows an error within 30 s) falls back to the
  PM's previous account and tells the owner.

## Design

- **Growth:** one small pool file and a history file capped at 200 lines; copied transcripts are one file per move,
  removed by Claude Code's own cleanup as any session file.
- **Concurrency:** one move per PM at a time (the restart coordinator's lock); the 2-minute pause stops ping-pong.
- **Read cost:** quota is read from the readings routing already keeps (every 3 min per profile), no new polling.
- **Scale:** per machine, one PM per project it hosts; at 10 PMs the quota reads are unchanged (shared cache).
- **Compatibility:** a daemon without this feature runs the PM as today. A Desktop without it does not show the tick;
  the CLI still works. The restart request's new field is optional.
- **Migration + rollback:** none; unticking every account (or fewer than two) turns it off.
- **Audience:** only the machine's owner reads or changes the pool and history (owner-only requests).
- **Identity:** the PM runs under an account its machine's owner signed in and ticked; never another person's.
- **Failure:** a failed move falls back and says so; all accounts out says so with the reset time.
- **Platforms:** CLI and daemon on macOS, Linux and Windows; Desktop on macOS, Linux and Windows.

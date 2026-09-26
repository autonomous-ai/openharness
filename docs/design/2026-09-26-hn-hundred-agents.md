# hn with a hundred agents

A draft for discussion, 26 September 2026. It follows [hn's default look](2026-09-26-hn-default-look.md),
and a look at hn from the inside: this was written by a Claude Code session that the user was watching in hn.

## What the agent already shows

Here is a Claude Code pane in hn, as it looked while it worked:

```
── 1 "hn" [working] ──────────────────────────────────────────────────── M2 ──
● Bash(echo "pane: ${TMUX_PANE:-none}"; [ -n "$TMUX_PANE" ] && tmux display …)
  ⎿ pane: %15
    … +27 lines (ctrl+o to expand)
✶ Honking… (1m 4s · ↓ 3.1k tokens · thinking more with max effort)
──────────────────────────────────────────────────────────────────────────────
❯
──────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt   ◎ /goal active (10h)
  ● main
  ○ general-purpose  Testing hn new -A -s main startup     26m 50s · ↓ 275.7k tokens
  ○ fork             Re-running ct_t4.py tree comparisons  26m 14s · ↓ 945.6k tokens
```

Inside its own pane, the agent already shows:

- that it's working, for how long, and how many tokens it has used;
- each step it takes, with the results folded;
- its mode, its goal and its queued messages;
- its own sub-agents, each with what it's doing right now.

**hn should repeat none of that.** The title's `[working]` says what the spinner already says.

## What only hn can show

An agent knows only about itself. With a hundred of them, the work is choosing where to look next. That
needs what no single pane has:

1. **Who needs you, across all of them.** In order: a question or a permission first, then a failure, then
   a finished turn you haven't read. With auto-approve, most sessions end as "done". A done agent is idle
   until you give it the next task, so reading them is your bottleneck.
2. **One line per session.** For one that needs you, the question. For one that's working, what it's doing
   now (`Running npm test`). For one that's done, what it did (`Invoices use Decimal; 3 tests added`). For
   one that failed, why.
3. **Where it works.** Machine, project and branch. Later, the PR and whether CI passed.
4. **How long.** Working 12m, waiting on you 3m, idle 2h. That's how you spot a stuck session.
5. **What it costs.** Tokens per session, and in total.
6. **The fleet in numbers.** A count per state, always on screen.
7. **Who has the keyboard.** When another window has a session, only hn knows (`[watching]`).

## The screens

### 1. Working: the status line counts the fleet

```
── ⠹ Fix flaky login test ──── webapp git:(fix/login-flake) ──┬── ? Add rate limiting to the API ── git:(feat/rate-limit) ──
✳ Fix flaky login test                                         │✳ Add rate limiting to the API
…                                                              │…
[studio] 0:? Fix flaky login test* 1:✓ Refactor billing…#       ?2 ✓5 ✗1 ⠹41 ·54  webapp git:(fix/login-flake) 13:40
```

The pane titles and the window list stay as they are now. On the right of the status line, `1 waiting` becomes
the whole fleet: `?2 ✓5 ✗1 ⠹41 ·54` (103 sessions). A state with none drops out, so on a quiet day it reads
`⠹3 ·8`.

### 2. `C-b s`: every session, the most urgent at the prompt

```
  · Docs pass on the API               studio   api      docs              idle                                       2h
  · Bump dependencies                  gpu-box  monorepo deps/bump         idle                                       5h
  ⠹ Write the release notes 2.4        studio   webapp   main              Editing CHANGELOG.md                       3m
  ⠹ Upgrade React to 19                studio   webapp   react-19          Running npm test                          12m
  ✗ Train tokenizer on the new corpus  gpu-box  ml-lab   exp/tokenizer-v3  CUDA out of memory at step 1200            1h
  ✓ Fix flaky login test               studio   webapp   fix/login-flake   Fixed the token-refresh race; CI green    11m
  ✓ Refactor billing service           studio   billing  refactor/invoic…  Invoices use Decimal; 3 tests added        4m
  ? Migrate auth to OAuth              gpu-box  web      oauth             Allow rm -rf build/? (Bash)                9m
▌ ? Add rate limiting to the API       studio   api      feat/rate-limit   Rate limit per API key or per IP?          2m
  103/103 ─ ?2 ✓5 ✗1 ⠹41 ·54 ──────────────────────────────────────────────────────────────────────────────────────────
> 
```

This is the list `C-b s` already is: fzf, with the query matching names, projects, branches and machines. It
gets two changes:

- **The order.** With no query, the most urgent sits nearest the prompt: needs you, failed, done, working,
  idle. Within each state, the one waiting longest comes first.
- **The line and the age.** Each row gets the one line from above and how long it has been in its state.

The preview (`C-/`) shows the selected session's live screen. The keys are the ones `C-b s` already has:
`Enter` to go there, `C-v` / `C-x` / `C-t` to open beside, below or in a new window, `Tab` to mark several.

### 3. `C-b a`: the loop

`C-b a` already goes to the next harness waiting on you. It widens to the same order as the list: needs you,
then failed, then done and unread, oldest first. It shows each where you are, and opens it if it isn't open.
Read, reply, `C-b a`, and so on down the counts on the status line. Looking at a done session makes it idle
(`✓` becomes `·`), so the loop ends at zero.

These are tmux-shaped. A done session is already tmux's activity alert (`#`) and one that needs you a bell
(`!`), so `C-b M-n` (next window with an alert) works as well.

## Where the data comes from

| | Source | Status |
|---|---|---|
| State | turn events, questions | hn has it |
| The question | `commander_question` | hn has it |
| Doing now | `tool_start` with the tool and its input (`Bash: npm test`) | the events reach hn; the text needs writing |
| What it did | the turn's last message (`LastTurnText`), its first line | the daemon has it; needs sending to windows |
| Or a written recap | the daemon's one-shot recap (`turn_summary`) | today only while a dial is attached |
| How long | when each state began | hn has it |
| Tokens | `agentTokenUsage` | the daemon has it; needs a field on the rows |
| PR and CI | `gh` | later |

## Questions for you

1. The whole fleet in counts on the status line (`?2 ✓5 ✗1 ⠹41 ·54`), in place of `1 waiting`?
2. For "what it did": the agent's own last line (free, but sometimes vague), or a written recap (an LLM
   call per finished turn)?
3. Should `C-b a` include finished sessions, not only questions?

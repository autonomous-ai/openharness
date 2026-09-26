# hn's default look: mockups

A draft for discussion, 26 September 2026. It follows the
[vi → Vim → Neovim research](../research/2026-09-26-vi-vim-neovim-ui.md): tmux's keys and layout stay
exact, and hn changes the defaults, as Neovim did for Vim. Each screen below is today's real capture
(100 × 30, the demo fleet) with only hn's own chrome changed.

## Rules

- **tmux's skeleton:** the status line at the bottom, the window list on its left, a title row over each
  pane (`pane-border-status top`), and the same keys.
- **Agent state goes where tmux already has room:** the pane's title row, the window list, and the right
  side of the status line.
- **State comes first,** so it survives when a title is cut.
- **The same symbols as the harness list (`C-b s`).**
- **New surfaces appear only when asked for** (C below).
- **A user's `.tmux.conf` styling always wins,** and one line brings back plain tmux
  (`set -g @hn-look tmux`).

## Symbols and colours

The colours are the terminal's own 16, so they follow dark, light and Solarized themes.

| | Meaning | Colour |
|---|---|---|
| `◆` | waiting on you | yellow, tmux's own attention colour (copy mode, messages) |
| `●` | working | green |
| `✓` | finished, not looked at yet | default |
| `○` | idle | dim |
| `‖` | paused | dim |
| `✗` | failed | red |

Engines: `✳` Claude, `◎` Codex, `❯` terminal.

## Today

```
──0 "Fix flaky login test" [working]──── studio ──┬──1 "Add rate limiting to the API" [w…───────────
✳ Fix flaky login test                            │                                                 
                                                  │> add rate limiting to the api                   
> fix flaky login test                            │                                                 
                                                  │⏺ Reading src/api/handler.ts                     
⏺ Reading src/webapp/handler.ts                   │⏺ Running npm test -- api                        
⏺ Running npm test -- webapp                      │  ✓ 41 passed  ✗ 1 failed                        
  ✓ 41 passed  ✗ 1 failed                         │⏺ The failure is a race in the session refresh — 
⏺ The failure is a race in the session refresh — t│the token is read                                
  before the refresh promise settles. Fixing it an│  before the refresh promise settles. Fixing it a
                                                  │nd re-running.                                   
────────────────────────────────────────          │                                                 
❯                                                 │────────────────────────────────────────         
                                                  │❯                                                
                                                  ├──2 "gpu-box shell"─────────────────── gpu-box ──
                                                  │dev@gpu-box:~/ml-lab$ nvidia-smi --query-gpu=name
                                                  │,utilization.gpu --format=csv                    
                                                  │name, utilization.gpu [%]                        
                                                  │NVIDIA RTX 4090, 97 %                            
                                                  │NVIDIA RTX 4090, 95 %                            
                                                  │dev@gpu-box:~/ml-lab$                            
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
[studio] 0:Fix flaky login test*             1 waiting "gpu-box shell" gpu-box \_O_/ 10:10 26-Sep-26
```

What's wrong:

1. **The most important state is cut off.** `[w…` should say "waiting on you".
2. **The status line repeats the active pane's title** ("gpu-box shell"), and says "1 waiting" without
   saying who.
3. **Nothing says which engine a harness runs or how long it has been in its state.**

## A: words in tmux's slots

```
──0 working · Fix flaky login t claude · studio ──┬──1 waiting on you · Add rate limiting t codex ──
✳ Fix flaky login test                            │                                                 
                                                  │> add rate limiting to the api                   
> fix flaky login test                            │                                                 
                                                  │⏺ Reading src/api/handler.ts                     
⏺ Reading src/webapp/handler.ts                   │⏺ Running npm test -- api                        
⏺ Running npm test -- webapp                      │  ✓ 41 passed  ✗ 1 failed                        
  ✓ 41 passed  ✗ 1 failed                         │⏺ The failure is a race in the session refresh — 
⏺ The failure is a race in the session refresh — t│the token is read                                
  before the refresh promise settles. Fixing it an│  before the refresh promise settles. Fixing it a
                                                  │nd re-running.                                   
────────────────────────────────────────          │                                                 
❯                                                 │────────────────────────────────────────         
                                                  │❯                                                
                                                  ├──2 idle · gpu-box shell ───────────── gpu-box ──
                                                  │dev@gpu-box:~/ml-lab$ nvidia-smi --query-gpu=name
                                                  │,utilization.gpu --format=csv                    
                                                  │name, utilization.gpu [%]                        
                                                  │NVIDIA RTX 4090, 97 %                            
                                                  │NVIDIA RTX 4090, 95 %                            
                                                  │dev@gpu-box:~/ml-lab$                            
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
[studio] 0:Fix flaky login test*               1 waiting: Add rate limiting (C-b a)  10:10 26-Sep-26
```

Plain text in tmux's colours. The state reads as words, so names get cut early at this width.

## B: state first, in colour (recommended)

```
── ● Fix flaky login test ───────── ✳ studio 4m ──┬── ◆ Add rate limiting to the API  ◎ studio 2m ──
✳ Fix flaky login test                            │                                                 
                                                  │> add rate limiting to the api                   
> fix flaky login test                            │                                                 
                                                  │⏺ Reading src/api/handler.ts                     
⏺ Reading src/webapp/handler.ts                   │⏺ Running npm test -- api                        
⏺ Running npm test -- webapp                      │  ✓ 41 passed  ✗ 1 failed                        
  ✓ 41 passed  ✗ 1 failed                         │⏺ The failure is a race in the session refresh — 
⏺ The failure is a race in the session refresh — t│the token is read                                
  before the refresh promise settles. Fixing it an│  before the refresh promise settles. Fixing it a
                                                  │nd re-running.                                   
────────────────────────────────────────          │                                                 
❯                                                 │────────────────────────────────────────         
                                                  │❯                                                
                                                  ├── ○ gpu-box shell ───────────────── ❯ gpu-box ──
                                                  │dev@gpu-box:~/ml-lab$ nvidia-smi --query-gpu=name
                                                  │,utilization.gpu --format=csv                    
                                                  │name, utilization.gpu [%]                        
                                                  │NVIDIA RTX 4090, 97 %                            
                                                  │NVIDIA RTX 4090, 95 %                            
                                                  │dev@gpu-box:~/ml-lab$                            
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
[studio] 0:● Fix flaky login test*            ◆ Add rate limiting · 2m  C-b a  \_O_/ 10:10 26-Sep-26
```

- **Each title:** the state symbol, the name, then the engine, the machine and the time in that state.
- **The waiting pane's title row** turns yellow (reversed).
- **The status line** says who is waiting and how to get there (`C-b a`).
- **The window list** shows each window's most urgent state (`◆`, then `●`, then `○`), alongside tmux's own
  `!` flag.

## C: answer in place (on demand)

```
── ● Fix flaky login test ───────── ✳ studio 4m ──┬── ◆ Add rate limiting to the API  ◎ studio 2m ──
✳ Fix flaky login test                            │                                                 
                                                  │> add rate limiting to the api                   
> fix flaky login test                            │                                                 
                                                  │⏺ Reading src/api/handler.ts                     
⏺ Reading src/webapp/handler.ts                   │╭─ ◆ asked 2m ago ──────────────────────────────╮
⏺ Running npm test -- webapp                      ││ Rate limit per API key or per IP?             │
  ✓ 41 passed  ✗ 1 failed                         ││ ▌ 1 Per API key                               │
⏺ The failure is a race in the session refresh — t││   2 Per IP                                    │
  before the refresh promise settles. Fixing it an││   3 Both                                      │
                                                  ││   4 Something else…                           │
────────────────────────────────────────          │╰─ 1-4 answer · enter · esc later · C-b a next ─╯
❯                                                 │────────────────────────────────────────         
                                                  │❯                                                
                                                  ├── ○ gpu-box shell ───────────────── ❯ gpu-box ──
                                                  │dev@gpu-box:~/ml-lab$ nvidia-smi --query-gpu=name
                                                  │,utilization.gpu --format=csv                    
                                                  │name, utilization.gpu [%]                        
                                                  │NVIDIA RTX 4090, 97 %                            
                                                  │NVIDIA RTX 4090, 95 %                            
                                                  │dev@gpu-box:~/ml-lab$                            
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
[studio] 0:● Fix flaky login test*            ◆ Add rate limiting · 2m  C-b a  \_O_/ 10:10 26-Sep-26
```

When an agent asks something, `C-b a` (or a click on `◆`) docks the question in its pane, like fzf's
list. `1`–`4` answer without typing into the agent, Esc leaves it for later, and `C-b a` moves on to the
next harness waiting. Nothing appears until you ask, the way Vim's popups work.

## Decisions for you

1. A or B as the first-launch look?
2. Symbols (`◆ ● ○`) or words (waiting, working, idle)?
3. The status line's right side: who's waiting and the clock, dropping the pane title tmux shows there,
   since it's already in the pane's own title row?
4. C: docked in the waiting pane (as drawn), or at the bottom of the screen above the status line, like
   fzf's list?
5. Keep tim (`\_O_/`) in the status line?

---

## Round 2, after review (26 September)

What changed:

- **The agents' own UIs already show what they are doing.** Claude Code and Codex draw their status at the
  bottom of their panes, so hn doesn't repeat it.
- **hn still owes a glance.** One symbol per pane says which one needs you, which is working, which is done
  and which is idle, across every pane at once.
- **Questions are rare now** (most people run with auto-approve), so answering in place (C) is shelved.
- **No machine name in pane titles.**
- **Project and branch matter** and have to be somewhere. The desktop app shows them for the focused pane
  in its status bar, drawn in zsh prompt styles (Pure, Starship, Powerlevel10k); an earlier version put
  them in each pane's title.

The symbols follow [Orca](https://www.onorca.dev/docs/model/agents-sessions), which uses one set on every
agent tab and sidebar row:

| | State | Colour |
|---|---|---|
| `⠹` | working (a spinner, animated) | default |
| `?` | needs you: a question or a permission | amber |
| `✓` | done, not looked at yet | green |
| `·` | idle | grey |
| `✗` | failed, blocked or interrupted | red |
| (none) | a plain shell | |

### A2: project and branch in every title

```
── ⠹ Fix flaky login t webapp · fix/login-flake ──┬── ? Add rate limiting to t api · feat/rate-l… ──
✳ Fix flaky login test                            │                                                 
                                                  │> add rate limiting to the api                   
> fix flaky login test                            │                                                 
                                                  │⏺ Reading src/api/handler.ts                     
⏺ Reading src/webapp/handler.ts                   │⏺ Running npm test -- api                        
⏺ Running npm test -- webapp                      │  ✓ 41 passed  ✗ 1 failed                        
  ✓ 41 passed  ✗ 1 failed                         │⏺ The failure is a race in the session refresh — 
⏺ The failure is a race in the session refresh — t│the token is read                                
  before the refresh promise settles. Fixing it an│  before the refresh promise settles. Fixing it a
                                                  │nd re-running.                                   
────────────────────────────────────────          │                                                 
❯                                                 │────────────────────────────────────────         
                                                  │❯                                                
                                                  ├── gpu-box shell ─────────────── ml-lab · main ──
                                                  │dev@gpu-box:~/ml-lab$ nvidia-smi --query-gpu=name
                                                  │,utilization.gpu --format=csv                    
                                                  │name, utilization.gpu [%]                        
                                                  │NVIDIA RTX 4090, 97 %                            
                                                  │NVIDIA RTX 4090, 95 %                            
                                                  │dev@gpu-box:~/ml-lab$                            
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
[studio] 0:? Fix flaky login test*  1:✓ Refactor billing  2:⠹ Train tokenizer        10:10 26-Sep-26
```

At 50 columns a pane can't hold the name, the project and the branch, so the names get cut first.

### B2: the focused pane's project and branch in the status line (recommended)

```
── ⠹ Fix flaky login test ────────────────────────┬── ? Add rate limiting to the API ───────────────
✳ Fix flaky login test                            │                                                 
                                                  │> add rate limiting to the api                   
> fix flaky login test                            │                                                 
                                                  │⏺ Reading src/api/handler.ts                     
⏺ Reading src/webapp/handler.ts                   │⏺ Running npm test -- api                        
⏺ Running npm test -- webapp                      │  ✓ 41 passed  ✗ 1 failed                        
  ✓ 41 passed  ✗ 1 failed                         │⏺ The failure is a race in the session refresh — 
⏺ The failure is a race in the session refresh — t│the token is read                                
  before the refresh promise settles. Fixing it an│  before the refresh promise settles. Fixing it a
                                                  │nd re-running.                                   
────────────────────────────────────────          │                                                 
❯                                                 │────────────────────────────────────────         
                                                  │❯                                                
                                                  ├── gpu-box shell ────────────────────────────────
                                                  │dev@gpu-box:~/ml-lab$ nvidia-smi --query-gpu=name
                                                  │,utilization.gpu --format=csv                    
                                                  │name, utilization.gpu [%]                        
                                                  │NVIDIA RTX 4090, 97 %                            
                                                  │NVIDIA RTX 4090, 95 %                            
                                                  │dev@gpu-box:~/ml-lab$                            
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
                                                  │                                                 
[studio] 0:? Fix flaky login test*  1:✓ Refactor billing  2:⠹ Train   webapp  fix/login-flake  10:10
```

- **Pane titles** carry the state and the whole name.
- **The window list** carries each window's most urgent state.
- **The status line's right side** shows the focused pane's project and branch, as the desktop app does.
  When a pane is wide enough, its own title can add its branch too.

Questions:

1. B2, with the branch added to wide titles?
2. Should the spinner animate (Orca's does), or should working be a still `●`?
3. Should the status line use your zsh prompt style for the project and branch, as the desktop app can?

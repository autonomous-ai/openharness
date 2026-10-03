# Terminal tools market: tmux, fzf, Vim, VS Code, Cursor

Research date: September 26, 2026. Estimates, not counts: no survey asks about tmux or fzf, and the
survey-based figures are ceilings (see Method). Revisit when the Stack Overflow 2026 survey lands.

**tmux has roughly 3–7M developer users: about the size of Neovim, fzf and Cursor, and a tenth of VS
Code's ~40M. The growth is in AI agents, not terminal tools: Claude Code's yearly Homebrew installs
are already twice tmux's.**

- **A small, influential core.** tmux, fzf and Neovim users are largely the same people. Keeping
  tmux's keys, `~/.tmux.conf` and fzf's behaviour exact is how `hn` earns them.
- **Beside the editor, not instead of it.** 78% of Vim/Neovim users also use VS Code or Cursor; only
  about 2% of developers use terminal editors alone.
- **Agents are the growth.** Agent use at work went from 31% to 59% in a year. Most of those users
  never learned tmux, so `hn`'s first run must need no tmux knowledge.
- **Mac and Linux first, zsh first.** Claude Code users are 56% on macOS at work (38% overall) and
  only about 12% Windows-only.

## Users by tool

Base: about 47M developers worldwide ([SlashData, Q1 2025][slashdata]). "SO" is the Stack Overflow
Developer Survey 2025.

| Tool | Users (est.) | Basis | Confidence |
|---|---|---|---|
| VS Code | ~40M | Microsoft: "40M developers" ([Jan 2025][vscode-40m]); Visual Studio and VS Code together 50M monthly ([May 2025][vs-50m]); SO 76% (74% in 2023–24) | High |
| zsh | 15M+ | Default shell on macOS; 33–38% of developers use macOS at work (SO) | Low |
| Vim | ~8–12M | SO 24% (22% in 2023–24); installed by default almost everywhere, so much of the use is incidental | Medium |
| Cursor | 1M+ daily; ~2–8M monthly | ~1M daily users ([Bloomberg, Apr 2025][cursor-1m]); $1B annual revenue ([Nov 2025][cursor-d]), $2B ([Mar 2026][cursor-2b]); SO 18% gives an ~8M ceiling | Medium-low |
| Neovim | ~4–7M | SO 14% (12% in 2023); 45% of Arch machines; 103k GitHub stars | Medium |
| tmux | ~3–7M, plus servers | Installs track Neovim's: Homebrew #31, 552k a year (1.1× Neovim); 46% of Arch machines (1.04× Neovim); used regularly on 10% of Debian machines (2× GNU screen); 50k stars | Low |
| fzf | ~3–7M | Homebrew #30, 556k a year; 58% of Arch machines; 83k stars | Low |
| oh-my-zsh | Likely millions | 190k GitHub stars, about VS Code's 193k; no install data | Low |

Yearly Homebrew installs, for the agents against the terminal tools:

| Formula | Installs, 365 days to 2026-09-26 |
|---|---|
| claude-code | 1.13M |
| codex | 0.82M |
| fzf | 0.556M |
| tmux | 0.552M |

The agent counts leave out their own self-updates, so the real gap is larger.

## What it means for hn

`hn` has two audiences: the tmux tribe (about 5M people, small but loud) and agent users (growing
fast, mostly new to tmux). Build for the first, design the first run for the second.

1. **Win the tmux tribe with exactness.** tmux, fzf and Neovim sit together: Homebrew #30, #31 and
   #38, and 45–58% of Arch machines. They notice every wrong key, and they write the blog posts,
   dotfiles and Hacker News comments that everyone else reads.
2. **Sit beside VS Code and Cursor.** Only about 2% of developers use terminal editors alone. `hn`
   runs the agents; the editor edits. The shared desk (the desktop app, `hn` and mobile on one set of
   tabs) fits how these people already work.
3. **Design the first run for agent users.** Agent use at work rose from 31% (2025) to 59% in an
   [April 2026 Stack Overflow pulse survey][so-pulse] of about 1,100 developers, and about 1 in 3 agent
   users already run several agents at once, which is what `hn` is for. Most never learned tmux: the
   home screen, the fzf list, `C-b ?` and the mouse have to carry them.
4. **Launch on Mac and Linux, zsh first.** Claude Code users over-index on macOS at work (56% against
   38%) and on Neovim (19% against 14%); about 12% are Windows-only, and 47% also use Cursor. Vim and
   Neovim users adopt agents slightly less than average (about 0.9×).

## Method and caveats

- Survey percentages are applied to the 47M base, so they are ceilings: Stack Overflow's
  respondents are more engaged than the average developer. SO 2025 had 49k respondents, 26k of whom
  answered the IDE question ([raw data][so-raw]).
- The 78% overlap, the ~2% terminal-only share and the Claude Code cuts (macOS, Neovim, Cursor,
  Windows-only) are our own cuts of the SO 2025 raw data.
- [Homebrew][brew] counts install-on-request events over 365 days, including upgrades: events, not
  people. Ranks are out of about 87k formulae.
- [Arch pkgstats][arch] (32.7k systems, Aug 2026) and [Debian popcon][debian] (291k installs, mostly
  servers) are opt-in samples that lean toward enthusiasts and servers.
- GitHub stars were read from the GitHub API on 2026-09-26. They measure attention, not use.

## Open questions

- The Stack Overflow 2026 survey: re-check the Vim, Neovim, VS Code and Cursor shares when it is
  published.
- A direct tmux number: no survey asks. An opt-in question in `hn` or our own survey would be the
  first real count.
- Cursor's monthly users: the 2–8M range is wide; watch for an official figure.
- How many agent users run agents on more than one machine, which is `hn`'s multi-machine case.
- The Windows share among agent users over time (WSL2 against native Windows).

## Sources

- [SlashData: global developer population trends 2025][slashdata]
- [Stack Overflow Developer Survey 2025 raw data][so-raw]
- [Stack Overflow: "Agents on a leash", April 2026 pulse survey][so-pulse]
- [Runtime: VS Code helped Microsoft win developers (40M), Jan 2025][vscode-40m]
- [Microsoft: celebrating 50 million developers, May 2025][vs-50m]
- [Bloomberg: Cursor draws a million users, Apr 2025][cursor-1m]
- [Cursor: Series D, Nov 2025][cursor-d]
- [Bloomberg: Cursor's recurring revenue doubles to $2B, Mar 2026][cursor-2b]
- [Homebrew install-on-request analytics, 365 days][brew]
- [Arch Linux pkgstats: tmux][arch]
- [Debian popularity contest, by installs][debian]

[slashdata]: https://www.slashdata.co/post/global-developer-population-trends-2025-how-many-developers-are-there
[so-raw]: https://github.com/StackExchange/Survey/tree/main/packages/archive/2025
[so-pulse]: https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-monitored-at-work/
[vscode-40m]: https://www.runtime.news/visual-studio-code-helped-microsoft-win-developers-new-ai-coding-editors-want-to-own-the-future/
[vs-50m]: https://developer.microsoft.com/blog/celebrating-50-million-developers-the-journey-of-visual-studio-and-visual-studio-code/
[cursor-1m]: https://www.bloomberg.com/news/articles/2025-04-07/cursor-an-ai-coding-assistant-draws-a-million-users-without-even-trying
[cursor-d]: https://cursor.com/blog/series-d
[cursor-2b]: https://www.bloomberg.com/news/articles/2026-03-02/cursor-recurring-revenue-doubles-in-three-months-to-2-billion
[brew]: https://formulae.brew.sh/analytics/install-on-request/365d/
[arch]: https://pkgstats.archlinux.de/packages/tmux
[debian]: https://popcon.debian.org/by_inst

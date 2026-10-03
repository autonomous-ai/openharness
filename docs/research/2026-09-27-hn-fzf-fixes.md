# hn picker fixes before round 19

Compared the release build based on `af2971ee`, with the current compatibility fixes, against
fzf 0.67.0 inside tmux 3.5a. Each comparison checks captured characters, foregrounds,
backgrounds, attributes and visible cursor positions.

## Fixed

- Hiding the input removes its entire section box and gives the space to the list.
- All four section `--*-label-pos` options use fzf's columns and bottom-edge placement.
- List/header borders leave the separator its full width; list-border clicks do not select rows.
- Right-click, shift-click and shift-wheel respect `--multi` and `change-multi`.
- `--black` and `--no-black` follow fzf's background precedence.
- Decomposed accents and Thai text use fzf's horizontal scroll offsets.
- Jump labels work with an empty pointer; striped padding and jump/jump-cancel events match.
  A jump event that changes the query retains the previous search until an ordinary query edit,
  including across a fleet refresh, as the reference does.
- `--info-command` retains ANSI output, uses the configured shell, and receives selection,
  position, match/total counts, geometry, prompt, input state and raw-match context.
- ANSI prompts retain configured attributes and reproduce fzf's reset/trailing-space rules.
- Session search shows the info spinner during debounce and pending machine replies. Old
  replies cannot finish a newer search's spinner. General spinners use 100 ms frames.
- `--raw` retains input-order nonmatches, with the raw gutter and `nomatch` style. Matching counts,
  `best`, match-only movement, raw toggles and matching-only bulk selection follow fzf. Leaving
  raw mode retains the nearest match and removes nonmatching marks.

## Verification

The guarded scripts and captures are in `/tmp/hnf19fix/`:

| Check | Result |
| --- | --- |
| `misc17.py`: jump, info commands and input visibility | 23 cases identical; jump-cancel also rechecked separately after its final fix |
| `layout19.py`: labels, black, ANSI prompts, input boxes | 14/14 identical |
| `mouse17.py`: marking, section/border clicks and dragging | 10/10 identical with drag motions sent separately |
| `sb18c.py`: list/header/footer separator combinations | 10/10 identical |
| `thai17.py`: NFD/Thai text at three widths | All 12 snapshots identical |
| `raw19.py` and `raw-edge19.py` | 15/15 identical, including wrapping, styles, toggles, selection and environment values |
| `spinner19.py`: mock replies delayed 900 ms | All ten spinner frames observed; spinner cleared after the replies |
| Release unit suite | 103 passed |

A burst containing several scrollbar drag motions is timing-dependent in real fzf: identical
bursts produced two different final offsets on separate runs. The staged motion comparison
passes. No speculative drag change was retained. Hidden cursor coordinates are excluded when
both programs hide the cursor; their captured cells are still compared.

Every hn process used a private frozen binary, `hnf19fix` sockets, a throwaway home, and mock
ports 19420–19427 behind a guard rejecting other ports. No default server or real daemon was
used. The scripts stop their own mocks, tmux servers and detached hn processes.

This is a targeted fix report, not a new panel score or a claim that the older fzf backlog is empty.

# hn fzf round 19 fixes

Fixed the five findings in the round 19 fzf report and the retained preview `+N`/`~N`
limitation. Comparisons used fzf 0.67.0 and tmux 3.5a, starting from the reviewed
`32f43bb0d541445c312b739d39c2d9265ca45c6a` build and then private frozen copies of the fixes.

- OR-only session searches discover each necessary alternative, combine replies, and deduplicate
  conversations. Returned titles, metadata and complete snippets pass the full Boolean expression
  before being offered. The original row detail remains searchable when a snippet replaces it.
- Bound `search(...)` uses the effective expression for index requests while leaving the input
  unchanged. Query generations isolate pending replies and the spinner, including search actions
  fired by jump events.
- Every action in a chain reads the current multi-selection setting. `change-multi+toggle` now
  marks immediately.
- All four dynamic section labels retain ANSI attributes; the root agent's fix was preserved and
  compared directly.
- Keyword fallback uses the matcher's original AND/OR groups, including negation. The query
  `bindings | !zz $` returns zero rows on the review fixture, as fzf does.
- Preview offsets survive the narrow-layout fallback. Explicit `+N` takes precedence over the
  automatic position at a conversation's newest turn, including when its tail arrives later.
  `~N` headers stay fixed; scroll limits, scrollbar, full/half pages, bottom, follow, oversized
  headers, and dynamic window changes match the measured reference cases.

## Checks

The guarded drivers, frozen copies and captures are in `/tmp/hnf19fix-r20/`.

| Driver | Result |
| --- | --- |
| `actions19.py` | All five cases identical: multi chains and four ANSI labels |
| `edges19.py` | All six cases identical, including the keyword OR-negation query |
| `sessions19.py` | OR query gives 2/9; bound search adds two RPCs and gives 2/9; NFC remains visible throughout timed query refinement |
| `search20.py` | OR union, deduplication, required terms, negated alternatives, anchors and bound search pass; pending alternatives keep the spinner active; stale replies cannot affect a newer search |
| `preview20.py` | 84/84 preview snapshots identical, including 14 dynamic window-change snapshots |
| `raw19.py` | 12/12 cases identical |
| `spinner19.py` | All ten spinner frames observed, then cleared after the delayed replies |
| Release unit suite | 117 passed, including Boolean discovery and fallback regressions |

Every hn call used a private frozen binary, explicit `hnf19fixr20` socket, matching mock port,
throwaway HOME, and short private HN_TMPDIR. A guard refused ports outside 19420–19429;
TMUX, TMUX_PANE and HN_SOCKET were removed in both parent and tmux child environments. The
scripts clean up their named servers, exact owned hn processes and descendants, and mocks.
No installed binary, default socket, real daemon, commit, push, merge, or release was used by
this fix task. This is a fix verification report, not a new independent panel score.

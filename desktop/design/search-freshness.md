# Search freshness

Search should show saved results immediately, preserve the query and selection,
and update the data without making typing wait for another machine.

| Place | Refresh behavior |
| --- | --- |
| New Harness (⌘N) → Branch, including shared Store/launch entry points | Read saved Git metadata first. Entering Branch checks remote branch names in the background, at most once per 10 seconds in that picker. Refresh or ⌘/Ctrl+R bypasses that interval. |
| New Harness → Open Folder | Read one directory when entering or revisiting it. Keep saved suggestions visible during refresh. Typing within the same directory only filters those suggestions. |
| New Harness → New Project | Refresh the parent folder on entry/revisit so a project created elsewhere becomes an “Open existing” choice. |
| Remote folder browser | Read the directory on navigation. Refresh or ⌘/Ctrl+R updates the current directory while preserving its rows, selection, and typed path. |
| Recent projects | Combine saved project history with live harness project metadata. This is a list of used projects, not a recursive disk index. Open Folder discovers other folders. |
| Open Harness (⌘O), project/machine groups, and Harnesses | Filter the live harness inventory, including its branch metadata. These surfaces do not query every repository's Git branches. |

## Cost and failure behavior

- Branch discovery asks each configured Git remote for names with `ls-remote
  --heads`. It does not download commits, change refs, check out branches, or
  alter working files. Start fetches the chosen branch when needed.
- Concurrent branch checks share one lookup per repository, including linked
  worktrees. Each remote has an 8-second deadline. Failed remotes retain saved
  choices; successful remotes contribute new names and remove deleted names.
- Remote folder completion has an 80 ms debounce, lists one level, coalesces
  in-flight requests, and retains at most 16 directory listings. Manual refresh
  and revisiting a directory reuse visible rows while requesting fresh data.
- Late replies cannot replace a newer machine/project selection or query.
  Refresh failures offer a retry and retain previously usable results.
- No new background polling or network request per search keystroke.

## Checks

Regression tests cover a branch pushed after a single-branch clone, opening that
branch, offline/partial/timeout replies, deleted branches, concurrent refreshes,
preserving dirty files, hidden branch names, folder revisits, changed project
names, late replies, live ⌘O metadata, and keyboard/layout behavior.

On the development Mac, saved Git refs took a median 20 ms to read. A GitHub
names-only lookup returned 175 branches (13.7 KB) in 1.0 second. In a debug
controller test, filtering 2,000 refs over 100 queries took roughly 3 ms at the
median and 4 ms at the 95th percentile. These are observations, not latency
guarantees; remote folder speed also depends on the connection and directory.

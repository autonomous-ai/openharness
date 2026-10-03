# Mobile changes for user review

Audit window: September 27, 2026, 09:43–21:43 EDT. The installed build at the start of this review was **46**, from [PR #398](https://github.com/autonomous-ai/openharness/pull/398).

This separates changes made during the overnight continuation from older work merged during the same twelve hours. [PR #387](https://github.com/autonomous-ai/openharness/pull/387) merged at 11:10 EDT but contains development from earlier days; its long squash message includes experiments subsequently reverted. Those intermediate experiments are not all present in build 46.

## The four corrections requested after reviewing build 46

| Area | Build 46 | Requested behavior |
|---|---|---|
| New Harness | Branch/worktree, approvals and profile shown directly | Agent and Project first; advanced rows under collapsed `Options [+]`, matching desktop |
| Agent chooser | Claude Code/Codex first; other engines behind `more` | One complete scrollable list, most recently used engine choices first |
| Project chooser | Search shown only for long lists; no automatic focus | Always show search and focus it when opened |
| Find | Search waits for a field tap | Focus search on entry so typing works immediately |

The four requested behaviors are implemented for local iPhone build **47**. Its validation passes 1,621 tests and 25 renders. This audit describes build 46 so the user can review the other decisions separately.

Exposing advanced options came from the review panel. The `more` gate and unfocused Find predate this continuation; they were retained in the shipped build. The earlier explanation implying they were newly introduced here was inaccurate. Panel preferences do not supersede the user's specified interaction design.

## Desktop parity requested after build 47

Local build **48** adds the user's explicit Cmd-N corrections:

- **Branch** opens the branch picker directly. **Worktree** is a separate `[x]` / `[ ]` row; toggling it preserves the chosen branch. Both remain under collapsed Options.
- **Model** offers the agent's subscription, models on the user's machines and shared models. The selected model/grid is sent with creation; a fresh capability/catalog check prevents an older CLI or stopped model from silently starting on the subscription.
- Expanded order is Model, Approvals, Profile (Codex subscription only), Branch, Worktree. Cancelling keeps the draft; changing computers clears its model selection.
- The offline sample supports the same model choice. Three additional screen renders cover expanded Claude/Codex options and the model picker.

## Overnight UI/UX changes now in build 46

The [comparison after PR #387](https://github.com/autonomous-ai/openharness/compare/244cfe71...e0daa25c) contains these changes and the reliability work.

| Area | Change | Basis/status |
|---|---|---|
| New Harness options | Removed the `[+]` fold and exposed branch/worktree, approvals and Codex profile | Panel-driven; user has now requested reversal |
| New Harness copy | Explained “a harness is one session of an agent”; command description became “Choose an agent and a project” | Teaching the retained term; wording introduced during review |
| First-task suggestions | Limited suggested tasks to the first harness, instead of showing them on every New form | Review-driven reduction of repeated content |
| New while typing | Compact summary puts project before engine; previously also included branch/worktree and approvals | Review-driven; advanced details removed from summary in the requested correction |
| Settings | Renamed rows to “Phone name” and “App colors”; moved Usage, Computers and Phone name into account grouping; removed standalone Usage grouping | Review-driven; duplicate color/text-size controls remain pending a user decision |
| Settings avatar | Replaced the conspicuous avatar treatment with a neutral one | Review-driven |
| Terminal scrollback | Removed the numeric scroll-position tag | Explicit user decision |
| Attention above mic | Hide while reading history; fixed left gutter, yellow dot and solid backing | Review-driven; mic placement and full-screen terminal preserved |
| Focus “asking” | Rebuild the existing other-harness asking label when its state changes; retain tap to Find | Bug fix; retaining the label is an explicit user decision |
| Key strip | Open at its own keys so `esc` does not scroll off-screen | Interaction bug fix |
| Chooser sheets | Size to contents, align title with row gutter, use a drag handle and native drag dismissal | Review-driven |
| Form rows and fields | Align labels with the first value line; strengthen placeholder contrast | Review-driven |
| Harness menu | Color “Stop this harness…” red | Review-driven destructive-action styling |
| Sign-in | Disable Sign in for incomplete codes | Review-driven form feedback |
| Computer setup | Consolidated setup/download flows; signed-in setup watches for and pairs a computer | Review-driven flow change |
| Unlock | Allow scanning another computer's Add Phone code; retain password fallback; clarify phone-password copy and the desktop menu path | Review-driven flow/copy change; menu wording checked against desktop |
| Pairing copy | Explain end-to-end encryption on the scan page | Review-driven |
| Sample discoverability | Visible entry on Welcome/setup; sample labels on pickup, Focus, Find and New; shorter input hint | Review-driven |
| Sample behavior | Stop repeating the user's prompt; use realistic permission wording and friendlier computer naming | Review-driven demo changes |
| Accessibility | Terminal output readable by VoiceOver; actions for Find/New; voice-cancel action, question announcement and live attention text | Accessibility fixes |
| Small screens / large text | Fix title, sample end-card, welcome/pairing and New-form overflow; keep Start reachable over the keyboard | Layout fixes |
| Reduced motion | Show the terminal attaching state with Reduce Motion enabled | Accessibility bug fix |
| Branch/PR history | Retain main's current branch display and “Branches and pull requests” page | Integrated from [PR #397](https://github.com/autonomous-ai/openharness/pull/397), not a panel decision |

## Older UI work merged within this window in PR #387

These features were already in the app when the overnight continuation started:

- Full-screen Focus; swipe right to Find and left to New; a title/actions menu instead of a bottom tab bar.
- Terminal-styled typography, rows, menus and key strip; the mic floating over the terminal, voice auto-send and answer buttons beside it.
- New's Agent/Project form, optional first-task field and Start button; project names identify their computer; defaults and drafts are remembered.
- Find searches harnesses and conversation contents, supports desktop-style command/project/computer modes, and resumes external conversations; rows use conversation activity for ordering and stay stable while reading.
- Onboarding, the pickup screen, setup/download choices, QR sign-in/pairing, written help and the “See how it works” video.
- Offline sample with guided steps; notification permission deferred until a harness is on screen.
- Terminal selection/copy, paste, links, interrupt controls, question handling, and recently viewed terminal snapshots.

## Non-UI work

- Fixed 41 documented bugs, including auth refresh/sign-out races, pairing hangs, replay/rekey handling, reconnects, terminal stream state, logging and analytics lifecycle errors, and branch-history request encryption.
- Removed unreachable desktop screens, window/grid controls, local CLI provisioning/supervision/sign-in, plaintext local transport and other dead code. The app remains a viewer onto computers.
- Expanded offline regression coverage to 1,614 passing tests and 88.7% line coverage excluding third-party code; checked 25 renders and a sample simulator tour. Tests use isolated storage and block real HTTP access.

The AI panel's 8+/10 scores describe its assessment of rendered/sample artifacts. They are not user approval of the design choices above.

## Preserved decisions / still pending

Voice auto-send, mic location, full-screen terminal, the word “harness”, removal of the scroll tag and retention of the asking label remain the user's decisions. Push notifications, Dynamic Type, a one-line Focus header, duplicate settings and the other proposals in the [handoff](2026-09-28-phone-overnight.md) remain unapproved and were not implemented.

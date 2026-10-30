# Swarm agent tooltip and details plan

**Goal:** A roster hover states what an agent is doing. A click opens useful agent details and links to its current work and latest group PR.

**Scope:** Desktop roster, a small agent details view, and roster widget tests. Keep the existing Remove from Swarm action. No backend, CLI, dependency, or unrelated navigation changes.

**Base:** The Remove from Swarm change is merged on main. Base this Desktop-only follow-up on that commit and preserve its row action.

## Data and behavior

- Match a Swarm agent to the native observation using machine ID and harness ID. Use the observed model, folder, timestamps, permission mode, and on-screen question when present; fall back to the Swarm configuration for engine/model.
- Find the agent's open assignment in the visible Swarm state. Use its group title for tooltip status and a detail link that selects that group. A pending on-screen question or `needs_human` assignment reads as waiting for a person to answer.
- Resolve the machine name from native state or the Swarm machine list. Resolve who may answer an on-screen question from the assignment execution's machine owner ID or observed machine owner name; omit the line when neither identifies a person.
- Load at most three pages of the assigned group's messages when details open. Reuse the existing PR-link parser; prefer the current assignment result, then the latest link posted by this agent in that group. Do not infer an agent's PR from another group member or an unrelated native checkout.
- Omit unknown data, including unknown status, timestamps, folders, model, PR, or question owner. A stopped/offline session must not read as idle or actively working.

## Implementation and verification

1. Add widget tests for a complete tooltip, an unknown-data tooltip, task and PR links, machine/folder/permission/start time, and question owner. Update the existing row-click test to expect details, then Open terminal.
2. Add a shared agent-information helper and details view. Put one composed Tooltip around each agent row, replace nested row tooltips, and keep the existing context menu and removal dialog.
3. Run roster tests, affected navigation/dialog tests, and changed-file Flutter analysis. Inspect the rendered tooltip and details in dark and light themes. Review the diff for stale state, incorrect owner claims, and layout overflow.
4. Rebase on main, rerun checks affected by that integration, push a branch, open a draft PR, and report exact commands, results, head, and any unverified behavior.

**Acceptance:** Tooltip includes engine/model, machine, task status and relative last activity when known, with unknown fields omitted. Details link to the held group and latest group PR, show machine and folder, permission mode, started time, and the machine owner for an on-screen question. Analyze and tests pass; the PR remains a draft.

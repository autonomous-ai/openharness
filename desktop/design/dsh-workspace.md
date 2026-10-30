# DSH workspace contract

Every domain-specific harness with a dashboard or viewer opens as one workspace:
**viewer on the left at 70%, agent chat on the right at 30%.** This includes
native utility harnesses such as Devices and companions, not just Store web
viewers. The chat is the real agent terminal, with its existing input, approval,
session, and resume behavior. Do not build a second chat implementation.

In a Swarm, **Your devices** is a dashboard-only exception. It fills the center
area of the current tab, keeping the Swarm sidebar and roster visible. It does
not start, resume, attach, or reserve a Devices agent or chat pane. Returning to a
project restores its draft and conversation choice. Saved embedded viewer/chat
layouts normalize to this single dashboard; no new top-level tab is opened.
Standalone Devices outside a Swarm retains the viewer/chat workspace below.

Use the shared `PaneGrid` and `PaneArrangement.viewerBesideTerminal`. Reserve
both slots before asynchronous setup starts. Keep the chat slot visible while
loading, when its package or engine is missing, when launch fails, and while
retrying or reconnecting. A short explanation and recovery action belong in
that slot until the terminal can attach. `HarnessConversationPlaceholder` is the
shared setup surface. Never expand the viewer because chat is not ready.

Preserve the split when attaching or resuming the agent, restoring the tab,
switching tabs, and retrying an uncertain creation. Reuse creation receipts;
retry must not start a second conversation. Explicit user resizing and pane
zoom remain available and must not be overwritten by automatic refreshes.

For Devices, show devices only after their owning computer has answered and
supports device management. Hide devices belonging to unreachable, unlinked,
offline, or unsupported computers. Keep saved identities internally so they
return after reconnection. Do not list fleet connection failures, package IDs,
or transport errors above the dashboard. An empty result gets a calm connection
instruction. A failed edit stays beside the affected device control.

Verify the actual workspace, not a dashboard rendered alone:

- For Your devices inside a Swarm, verify one dashboard fills the center at narrow
  and wide sizes, no conversation is created, and returning to a project preserves
  its draft, selected workgroup, and any existing viewers.
- Measure left/right placement and the 70/30 split before startup, after failure,
  after a successful retry, and after restore for standalone DSH workspaces.
  Check user-resized layouts too.
- Test a missing bundled package and an unavailable engine. A ready-agent-only
  preview misses the failure that previously removed Devices chat.
- Check disconnected hosts disappear without messages, and reconnect with their
  saved names. Unavailable hosts must never accept a setting change.
- Review both light and dark appearance, a narrow window, and enlarged text.
- For bundled harnesses, verify the released CLI actually includes the package
  and required commands. A backend feature flag and a desktop build alone do
  not ship a CLI bundle. Release required runtime support before exposing it.

Packages without a viewer can remain terminal-only; they must not create a
dashboard that takes over the terminal's workspace.

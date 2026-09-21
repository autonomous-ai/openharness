# Current review build: manual checks

These checks cover the welcome guide, first launch and running-harness
picker in PR #165. The resume implementation is excluded from this PR and
is tracked separately in [issue #167](https://github.com/autonomous-ai/openharness/issues/167).

| Check | Steps | Expected result |
| --- | --- | --- |
| Welcome review shortcut | With existing work open, press Cmd-Option-Shift-O. Return to a work tab and press it again. | An empty Welcome tab opens, then is reused. Its dock opens automatically: New Harness with no known sessions, search with one or more. Existing tabs, terminal output and running work remain. |
| Welcome/dock contrast | Open Welcome, then switch its dock with Cmd-T, Cmd-P and Cmd-N. | The welcome guide has a near-black charcoal background (#171717); the command dock stays lighter gray. The complete smaller diagram and all keyboard guides fit above the dock. Input, selected row and New Harness action remain easy to distinguish. |
| Welcome examples | Open Welcome at a normal size, then shorten the window. | “Follow your curiosity. Build across disciplines.” leads the original tab-and-pane drawing, with arrows pointing to each section. The robot-arm example shows sample control code in Claude Code on the left, an illustrative 3D gripper in Blender above right, and an illustrative motor-controller board in KiCad below right. The tagline has extra space below it. The whole guide stays above the dock. |
| Open an existing harness in a tab | Press Cmd-T, search for a known running harness, select it and press Enter. | A new app tab displays that existing runtime. Conversation and terminal output continue; no CLI restart or new conversation. |
| Add an existing harness to a tab | In a normal work tab with room, press Cmd-P and select a running harness that is not already in that tab. | A pane is added to the current app tab, attached to the existing runtime. Selecting one already present should focus it without a duplicate pane. Store/Orchestrator tabs use new-tab placement. |
| Dismiss without opening work | Press Cmd-T or Cmd-P, type a search, move the selection with arrows, then press Escape. | Dock closes, focus returns to the previous work, and no blank tab/pane or new agent was created. |

Physical keyboard input still needs this manual check; automated shortcut and
widget checks do not establish that the real AppKit key path works on the
user's setup.

The existing-runtime checks above are regression checks for behavior the app
already supported, not new features.

For the agent chooser, confirm Amp, Muse, Devin and Command Code no longer
show “not installed”. Selecting a missing engine and launching should use the
daemon's existing automatic installation path, without sending the user to
an installation form. Actual login/install failures should remain visible.

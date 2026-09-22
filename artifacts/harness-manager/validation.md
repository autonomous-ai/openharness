# Harness manager validation

Verified September 22, 2026. [Harnesses](harnesses.png) · [Needs input](needs-input.png) · [Minimize keyframe](minimize.png).

All process tests used newly created Claude and Codex harnesses with temporary
profiles, synthetic conversation history, and private tmux servers. No existing
user harness was paused, stopped, or restarted. Native engines used a local test
provider; the checks did not require paid model requests.

| Check | Result |
| --- | --- |
| Native Mac app and CLI builds | Passed |
| Flutter analysis and CLI type checking | Passed |
| Desktop manager, lifecycle, navigation, shortcuts, and terminal regressions | 131 passed, including the rendered preview |
| Lifecycle suite | 200 passed; 100% statements, branches, functions, and lines in the five covered lifecycle modules |
| Related CLI transport, activity timestamps, process, and terminal regressions | 188 passed |
| Native AppKit titlebar checks | 461 passed |
| Native Claude and Codex lifecycle fixtures | Passed, including three immediate pause/resume cycles per engine |
| Native Mac UI acceptance | Passed, including three manager pause/resume cycles per engine, repeated clicks, background resume, pane reopening, and original history |
| Final visual render | Passed |

The suites overlap; these counts are not a combined total. The optional visual
render is enabled in the reported desktop run. It is skipped in ordinary runs.

Verified safeguards include confirmed process termination before reporting pause,
exact-pane closure that preserves neighboring panes, conversation identity across
registry reloads, duplicate-operation prevention, retained rows after refresh
failure, and actionable native errors. A late hook may rebuild a registry record
without falsely appearing to replace its process; changed process, conversation,
or terminal identities still reject the operation.

Pane minimization uses a bounded GPU snapshot and a curved mesh while retaining
the live terminal subtree at its original size. It does not stop its process.
Keyframes were rendered and the animation was exercised in the native preview.
Keyboard navigation, machine search, activity sorting and compact ages, current and
replaced questions, separate accessible open/control actions, small windows, larger
text, and Reduce Motion are covered. The clock stays on the context line; only a
waiting harness adds a help action beside pause/play. The former bell and its
shortcut now open Needs input in this same manager.

Pause/resume controls currently support saved Claude and Codex conversations.
Other engines remain viewable with a tooltip explaining that exact resume is
unavailable. The built app and CLI were not installed over or used to restart the
user's running app or daemon.

Key repeatable checks are `npm run test:resume` and `npm run test:resume-native`
from `cli`, and `flutter test test/harness_session_manager_test.dart
test/agent_pause_state_test.dart` from `desktop`. The native Mac test is
`desktop/integration_test/native_resume_e2e_test.dart`; its header documents the
private fixture setup.

The native integration test lets macOS own accessibility activation instead of
retaining a test-only semantics handle across window deactivation. This avoids a
Flutter engine bridge reset receiving a partial tree as its first update; ordinary
widget tests still verify VoiceOver actions with semantics enabled. The native
suite completed in 26 seconds after this correction. Fixture cleanup rescans for
shell history files written during shutdown.

# Recover the companion from Memories

When learning is waiting for the companion's model, **Open companion terminal**
now appears beside the explanation and on the Learning page. It uses the existing
DSH conversation path, keeps the selected agent, and focuses its real terminal.
Reading Memories does not invoke this action. Pending opens disable it; a failure
allows another explicit attempt. Paused learning, unavailable ownership and stale
companion/account callbacks cannot activate it.

The workspace fixture checks initial 70/30 placement, a preserved 62/38 resize,
failure/retry, duplicate pending activation, retained tab/pane/conversation IDs,
focus and synthetic keyboard delivery. Recovery sends no chat text and changes
neither Learn nor Recall. Agent setup and provider/model choices stay in the
existing terminal. Opening that terminal does not by itself resolve a provider
refusal or certify successful learning.

The native renderer captured the synthetic
[waiting workspace](2026-10-03-memory-recovery/native-waiting.png),
[failed attempt with retry](2026-10-03-memory-recovery/native-retry.png), and
[resumed terminal](2026-10-03-memory-recovery/native-resumed.png).
The last image precedes the simulated learning-status refresh; the recovery
action disappears after that refresh. The VM renders cover
[dark](2026-10-03-memory-recovery/dark-large-text.png) and
[light](2026-10-03-memory-recovery/light-large-text.png) appearance at 440×1100
and 200% text. These contain only fixture data.

Changed-file analysis and 143 affected VM tests passed. After adding explicit
keyboard assertions, the targeted VM journey passed again. The final native
command **passed both cases**: the native window reported foreground focus,
and the complete recovery journey passed, including synthetic keyboard dispatch.
The native images above come from that final run.

Earlier native commands failed the separate foreground assertion while the
recovery journey passed. Mounting a first frame and allowing three seconds did
not resolve the failure: the window was visible and not minimized, but not
focused. The final run enabled `HARNESS_NATIVE_FOCUS_REVIEW=1`, which permits a
reviewer to activate the exact synthetic window within 60 seconds while keeping
the assertion required. Focus was observed within the first second, without a
manual click or any app-control action. Flutter still printed its launcher
warning, `Failed to foreground app; open returned 1`.

The earlier failures remain failed; the intermittent startup-focus cause is
unestablished. This is not a production focus fix or proof that launcher
activation is reliable. Physical AppKit keyboard/IME and VoiceOver behavior
remain unverified. The [evidence manifest](2026-10-03-memory-recovery/evidence.json)
binds the final images and source, and retains the separate outcomes.

The native fixture uses `FLUTTER_TEST=1`, `HARNESS_TEST=true`, in-memory persistence
and fake memory/agent transports. It does not read real conversations or launch
a real companion. The installed app, daemon, model, account and memory were not
changed. This is a recovery affordance, not completion of the live-learning,
semantic-quality or coding-benefit requirements.

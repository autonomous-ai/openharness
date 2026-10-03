# Devices workspace review

Native macOS captures from `desktop/integration_test/devices_native_test.dart`,
using Flutter 3.47.2 on Apple Silicon with Impeller. The fixture uses sample
hardware and terminal traffic; it does not run an agent or change a USB device.

Devices from unavailable computers are absent, with no fleet error list. The
viewer keeps 70% of the workspace and chat keeps the right 30%, including when
no supported engine is available. Both themes use the actual shared pane grid.

| State | Light | Dark |
| --- | --- | --- |
| Conversation attached | [Screenshot](light-devices-dsh.png) | [Screenshot](dark-devices-dsh.png) |
| Conversation unavailable | [Screenshot](light-devices-chat-unavailable.png) | [Screenshot](dark-devices-chat-unavailable.png) |

Focused tests cover missing-package recovery, retained creation receipts,
restoration, user resizing during startup, hiding unavailable devices and
their details, and restoring saved device names on reconnection. Existing
narrow-window and 200% text checks remain part of the Devices screen suite.

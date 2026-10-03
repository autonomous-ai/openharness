# Devices

Manage physical Harness and Harness Pro devices across computers linked to your
account. The native dashboard opens on the left at 70%, with the ordinary agent
chat on the right at 30%. Chat setup and recovery stay in that right pane.
Each visible USB device is labeled by its reachable host computer.

Devices is bundled with the Harness CLI, unlisted in the Store, and off by
default. With an updated backend, desktop app, and daemons, enable **Settings →
Experimental → Devices**, then click **Devices** beside Harness Store. An
installed, configured Codex, Claude Code, or OpenCode engine is needed for the
conversation. Engine account and usage requirements still apply.

Try asking:

> Show my Harness devices and the computers they are connected to.

The agent reads live inventory and reports the owning computers, available
devices, and unavailable hosts. A requested settings change targets one host
and one device and waits for the device to report the requested values. The
dashboard hides devices from unreachable, unlinked, or unsupported computers,
without listing connection errors. Saved names return when the computer
reconnects. Changes are never queued for later.

The dashboard supports brightness, sound, reverse scrolling, voice language,
and the initial Focus face. Add device guides USB connection, naming, and model
selection; Shop opens the [Harness product page](https://www.autonomous.ai/harness-device).
Names and chosen model labels are saved locally per account. Firmware does not
identify the retail model, and the package adds no wireless pairing or battery
telemetry.

## Development and verification

From the repository root, after building the CLI:

```sh
node cli/dist/cli.js dsh check store/agents/devices
node cli/dist/cli.js hardware list --json
```

The first command validates the package without starting an agent. The second
requires a running, signed-in daemon and reads the actual account inventory.
The agent uses `harness hardware list/set` through the authenticated daemon;
`harness devices` continues to manage account device keys.

Desktop tests and the separate Devices Review app use sample hardware and a
sample conversation. They do not constitute a live engine, USB, or cross-machine
acceptance test. The native viewer lives in `desktop/lib/devices/`; the package's
`devices.json` is for optional notes, not device discovery or live settings.

## Credit and stewardship

Created and maintained by Autonomous as part of OpenHarness. This package is
licensed under the [MIT License](LICENSE). Dashboard product photography comes
from Autonomous; source URLs are recorded in
[the desktop asset notes](../../../desktop/assets/devices/README.md).

---
name: firmware
description: Build PlatformIO firmware and inspect real compilation, memory, artifacts and pin plans without implicitly accessing hardware.
---

# Firmware Studio

`platformio.ini` selects environments, platform, board and framework. Pin platform and library
versions for reproducibility; the starter uses `espressif32@6.10.0` with Arduino. Arduino code is C++:
use `src/main.cpp`. Document a board's exact variant before choosing pins or peripherals.

```sh
sh "$FIRMWARE_SKILLS/firmware/scripts/build-firmware.sh"
sh "$FIRMWARE_SKILLS/firmware/scripts/build-firmware.sh" esp32dev
```

The helper selects the requested environment, first `default_envs` entry, or first `[env:name]`.
It runs `pio run --project-dir ... -e ...` exactly once, not a second compile to read sizes.
`PIO_BIN` can select an explicit binary; otherwise PATH or the package's PlatformIO venv is used.
Node 20+ can come from the machine or Harness's managed runtime.

Outputs: `build-status.html`, `.harness/build.json`, `.harness/build.log` and copied artifacts under
`out/`. Missing memory lines display as unavailable, not fabricated zeroes. RAM is the compiler's
static allocation, not a runtime peak. Flash is the selected build partition budget, not necessarily
the chip's total flash capacity. Advanced inherited INI values remain source text in the dashboard;
the compiler log is authoritative about the resolved target.

`pins.json` contains `{"pins":[{"pin":"GPIO 2","role":"LED","direction":"Output","note":"..."}]}`
and an optional top-level note. It documents intent only. The pictured board is conceptual.
Review the exact board documentation for input-only pins, boot straps, voltage and current limits.

A failed command, missing binary or invalid pin plan clears readiness and publishes a failure page.
Read the actual log and fix the cause, then rebuild. Inspect dashboard tabs, log filtering and
artifact downloads in the shared Web Viewer. `proof.json` includes a default tab-interaction recipe.

## Device boundary

Compile first. `pio run -t upload`, `-t erase`, debugger connections and serial access are separate
real-device steps requiring the user's explicit authorization. A requested build does not authorize
any of them. Do not claim the firmware works on hardware until an actual approved test establishes it.

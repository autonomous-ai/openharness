# Firmware Studio

Read the `firmware` skill. This is a PlatformIO workspace: `platformio.ini` selects the target,
`src/` holds firmware, and the live `build-status.html` pane shows the latest build.

Use the one-stop helper after meaningful changes. It compiles one selected environment once,
captures the compiler output, records reported memory usage, publishes downloadable binaries and
refreshes the dashboard and verdict. Failure produces a fresh failure page; an old successful
page must not remain the current result.

Keep `pins.json` aligned with the source as a project pin plan, not a verified board pinout.
The ESP32 starter uses Arduino C++, so its entry point is `src/main.cpp`, not `main.c`.

Compilation proves neither runtime behavior nor electrical safety. Upload, erase, debugging and
serial/device access require explicit user authorization for that device. The build helper does
none of those operations. Don't add upload targets or device side effects to its compile step.

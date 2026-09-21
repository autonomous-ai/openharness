# Firmware Studio

From source to a firmware binary, with a useful build report beside you. **Signal** shows the real
compiler log, static RAM and flash usage, configuration, a project pin plan and downloadable build
artifacts. Search the log, inspect the target and see failures clearly.

Try: “Build a nonblocking ESP32 status light and show me its memory footprint.”

The Arduino starter is pinned to Espressif's PlatformIO platform 6.10.0. The helper builds one
environment once and never flashes hardware. Upload, erase, debugging and serial access are
separate, explicitly approved steps. “Compiled” does not mean “tested on the device.”

Requires PlatformIO, Node 20+ (or Harness's managed Node) and the shared Web Viewer. `PIO_BIN`
supports custom installs. The first compile downloads the selected platform's SDK and toolchain.

```sh
harness dsh install "$PWD/store/agents/firmware-studio" --link
harness dsh doctor autonomous/firmware-studio
```

Memory figures come from the compiler; the board illustration and pin plan are not live telemetry
or a verified wiring diagram. Upstream: [PlatformIO](https://platformio.org).

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.

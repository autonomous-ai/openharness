# Provenance

The wrapper, Habitat studio, scenario fixtures, SVG mark and delivery tools are original OpenHarness work, MIT licensed. The small ZIP utility is reused from this repository's MIT-licensed Data Studio package. The old subset-model files are retained for reference only; they are not used by active entrypoints or included in portable deliveries.

Separately installed dependencies:

- [Home Assistant Core 2026.9.3](https://github.com/home-assistant/core/tree/2026.9.3), Apache-2.0. No Core source is vendored or patched. Its actual annotated YAML loader, automation schema, triggers, conditions, scripts, services, helpers and trace engine run in a fresh local process. Python 3.14.7 is selected by setup; `template/tools/uv.lock` pins the complete platform-aware dependency set and distribution hashes.
- [time-machine 3.5.0](https://github.com/adamchainz/time-machine), MIT. It controls the scenario wall clock while the wrapper advances native asyncio deadlines chronologically. A separate real-clock regression runs the same held trigger and chained delay without time travel.
- [Playwright Core 1.63.0](https://github.com/microsoft/playwright), Apache-2.0, pinned by `package-lock.json`. Chromium is installed by its browser installer for actual browser interaction tests; it is not vendored in the Store package.
- Python and transitive dependencies retain their own licenses in the installed runtime. The lockfile does not relicense them.

Device I/O for declared lights (brightness/transition), fans (percentage) and switches is an explicit test double attached to native Core entity classes. Helpers and local persistent notifications are native. No network integration, live home configuration, credential or device discovery is loaded.

Trusted dependency bootstrap imports pinned `ifaddr` before installing scenario audit guards: its Linux import resolves the system C library through Python's `ctypes.find_library`, which may invoke `ldconfig` to read loader metadata. It does not call `get_adapters` or discover devices. Core configuration and automation execution remain under the unchanged network/subprocess/write restrictions.

Native registries use Core's official `async_load(..., load_empty=True)` API and read-only backing stores. This deliberately excludes persistence and restart/restore tests. It also avoids retaining pinned orjson storage fragments during CPython teardown; the macOS QA investigation identified a dangling `orjson.Fragment` heap-type reference in persistent registry caches. No dependency override, `os._exit`, crash suppression or acceptance of partial child output is used. See [Core storage](https://github.com/home-assistant/core/blob/2026.9.3/homeassistant/helpers/storage.py) and [the pinned Fragment implementation](https://github.com/ijl/orjson/blob/3.11.9/src/ffi/fragment.rs). This observation is not a claim that all Core installations crash.

Official behavior/integration references: [automation triggers](https://www.home-assistant.io/docs/automation/trigger/), [script conditions](https://www.home-assistant.io/docs/scripts/conditions/), [automation troubleshooting](https://www.home-assistant.io/docs/automation/troubleshooting/), and [installation configuration checks](https://www.home-assistant.io/common-tasks/container/#configuration-check).

This is an independent OpenHarness wrapper, not an official Home Assistant product or a supported production Python/Core installation method. Test evidence applies only to the declared cases in the pinned isolated lab; it does not certify real devices or an existing installation.

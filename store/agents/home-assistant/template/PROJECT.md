# Habitat project

Editable Home Assistant automation source, a scenario test plan, a local studio, and (after a successful build) checked delivery files. No home is connected. Results are evidence for the declared cases, not a guarantee about all behavior or physical hardware.

## Reopen outside OpenHarness

Install Node 22+ and [uv](https://docs.astral.sh/uv/getting-started/installation/), then run from this extracted directory:

```sh
bash tools/setup.sh
node tools/serve.mjs
```

Open the exact `http://127.0.0.1:PORT/` address printed by the server. Setup installs the locked Home Assistant Core **2026.9.3** development/test runtime with Python **3.14.7**; downloads need internet. Tests and the studio work locally after setup. This Python runtime is not a supported production Home Assistant installation method.

To rebuild the files in `output/` without a browser:

```sh
node tools/build.mjs
```

The OpenHarness package's build command also performs a Chromium interaction check. Standalone projects can run `node tools/proof.mjs` with `PLAYWRIGHT_MODULE` set to an installed Playwright module. A CLI-only build does not claim browser readiness.

## Keep your work

- `automations.yaml` is standard, expanded Home Assistant YAML. Every entry has a stable ID and `initial_state: false`; the isolated engine arms its own copy only.
- `project.json` contains the brief, fixture inventory, time zone/location, timelines, and expected results. Changing source or runtime files invalidates prior delivery checks.
- **Download draft** creates a checksummed, editable `project.habitat.json`. Open it as an unsaved draft. **Save to workspace** is explicit and preserves old source in `.harness/history/`; concurrent file edits cause a conflict instead of being overwritten.
- Restore saved JSON into a new or empty directory with `node tools/restore.mjs SAVED.habitat.json NEW_DIRECTORY`.
- **Export tested project** requires every scenario to pass and every automation to complete a service call in at least one case. The ZIP includes only named source/runtime/delivery files, never unrelated workspace files, history or the Python environment.
- Failed builds preserve the previous delivery and clear readiness. Previous evidence is labeled stale after edits. Drafts can be saved without passing assertions.

## What the lab really tests

The official Core engine runs triggers, conditions, Jinja templates, action scripts, concurrency, services, local helpers and native traces. The clock advances native asyncio callbacks chronologically. Explicit light (brightness/transition), fan (percentage), and switch devices are test doubles. State inputs, native `input_boolean`/`input_number`, and local `persistent_notification` are available. Unsupported integrations fail; nothing silently becomes a successful simulation.

Literal entity references must be declared. Dynamic references need scenario coverage: the checker cannot prove every possible template result. The lab permits state, numeric-state, time, time-pattern, template, custom-event and sun triggers; blueprint files must be expanded first. It has no device/area selectors, discovery, secrets/includes, mobile push, device-trigger adapters, climate/cover/lock adapters, or deployment controls.

Each case gets a fresh process and non-persistent native Core registries (`load_empty`). Restart/restore, real sensor timing, hardware transitions, network availability, actual installation configuration and phone delivery are **not tested**. Network, subprocess and writes outside the temporary configuration are denied during engine execution. This is defense in depth around selected official components, not an arbitrary-code sandbox.

Limits: 100 entities, 32 automations, 24 cases, 120 events/case, 48 simulated hours/case, 200 calls/case, 12,000 native timer advances, 30 seconds wall time/case, 180 seconds/suite. YAML is at most 512 KiB; project JSON at most 2 MiB. A bounds failure is a failed test, never partial success.

## Before installing in a real home

Use `output/INTEGRATION.md`: back up the installation, match IDs/units/helpers/capabilities/time zone, merge only reviewed entries, run that installation's configuration check, and test under supervision with native traces. Keep unrelated configuration intact. `initial_state: false` disables an automation at each startup; remove/change it only after deliberate review. Nothing in this studio deploys or enables anything in a home.

Reports include source text, entity states and notes. Review them before sharing. The wrapper is MIT licensed; separately installed Home Assistant Core is Apache-2.0. This is an independent OpenHarness project, not an official Home Assistant product.

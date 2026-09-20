---
name: home-assistant
description: Turn home-automation requirements into editable Home Assistant YAML, tested what-if scenarios, native Core traces and a reviewed installation kit in Habitat. Use for automation authoring and revision, not unrequested device control.
---

# Build an automation people can use

The deliverable is standard `automations.yaml`, a testable brief and fixture inventory in `project.json`, and a portable installation kit—not a diagram or a preview-only dashboard. Habitat's `index.html` is served by `tools/serve.mjs`; opening it as a static file is insufficient.

Start with the desired outcome and constraints. If the user has no devices, use explicitly labeled example entities. If they provide existing YAML, keep a copy and preserve unrelated entries; do not replace their installation configuration. Clarify consequential choices such as manual overrides, thresholds and timeout behavior when needed, but do not require hardware for a device-free project.

Read [references/scenarios.md](references/scenarios.md) when creating or changing the test model. Use actual Core triggers, conditions, templates and actions; do not translate them into a homegrown interpreter. Support a new user request with its own entity inventory and meaningful cases. The hallway starter is an editable starting point, not the definition of this harness.

Design assertions from the brief before adjusting the implementation. Cover normal operation and important non-firing cases where guards matter; include interruption, bounce, missing sensor or manual takeover when relevant. Assert exact call sequence, target, timing and important final states. A complete suite requires each automation to finish with a service call in at least one case; this is minimum coverage, not exhaustive proof.

## Build, inspect and deliver

From the workspace:

```sh
bash "$HA_SKILLS/home-assistant/scripts/build-automations.sh"
```

This runs the actual Core suite, preserves a checked delivery in `output/`, then tests the studio's draft round trip, native trace, ZIP download and desktop/mobile layout in Chromium. It records source/runtime-bound evidence in `.harness/last-run.json` and `.harness/browser-proof.json`. Setup installs pinned Python/Core and browser runtimes; it does not connect to a home. Use `node tools/build.mjs` for a quick CLI-only check while iterating; it intentionally leaves browser readiness false.

Inspect expected versus actual calls and Core traces, and look at the generated desktop/mobile screenshots. Change the automation to satisfy the intended behavior, not the test to excuse a bug. Rebuild after every substantive revision. For a new workflow, also reopen the saved JSON or exported ZIP in a fresh directory and rerun it; the user must be able to continue their work without the original workspace.

Deliver the editable project, `automations.yaml`, readable report, evidence, entity checklist and `INTEGRATION.md`. Explain the behavior, how the user can revise it, the significant scenarios checked, and the remaining limits. Browser edits are unsaved drafts until **Save to workspace**; saves preserve history and reject concurrent source changes. Any source/runtime edit invalidates checked output. Failed checks preserve the last useful delivery and clear readiness. Never write a passing verdict manually.

## Scope and installation boundary

Core **2026.9.3** executes real automation logic, local services/helpers and native traces. Time and light/fan/switch device I/O are test doubles; registries are non-persistent. A green result does not verify physical devices, a real installation, restart/restore, network failures or notifications on a phone. Do not claim an unsupported adapter was tested or silently omit it. See `PROJECT.md` for the supported fixture/trigger types and limits.

Keep each rule's stable ID and `initial_state: false`; only the isolated runner enables its own copy. That line also disables the imported automation at each real startup until deliberately removed/changed after review. Real installation requires a backup, matching IDs/units/capabilities/helpers/time zone, merging only reviewed entries, that installation's own configuration check, and supervised tests including important non-firing behavior. `Run actions` alone does not test triggers or conditions.

No URL/token entry, discovery, real service call or deployment is part of this workflow. Such actions require separate user authorization. Reports include source text, states and notes; remind the user to review them before sharing. If a native test, adapter or runtime is unavailable, report the precise limit, keep the draft, and do not relabel it as verified.

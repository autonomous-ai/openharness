# Home Assistant · Habitat

Turn “make my home do this” into an automation you can edit, test and take into Home Assistant. Habitat runs the **official Home Assistant Core engine**, not an approximation of its rules. No devices or account are required to start.

Ask for a behavior, explore what-if conditions, follow the actual trigger/condition/action traces, revise the YAML, and export a portable project with a reviewed installation guide. Your brief, entity inventory, timelines and assertions stay editable. Save drafts, reopen them later, and keep prior source and deliveries when a revision fails.

## Start

Install `autonomous/home-assistant` from the Harness Store. Setup uses managed Node 22+, Python 3.14.7, the locked Home Assistant Core 2026.9.3 dependency set and Chromium for browser verification. The initial downloads need internet; the studio and tests run locally afterward. Python/Core lives outside the copyable workspace template.

Try: “Make hallway lighting adapt to quiet hours, ignore brief motion glitches, stay on when someone returns, and respect a manual override. Test the important cases.” The labeled starter contains eight such cases. A distinct laundry example uses sustained power readings and a native helper to send a local completion notification without controlling the appliance.

```sh
bash "$HA_SKILLS/home-assistant/scripts/build-automations.sh"
```

The native studio appears in the viewer. Browser changes are drafts until **Save to workspace**; saves retain old source and reject conflicting file edits. **Download draft** needs no passing test. Checked YAML, report, evidence and project ZIP unlock only after the complete suite passes. Each automation must complete a service call in at least one case, so an entirely untested rule cannot earn a green suite.

## What is verified

Core validates and executes the expanded automation YAML in a fresh process per case. It records exact service calls, timing, final states, device-double effects and native execution traces. Controlled wall/event-loop clocks advance native timers in order, including held triggers, waits, delays and restart behavior. The build-and-browser command also checks draft round trips, trace and ZIP downloads, and desktop/mobile layout. Any source/runtime revision invalidates that evidence. Abnormal child exits, unsupported adapters, failed assertions or exceeded limits fail closed and preserve the last useful delivery.

Light/fan/switch devices are explicitly declared test doubles; `input_boolean`, `input_number` and local notifications use native Core components. Registry storage is intentionally non-persistent. Tests do **not** verify physical hardware, real sensor timing, a real installation, restarts/restoration, network failures or phone notification delivery. The Python runtime is a development/test engine, not a supported production Home Assistant installation method.

There are no connection, token, discovery or deployment controls. Every delivered rule keeps `initial_state: false`, which disables it again at each startup until deliberately changed after review. Use the generated `INTEGRATION.md` to back up the actual installation, match entities/helpers/units/capabilities/time zone, merge reviewed entries without replacing unrelated configuration, run that installation's configuration check, and perform supervised real tests. Reports contain entity states and notes; review exports before sharing.

See [the portable-project guide](template/PROJECT.md) for supported fixture/trigger types, bounds and standalone reopen commands. See [acceptance evidence](test/ACCEPTANCE.md) for the tested workflows and remaining limits. The retired subset model remains in the repository for reference but is not used by any build or viewer entrypoint.

## Credit and stewardship

Home Assistant is the Open Home Foundation community's Apache-2.0 project. This original MIT wrapper, studio and example YAML are maintained by OpenHarness contributors; they are not an official Home Assistant product. Core, time-machine and Playwright are separately installed pinned dependencies. See [PROVENANCE.md](PROVENANCE.md). Home Assistant bugs belong upstream; wrapper issues belong in this repository.

# Habitat — real Home Assistant workflow acceptance

2026-09-20. The user approved example devices, not access to a home. This rebuild replaces the preview-only subset interpreter with the official Core automation engine and a complete author → test → revise → export → reopen workflow.

## Actual environment

- macOS x86-64; Node **22.23.2**.
- Managed CPython **3.14.7**, Home Assistant Core **2026.9.3**, time-machine **3.5.0**. `tools/uv.lock` pins the complete dependency set and hashes. No dependency override or Core patch.
- A clean package install created a new environment outside the template: **105 installed distributions** on this platform, including Core and time-machine. Setup and the read-only doctor passed.
- Playwright Core **1.63.0**, Chromium **153.0.8010.12**, build **1243**, installed by that clean setup.
- The dedicated `home-assistant-native` CI job repeats installation, native/contract tests, browser workflows and independent delivery checks on Linux before merge. Local results below do not stand in for that CI gate.

## Two different, usable projects

| Workflow | Behavior actually checked | Substantive revision |
| --- | --- | --- |
| Hallway lighting — 8 cases | Two-second motion hold; darkness/template guard; 12% quiet-hours / 45% ordinary light; restartable vacancy wait; manual hold before on and before off; re-entry; sensor bounce; missing light reading | Increase vacancy from 120 to 180 seconds. Old assertions fail. Revised ordinary turn-off occurs at +190 s; re-entry turn-off at +280 s; manual takeover still leaves the light on. |
| Laundry completion — 4 cases, 2 rules | Above 12 W for 120 s recognizes an active wash; below 3 W for 300 s after an active wash produces an actual local persistent notification and resets the native helper; idle standby, short pauses and spikes do not produce false completion | Require 180 low-power seconds and revise the brief/message/assertions. Completion notification occurs at +780 s; interrupted-pause case at +1380 s. No appliance is switched and no phone is contacted. |

Both original and revised suites passed actual Core execution. Every declared automation has a positive completed execution with a captured service call; no zero-coverage rule can earn a complete passing suite. Calls, target IDs, data, timing windows, final states and pending runs are checked—not merely YAML syntax or screenshots.

## Native and contract regression checks

`node --test test/*.test.mjs` passed **26 tests**, with no skips, using the real Python runtime after the final fan state-injection correction. Twenty-one cover the new implementation; five retained tests cover the retired subset model as reference only, not release evidence.

Coverage includes:

- Every hallway/laundry case exits cleanly, including the formerly crashing manual-hold case.
- A one-second held trigger and chained one-second delay agree with a separate run using ordinary wall time and normal asyncio, without time travel.
- A local-time trigger across the Europe/London spring DST jump, repeating time-pattern triggers, a held template trigger, rendered action data and a wait-template.
- Native local boolean/numeric helpers, persistent notifications, explicit light/fan/switch doubles, custom events and consistent fan off-state injection.
- Core schema rejection, duplicate YAML keys, includes/tags, undeclared literal references, unsupported trigger/service adapters and spoofed fixture capabilities.
- Unknown services and missing positive rule coverage fail even when other assertions pass. A crashed child cannot be accepted after printing partial JSON.
- Network lookup/connect/bind, subprocess execution and writes outside the temporary config are denied before effects. Writes inside the config remain possible.
- Cancellation and wall-time limits clean up child job directories. Failed revisions preserve the last useful delivery and clear readiness.
- Checksummed draft round trips, source history, concurrent-save conflicts, non-overwriting restoration, symlink boundaries, workspace locks, explicit ZIP file allowlists, report escaping and manifest hashes.
- Same-origin/token/Host protections, private-file non-serving, request-size limits, malformed-header recovery and blocked unchecked exports.

Core itself deliberately assigns clock-time trackers a 50–500 ms phase offset. Tests preserve and assert this behavior; the runner does not replace native scheduling with exact-second fabricated events.

## Actual browser and portable-delivery acceptance

`test/browser.mjs` used real Chromium against the loopback studio. For each workflow it:

1. Built and ran the original complete suite, then inspected an important branch in the browser.
2. Exercised keyboard scenario navigation, rejected a malformed JSON model before replacing the draft, and rendered hostile markup as text. Unapplied JSON disables conflicting edits.
3. Changed the actual YAML behavior; confirmed the old expectations fail; applied the independently specified revised brief and test plan; reran every case successfully.
4. Saved source explicitly, downloaded editable JSON, the tested ZIP, readable report, evidence and an unmodified native trace. Actual on-disk saved source matched the revised draft.
5. Verified every ZIP manifest member and hash. A deliberately unrelated `secrets.yaml` marker, history, dependencies and runtime environments were absent from exports.
6. Restored the **actual browser-downloaded JSON and ZIP** into separate new directories, rebuilt both with Core, and reopened the ZIP-restored studio in a fresh browser page. Reopened historical results did not silently unlock a fresh export authorization.
7. Checked 1600-pixel desktop and 390-pixel mobile layouts without horizontal page overflow; recorded and visually inspected screenshots. Checked that a later edit invalidates export readiness.

The user-facing `tools/proof.mjs` readiness path also passed: draft edit/download/reopen, complete native suite, native trace download, verified ZIP download, desktop/mobile screenshots and source/runtime unchanged checks. It writes a source/runtime-bound proof; no verdict was manually set to ready.

Final local evidence:
`/private/tmp/harness-home-assistant-workflows.KuSIDy/habitat-acceptance-2cYggQ/acceptance.json`.
Both exported workflows and browser proof match the checked-in portable runtime hash:
`553a4669a45438a20b64c17e4f54a47d283dd49bb8b2635bed6ae6b38f9f4adc`.
The Store screenshot is an actual uncropped browser capture of the passing starter, not a mockup.

## Independent verification

`test/verify-delivery.py` does **not** import the wrapper's engine, calculator, archive or delivery code. With standard-library ZIP/hash/JSON readers and upstream Core's YAML loader and automation validator, it passed for both final deliveries:

- ZIP CRCs, member paths, byte counts and SHA-256 manifests;
- editable source equality, saved-project/source checksums and disabled-on-import rules;
- an independent comparison of exact service sequence/targets/data/windows, final states, pending runs and positive coverage;
- concrete revised behavior (+190/+280 s lighting; +780/+1380 s laundry);
- fresh upstream Core schema validation of the exported YAML;
- both saved-JSON and ZIP-restored native builds.

Package conformance, skill validation, canonical runtime synchronization, packaged-branding checks and **453 registry/catalog tests** also passed locally.

The clean installed package's actual init/viewer entrypoints passed the desktop environment contract: initialization preserved existing source and verdict byte-for-byte; the viewer served the daemon-selected loopback port and workspace, located its installed Core without an explicit `HA_PYTHON`, and exited cleanly on shutdown.

## Reproduce

From the repository with Node 22+ available:

```sh
bash store/agents/home-assistant/toolchain/setup.sh
export HA_DSH_DIR="$PWD/store/agents/home-assistant"
export HA_PYTHON="$HA_DSH_DIR/.runtime/core/bin/python"
export PLAYWRIGHT_MODULE="$HA_DSH_DIR/node_modules/playwright-core/index.mjs"
node --test store/agents/home-assistant/test/*.test.mjs
HA_EVIDENCE_DIR=work/home-assistant-evidence node store/agents/home-assistant/test/browser.mjs
"$HA_PYTHON" -I store/agents/home-assistant/test/verify-delivery.py work/home-assistant-evidence
```

For an ordinary workspace, the skill's `build-automations.sh` command performs the native build and browser readiness check. Standalone ZIP/JSON reopen instructions travel in `PROJECT.md`.

## Explicit limits and lifecycle decision

Only declared test devices and selected local components are loaded. No real installation, credential, discovery, network device, phone, physical transition, sensor reliability, restart/restore or deployment was tested. Python/Core here is a development/test runtime, not a supported production installation method. Native services act on doubles/helpers, never on a home.

Registries use the official native `load_empty=True` / read-only storage mode. The macOS investigation identified dangling pinned `orjson.Fragment` heap-type references retained by persistent registry caches during interpreter teardown. Ephemeral registries fit this fresh-case lab and avoid that cache path. Full Core/asyncio shutdown still runs. There is no `os._exit`, patched serializer, skipped teardown or acceptance of a failed process's partial output. Persistence and restart behavior remain explicitly outside scope.

The first clean Linux CI run exposed `ifaddr`'s import-time C-library lookup under the subprocess guard. Bootstrap now imports this pinned dependency before installing scenario restrictions; on Linux, Python may use `ldconfig` to read loader metadata. No adapter enumeration or discovery is called, and no subprocess exception was added to the guard. All 26 local tests, both complete browser workflows, export/reopen checks and source/runtime-bound evidence above were regenerated after this correction. The clean Linux rerun remains a required pre-merge gate.

Results cover the declared cases, not every possible template or device behavior. Dynamic entity references require meaningful scenario coverage. Fixture capabilities, supported adapters and resource limits are documented in `PROJECT.md`. Imports retain `initial_state: false` and need actual-installation backups, entity/helper/capability review, configuration checks and supervised real tests before deliberate enablement. Nothing in this harness performs deployment.

# Scenario authoring contract

Read the current workspace's `project.json` and `automations.yaml` before changing either. The shipped hallway example covers darkness, quiet hours, sensor bounce, re-entry, a missing light reading and manual takeover. A second, structurally different laundry workflow is in the package's `test/fixtures/laundry/`; it uses power threshold durations, a native helper and local notifications, not appliance control.

## Project and fixtures

`project.json` has `spec: 1`, title, brief, boolean `example`, IANA `timezone`, latitude/longitude, entities, scenarios and optional notes. Use a truthful example flag; declaring real-looking IDs does not connect them to anything.

Every entity needs unique `id`, human-readable `name`, `kind`, string `state` and optional attributes. Kinds:

| Kind | Meaning | State / attributes |
| --- | --- | --- |
| `state` | Injected sensor/binary-sensor/person-style state | String state; JSON attributes such as unit or device class |
| `light` | Native light entity with test-double device I/O | on/off/unavailable; brightness integer 0–255; brightness and transition actions |
| `fan` | Native fan entity with test-double device I/O | on/off/unavailable; percentage 0–100; on/off/percentage actions |
| `switch` | Native switch entity with test-double device I/O | on/off/unavailable; no extra attributes |
| `input_boolean` | Real local Core helper | on/off; no extra attributes |
| `input_number` | Real local Core helper | Numeric string from −1,000,000 to 1,000,000; no extra attributes |

Non-state kinds must match the entity ID's domain. Fixtures cannot claim unsupported capabilities through attributes. Local `persistent_notification.create` is an actual Core service, not a delivered phone notification. There are no climate, lock, cover, device-trigger or external-integration adapters.

## A case

Each scenario needs unique lowercase `id`, `name`, `why`, offset-aware ISO `start`, optional `initial` overrides, ordered `steps`, `until` seconds, and `expect`. Initial overrides map declared entity IDs to `{ "state": "off", "attributes": {} }`. Every case starts with a fresh Core process and empty native registries; cases cannot inherit state from one another.

Timeline steps inject a state or a custom event at an elapsed time:

```json
{ "at": 0, "entity": "binary_sensor.example_motion", "state": "on" }
```

```json
{ "at": 30, "event": "example_button_pressed", "data": { "button": "scene" } }
```

Core lifecycle/internal events are not permitted. Equal-time steps run in array order and settle individually. State-step attributes merge into the fixture's declared attributes. Native timers at a deadline run before a state injection at that same deadline; use a small offset when testing the opposite ordering. A numeric threshold test must cross the threshold, not merely start above it. Include enough observation time for delayed actions to finish.

Expected behavior is an exact service-call sequence plus selected state assertions:

```json
{
  "calls": [{ "service": "light.turn_on", "entities": ["light.example_hall"],
    "data": { "brightness_pct": 45 }, "between": [2, 2.1] }],
  "states": { "light.example_hall": { "state": "on" } },
  "pending": 0
}
```

Use `calls: []` for a non-firing case. Targets are exact; data and state attributes are subset matches. Every expected call needs a [first,last] time window. `pending` defaults to zero: deliberately unfinished waits must be explicit. Engine errors, unknown services, unknown literal entity references, isolation violations and abnormal exits fail even if the requested calls appeared earlier. Complete suites also require positive native execution coverage for every rule.

Do not widen time windows or remove final-state checks to hide behavior that contradicts the brief. Use native trace paths/results to locate the failing guard, branch, wait or action. Some false triggers create no retained trace; the absence of a service call and expected final states remain observable assertions, not a fabricated trace.

Core deliberately gives clock-time trackers (including fixed `time` and `time_pattern` triggers) a 50–500 ms phase offset to avoid synchronized callbacks. A pattern can fire during the starting second if that second matches. Keep this real behavior in the expected windows; the lab does not remove the phase or invent exact whole-second calls.

## Boundaries that matter

Expanded YAML only: no includes, secrets, custom tags, merge keys, recursive aliases or unexpanded blueprints. Native schema validation is authoritative. Supported trigger adapters: state, numeric_state, time, time_pattern, template, custom event and sun. Explicit entity targets only; literal template entity references must also be declared. Dynamic template references are not exhaustively provable—test the meaningful branches and inspect resolved service targets.

The timer runner advances native callbacks in order; it does not sleep for simulated minutes. Registry persistence, restarts/restoration and physical device response are outside scope. The original YAML remains disabled for handoff (`initial_state: false`). Keep this boundary visible in the brief, notes and installation advice.

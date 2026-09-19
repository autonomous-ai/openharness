---
name: home-assistant
description: Author Home Assistant automation YAML and inspect local scenario traces in Habitat. Use for automation design and configuration work, not unrequested device control.
---

# Automation authoring

Source: `automations.yaml`. Viewer: `dashboard.html`. Read user entity IDs and requirements before replacing the clearly labeled demo entities.

```sh
sh "$HA_SKILLS/home-assistant/scripts/build-automations.sh"
```

The builder parses YAML 1.2, rejects duplicate keys/unresolved tags, and checks IDs, aliases and basic trigger/condition/action shape. Both singular legacy keys and plural keys are accepted, but not both in one automation. Home Assistant supports more configurations than this local checker (including blueprints); report that limit, do not silently rewrite unsupported source.

Habitat models a strict subset: simple state changes, numeric threshold entry, fixed times, state/numeric conditions, and service-call intents. Numeric triggers fire on crossing, not merely on an already-high value. Templates, durations, attribute/entity-list triggers, complex actions and other unsupported semantics return “not modeled.” Never present the preview as Home Assistant execution.

For a change, inspect a passing scenario and a near miss (daylight, already-high sensor, person away). Use the real installation's configuration checks and automation traces when deployment is requested. This helper never contacts Home Assistant or invokes services automatically. The local `configuration.yaml` includes the automation file; it is not a replacement for a user's live configuration.

The verdict distinguishes local checks from runtime validation and clears ready on failure. Preserve prior outputs, report errors, and rebuild after source changes. Scenario edits in the browser are temporary; only source YAML persists.

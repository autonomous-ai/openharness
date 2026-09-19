# Home Assistant · Habitat

Turn an automation idea into readable YAML, a visual trigger → condition → action flow, and a local scenario you can try before connecting devices.

Habitat ships three clearly labeled demo automations. Select a rule, change the event and entity states, and trace why it would request actions—or why it would not. Night/day presets, source inspection and YAML download are included. Browser scenarios are temporary explorations; edit `automations.yaml` and rebuild to persist changes.

## Start

Install `autonomous/home-assistant` from the Harness Store. Setup installs the pinned `yaml@2.8.1` parser locally; Node 20+ is bootstrapped when needed. No Home Assistant installation, login or device access is required.

```sh
sh "$HA_SKILLS/home-assistant/scripts/build-automations.sh"
```

Try: “Make the welcome lights stay off when a guest is sleeping. Show both scenarios.”

## What is verified

The build parses YAML, rejects duplicate keys/unresolved tags, limits aliases and input size, checks basic automation structure, and safely embeds the result. Failed checks clear the ready verdict and preserve the previous dashboard. These are local checks, **not Home Assistant's complete schema or runtime validation**.

The scenario model supports simple state, numeric-state threshold crossing, and fixed-time triggers; simple state and numeric-state conditions; and plain service-call intents. Durations, templates, attribute triggers, entity lists, complex conditions/actions, scheduling and concurrency are not modeled. Unknown semantics never produce a “would run” result. No actions execute.

Use the real installation's configuration check and automation traces before deployment. This package does not connect to or modify an installation. The included `configuration.yaml` is only a local check entrypoint; never overwrite an existing home's configuration with it.

## Credit and stewardship

Home Assistant is the Open Home Foundation community's Apache-2.0 project. This original MIT wrapper, dashboard and example YAML are maintained by OpenHarness contributors; they are not an official Home Assistant product. The separately installed YAML parser is ISC licensed. Home Assistant bugs belong upstream; wrapper issues belong in this repository.

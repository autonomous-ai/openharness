# Provenance

The wrapper, Habitat dashboard, local scenario model and demo automations are original OpenHarness work, MIT licensed.

Home Assistant: https://github.com/home-assistant/core — Apache-2.0. No Home Assistant source is vendored and no running instance is required.

YAML parser: https://github.com/eemeli/yaml — yaml 2.8.1, ISC license, installed from the pinned package-lock.json by setup. Its license travels with the installed dependency.

Automation behavior references: https://www.home-assistant.io/docs/automation/trigger/ and https://www.home-assistant.io/docs/scripts/conditions/ . The local model deliberately implements only the documented subset named in README.md; it is not a Home Assistant emulator.

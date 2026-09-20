# Home Assistant workspace

Read `skills/home-assistant/SKILL.md`. Build a useful automation from the user's intent, with editable `automations.yaml`, declared test devices and scenarios in `project.json`, native Core evidence, and a reviewed handoff.

- Work on the user's requested behavior, not just the starter. Use labeled example devices when no installation exists; do not block on hardware the user does not have.
- Test meaningful positive behavior and relevant non-firing/failure cases. Keep expected results grounded in the brief; do not weaken assertions merely to get a green result.
- This harness runs actual Home Assistant Core 2026.9.3 with controlled time, device doubles and non-persistent registries. It does not test physical hardware, a real installation, restart/restore or phone delivery. Unsupported adapters and crashed processes fail, never become partial success.
- Keep `initial_state: false` in delivered entries. Only the isolated runner arms them. The setting disables them again at startup until deliberately changed after review.
- Preserve existing configuration, source and last useful outputs. Browser edits are drafts until explicitly saved; saved source has history and conflict protection.
- Run the build-and-browser command after changes. Only its current, source/runtime-bound checks may produce readiness. Never set `ready: true` by hand or use the retired subset dashboard as evidence.
- Do not connect to a home, discover devices, request secrets, call real services, or deploy without separate user authorization. No studio control performs those actions.

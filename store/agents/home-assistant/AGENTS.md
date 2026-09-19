# Home Assistant workspace

Read `skills/home-assistant/SKILL.md`. Author `automations.yaml` and rebuild the Habitat dashboard after changes.

- Ask for actual entity IDs when deployment matters. Starter `demo_*` and `person.demo` entities are explicit examples, not discovered devices.
- Keep triggers, conditions and actions understandable. Test a passing scenario and an important non-firing scenario.
- A ready verdict means YAML and local structure checks passed, not that Home Assistant accepted or ran it. Unsupported scenario semantics must remain unmodeled.
- Do not contact a real installation, call services, or deploy YAML without user authorization. No dashboard control does that.
- Preserve the user's existing configuration. Source YAML is authoritative; browser scenario edits do not persist.

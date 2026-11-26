---
name: config-files
description: "Use when adding settings an application reads at start: one typed config module, defaults in code, values from the environment or a file, validation at startup with an error that names the bad key, and no config read scattered through the code."
---

Parse and validate all configuration once at startup and pass the typed result down. Fail fast with the key name and the expected form. Keep defaults safe for development. Document each key beside its definition, and remove keys the code no longer reads.

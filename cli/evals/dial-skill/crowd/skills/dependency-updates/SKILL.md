---
name: dependency-updates
description: "Use when updating third-party packages, including security advisories and major version bumps: reads the changelog and the migration guide between the current and the target version, updates one package or one group at a time, runs the tests after each, and records breaking changes and the code they required in the commit message."
---

Check what depends on the package and what changed between versions before touching the lockfile. Update in small steps so a failure points at one package. Run the full build and tests after each step, and pin exact versions where the project does. Remove packages nothing imports any more.

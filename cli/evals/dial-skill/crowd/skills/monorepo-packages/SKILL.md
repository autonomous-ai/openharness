---
name: monorepo-packages
description: "Use when adding or changing a package in a monorepo: places it in the workspace, declares its dependencies explicitly, builds and tests only what the change affects, and keeps internal packages from importing each other's private files."
---

Add the package to the workspace config and give it its own build and test scripts. Depend on internal packages through their public entry points. Use the workspace tool's affected-only commands in CI. Keep versions of shared dependencies aligned across packages.

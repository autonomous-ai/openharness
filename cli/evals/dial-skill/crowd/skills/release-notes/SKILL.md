---
name: release-notes
description: "Use when writing release notes or a CHANGELOG.md entry for a version: gathers the merged pull requests since the last tag, groups them into features, fixes and breaking changes, and writes short entries in the past tense for the people who use the product, not for the people who built it."
---

Run git log from the previous tag to the release commit and read each merged pull request title. Drop internal refactors and test-only changes. Group the rest, lead with breaking changes and their migration steps, and keep each entry to one sentence a user understands without the code.

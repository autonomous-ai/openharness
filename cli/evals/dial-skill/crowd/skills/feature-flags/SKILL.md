---
name: feature-flags
description: "Use when shipping a change behind a feature flag: adds the flag with a safe default, keeps both code paths tested while it exists, rolls it out by percentage, and removes the flag and the dead path once the rollout is complete."
---

Name flags by feature, default them off, and read them in one place rather than throughout the code. Test both paths. Give every flag a removal date in the code beside it. When the rollout reaches everyone, delete the flag, the old path and its tests in one change.

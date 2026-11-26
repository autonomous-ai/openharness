---
name: react-components
description: "Use when writing React components: small components with typed props, state kept as low as it can live, effects only for synchronizing with things outside React, stable keys in lists, and tests that render the component and use it as a person would."
---

Derive values during render instead of storing them in state. Keep effects for subscriptions and external systems, each with its cleanup. Memoize only where a profile shows the need. Test through the rendered output and user events rather than component internals.

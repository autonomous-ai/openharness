# Models in View

`models-panel.png` shows the shared Models panel opened through **View → Models**
in the isolated `desktop/tool/models_review.dart` app. All accounts, models,
usage values, and workspace content are synthetic fixtures.

The native accessibility tree confirmed this menu structure:

```text
Harness  File  Edit  View  History  Window  Help
                    └ Models  ⌘I
```

The brain toolbar icon opens the same panel. The menu popover itself was not
available to the screenshot tool; its placement, action, shortcut, remapping,
and disabled state are also checked by `tool/swarm_titlebar_checks.swift`.

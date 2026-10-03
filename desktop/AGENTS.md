# Desktop development

Use [CLAUDE.md](CLAUDE.md) for architecture, build commands, and testing.

For every DSH dashboard, follow the [DSH workspace contract](design/dsh-workspace.md):
70% viewer on the left, 30% real agent chat on the right, including loading,
missing dependencies, failures, retries, and restoration. Reserve the chat slot
before startup; never let an unavailable conversation become a full-width viewer.

For all UI outside terminal panes, follow the
[desktop design system](design/desktop-design-system.md). The user's current
Mac-friendly direction supersedes earlier BIOS, fixed-cell, bracket-button,
and all-monospace presentation rules.

Every app icon follows the [icon system](design/icon-design-system.md).
Use the shared catalogue and pane variants; run `python3 scripts/audit-icons.py`
from `desktop/` after changing icons. Review the full rendered catalogue when
changing shared icon geometry, weight or size.

Keep terminal content and terminal interaction intact. Pane boundaries are
covered by [terminal-workspace.md](design/terminal-workspace.md); shared dialog
behavior and data ownership by [terminal-dialogs.md](design/terminal-dialogs.md)
and [new-harness-entry-rules.md](design/new-harness-entry-rules.md).

The full visual migration is tracked in
[desktop-ui-migration.md](design/desktop-ui-migration.md). Preserve core UX,
controller reuse, keyboard/IME behavior, pending receipts, and scope. Ordinary
Cmd-N forms start fresh after dismissal; see the entry rules above.

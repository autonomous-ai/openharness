# Product terminology

Use these names consistently in desktop, web, phone, menus, shortcuts, accessibility
labels, notifications, errors, onboarding, and user documentation.

| Term | Meaning | Example |
| --- | --- | --- |
| Agent | The coding agent you choose, or the AI doing the work | Codex, Claude Code, Grok |
| Harness | A reusable agent setup in the Store, or a running agent session in the workspace with its own conversation and working context | Install the Blender harness; start three Codex harnesses |
| Tab | A workspace tab that groups harnesses | Frontend, Backend |
| Pane | A view of a harness or its viewer | Split right; close pane |

Use *harness* in both contexts. The screen and action make the meaning clear:
install or update a harness in the Store; start, pause, or stop a harness in the
workspace.

**New Harness** starts a harness. **New Tab** opens a tab. Add harnesses to a
tab to include them; no separate team setup is needed. With **Settings →
Experimental → Tab collaboration** enabled, agents can consult peers in the
same tab. Collaboration is off by default. Closing a pane or tab closes its
views; **Stop Harness** ends the running harness.

Use **Rename Tab**, **Close Tab**, **Next Tab**, and **Previous Tab** for
group actions, and **Rename Harness**, **Pause Harness**, **Resume Harness**, and
**Restart Harness** for a running session. Use **Create Harness** for authoring
a reusable package in the Store. Body copy uses lowercase *harness* and *tab*;
**Harness** remains the product name.

Use *agent* when choosing Codex or Claude or describing the AI's actions. Use
*harness* for Store packages and for running work. Provider usage reports count
native **conversations**, which can also be started outside
Harness. A recorded Store demonstration is a **recorded run**.

Use **Tab** for the workspace group in all visible copy for now. The word also
names the keyboard key, browser tabs, and section tabs. Authentication,
encryption, tmux, and native engine sessions retain their technical meanings.

These are product names, not a protocol migration. Existing command IDs, API
fields, CLI flags, manifests, and stored keys (including `Swarm`, `swarm.new`,
`swarms`, `Agent`, `sessionId`, `tabId`, `DeskTab`, `channel`, and `--tab`) remain
compatible. Search may accept
older wording as an alias. Saved automatic names such as `New Swarm` and
`Untitled Tab` display as **New Tab**; explicit custom names stay unchanged.

# Share button and Cmd-N form

Branch: `harness-share-toolbar`. Implementation and local review builds are
complete. This receipt records validation before merge; deployment is separate.

Sharing was hidden behind menus, and its dialog presented access modes,
invitations, expiry, comments, and link controls at once. Desktop and web now
have a persistent Share action at the top-right and a compact form based on
Cmd-N.

## Interaction

- Share opens for the focused agent. A dependent viewer uses its owning agent.
  Empty tabs and agents shared with the user keep the button disabled.
- Cmd-Shift-S on desktop and Alt-Shift-S on web open the same form. Menu entries,
  help, tooltips, and custom keymaps use the existing `agent.share` command.
- Access and People are aligned fields. Private/Public and email management
  open beside the form. Options reveals invitation expiry, Comments, and Stop
  sharing. Copy link is the selected primary row.
- Up/Down navigate, Tab switches panes, Enter accepts, and Escape goes back.
  Browsing access choices does not change permissions. Narrow windows replace
  the form with the selected pane and provide a Back action.
- Email drafts survive navigation, font changes, and theme changes. Comment
  drafts survive responsive pane changes. Recipient refreshes preserve the
  selected person's identity; stale native button clicks cannot target a new
  focused agent.

The shared Flutter form reuses the existing share and comment operations.
The macOS title bar receives the same button labels, colors, target identity,
and availability as the Flutter toolbar. Backend access enforcement and URL
formats are unchanged.

## Verification

- Focused native widget/shortcut/workspace regression suite: 77 tests passed
  after rebasing on current main. Final form suite: 13 tests, including SF Mono
  captures and enlarged text in Tango.
- Chrome: 19 form and toolbar tests passed with `HARNESS_TEST=true`; the final
  responsive comment-draft check also passed in the 13-test browser form suite.
- AppKit title-bar checks: 271 passed, without opening a window.
- Flutter analysis: no errors, warnings, or new diagnostics; 12 existing info
  diagnostics in vendored xterm remain.
- Production web build and macOS debug app build succeeded.
- No live accounts, agents, invitations, or comments were changed by the tests.

Review images are generated from production widgets with fixture data:
[compact form](../../desktop/design/images/share-form-compact.png),
[access choices](../../desktop/design/images/share-form-access.png),
[narrow form](../../desktop/design/images/share-form-narrow.png), and
[toolbar](../../desktop/design/images/workspace-share-button.png).

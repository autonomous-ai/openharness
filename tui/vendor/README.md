# Terminal compatibility patches

These are the source and manifests from the published `alacritty_terminal` 0.26.0
and `vte` 0.15.0 crates, with their upstream licenses. Upstream integration-test
fixtures and example programs are omitted; the corresponding manifest targets
are omitted too. Their notices are also embedded in hn's THIRD_PARTY_NOTICES.md.

Local changes are marked `hn` in the relevant source:

- `vte/src/ansi.rs`: SGR 21 means double underline, as in tmux 3.5a; SGR 53/55
  enables/disables overline. Accept tmux 3.5a's `capture-pane -e` spelling `5:3`
  so streamed snapshots retain overline.
- `alacritty_terminal/src/term/cell.rs`: widen cell flags to retain blink and
  overline, including otherwise blank cells during scrollback reflow.
- `alacritty_terminal/src/grid/resize.rs`: permit one-column panes with clipped
  wide glyphs; avoid endlessly reflowing a two-cell glyph into a one-cell row
  and restore its spacer when the pane grows.
- `alacritty_terminal/src/term/mod.rs`: handle both blink variants (tmux treats
  them alike), blink reset and overline attributes in the cursor template.

Keeping these attributes in the native grid makes erase, scrolling, cursor save,
alternate screens, history and reconnect use the existing terminal operations.
The pane capture/rendering regression tests cover the downstream behavior.

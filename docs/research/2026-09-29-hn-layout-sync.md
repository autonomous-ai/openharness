# hn layout changes survive desk synchronization

C-b Space could briefly select a layout and then return to the previous arrangement. Two
independent reproductions explain this:

- A backend predating `layout.tmux` rejects the field. hn retries without it, then treats its own
  accepted reply as a remote layout change and rebuilds the previous desktop preset.
- Fitting a received layout to a differently sized terminal queued a resize notification that
  also published another desk layout. Two clients could repeatedly send their fitted sizes back.

The fix distinguishes the last observed desk document from a local edit, recognizes accepted
layout writes, and keeps unsent input until it can be saved. Desk writes run in order, including
legacy retries, in batches of at most 200 operations. Only a schema rejection (HTTP 400) triggers
legacy fallback; an outage does not permanently disable native layouts. Terminal fitting still
fires the tmux resize hook, but only explicit arrangement/divider edits publish a desk layout.
Genuine remote layout changes and pane membership changes still reconcile normally.

## Reproduction and verification

`tui/tests/layout-sync.py` runs real hn clients inside private tmux PTYs. It covers the actual
C-b Space sequence, all seven named layouts, divider sizes, delayed older saves, a transient
500, read-only desk mode, unrelated desk updates, intentional remote layouts, large edit bursts,
and differently sized clients without an echo loop. It rejects ports outside 19800–19809, freezes
the tested binary, uses disposable homes and explicit socket names, and waits for its clients to
exit before deleting their homes.

```sh
CARGO_TARGET_DIR=/tmp/hn-layout-target cargo test --manifest-path tui/Cargo.toml --release --offline
CARGO_TARGET_DIR=/tmp/hn-layout-target cargo build --manifest-path tui/Cargo.toml --release --offline
HN_LAYOUT_TEST_BINARY=/tmp/hn-layout-target/release/harness-tui \
  HN_LAYOUT_TEST_PORT=19801 python3 -u tui/tests/layout-sync.py
```

There are 132 Rust tests, including reconciliation, legacy acknowledgements, queued input and
terminal fitting. The existing e2e suite also passed on macOS. The on-demand CI workflow runs the
new layout suite on both Linux x86-64 and ARM64 along with the existing checks.

`tui/tests/viewer-live.mjs` additionally seeds two disposable harnesses in the real backend desk,
opens a real hn PTY over the real daemon, sends C-b Space, verifies the stored native layout, and
checks that a remote rename leaves its geometry and pane identities intact. Its existing browser
and terminal recovery checks remain enabled. The stack is isolated on one physical Mac with real
MongoDB, Redis, backend, daemon, tmux and Chrome; OAuth and the model process are fixtures. This
is not a production-account or separate-physical-computer test.

An old backend still cannot store the exact tmux geometry for a future client. This change keeps
that geometry stable in the current client; full native layout persistence requires a backend
that supports `layout.tmux`. No release or installed hn binary is changed by these tests.

## Desktop round-trip follow-up

A further two-pane regression reproduced a reset after a desktop layout save. Desktop's
serializer retains presets and sizes but omits `layout.tmux`; hn previously treated that omission
as a new remote layout. It also reacted to metadata for unrelated pane counts. Reconciliation now
compares the native layout when supplied, otherwise the effective preset for the current pane
count. Metadata-only round-trips preserve the current geometry, including unequal divider sizes.

C-b Space and every named layout use the same publication path. Where desktop has a matching
shape, hn publishes a valid preset for that pane count alongside its native geometry. Queued
choices survive reconciliation; resizing after a genuine remote choice keeps that remote preset.
The regression covers modern and legacy schemas, read-only mode, and real two-pane prefix input.
The isolated real daemon/backend test also drops native geometry as desktop serialization does,
then verifies both preservation and a deliberate subsequent remote change. All 148 Rust tests,
the layout suite, pane UI, local shell lifecycle, complete e2e and real-stack checks pass locally.

## Shared pane order

A desktop drag can change `tabs[].panes` without changing membership or geometry. hn previously
compared only membership, so those reorders were ignored; insertions were appended after existing
panes. A saved native layout could also retain an obsolete order through its numeric pane IDs,
which are local to an hn server rather than portable harness identities.

The shared pane sequence now defines placement in screen order: across the top, then down.
Reordering an existing window relabels its layout slots while preserving unequal dividers and
focused harness identity. Insertions use their shared index. Loading native geometry retains its
split sizes but uses the desk identities for placement. Local swaps, rotations and mirrored
layouts publish the matching `pane.move` operations with their geometry. Unchanged desk snapshots
and replies arriving before queued keyboard edits are sent do not revert those edits.

Five unit regressions cover live reorders, combined order/layout changes, stale native IDs,
queued local rotation and the difference between spatial order and tree traversal. The real-PTY
layout fixture also checks desktop-style moves, insertion at the front, focus and divider
preservation, keyboard rotation and swaps, fresh clients, legacy schemas and read-only mode.

The isolated real-stack test also passes desktop-to-hn reordering and hn-to-desktop swaps
through the real daemon/backend on one Mac, checking pane identities, focused harness and
unequal divider preservation. OAuth and model execution remain fixtures.

# Current-main integration for the daemon core extraction

The extraction branch integrates main `75424f53183e3e5ad8abc0e01ef0d7fd554fb616` after the Devices legacy-state move (`5df325a95a`). Main changed Linux root selection, hook installation, launch retries, Devices routing and failure logging. Those changes must reach the extracted owners without restoring optional code in core.

## Design

This integration adds no persisted customer data, query, account authority, dependency or feature. Growth, concurrency, read cost, audience and identity retain the extraction designs. The worker-plan hash includes main's edge home bridge; the private contract remains version 7. Public clients retain the existing compatibility paths. Linux's hook migration uses bounded setup rendering and final native-file publication. A retry builds its launch file only when the terminal dispatches, after its current-authority checks. A held Windows command remains byte-identical. Rollback remains the immutable-cohort selection and custody protocol already described in the core plan.

Failures retain their named states and now include only `errorKind` in diagnostic lines. Raw command arguments, paths and exception messages are not logged. Paste retains its failure reply as structured state, separately from the diagnostic line. Runtime logging introduces no I/O or timers on the successful path. Platforms: macOS validation here; Linux migration fixtures simulate roots in private homes; actual Linux acceptance remains pending and native Windows is deferred by the owner. Mobile is outside this task.

## Integration evidence

All 113 conflicting files and 190 conflict hunks were reviewed against both sides. Existing core Browser modules remain deleted; their behavior is in gateway. Component startup, optional inline composition, common service-session presentation, storage-child preparation and the legacy Devices ordering boundary remain extracted.

- Deferred launch-factory regression: actual RED `20261119T093457.557530Z-69477`, then all 145 engine-launch cases pass in `20261119T093631.183199Z-70998`. Two obsolete pane expectations in that batch were corrected later.
- Initial caller integration: `20261119T093842.723041Z-73896`, 1,343 passing cases, 11 failures and one migration setup failure. These failures are retained, not counted as acceptance.
- Corrected caller batch: `20261119T094605.823077Z-82377`, 976 passing cases and five failures. Hook deadline/late-publication cases pass after the fixture retains every live deadline instead of overwriting the registry deadline with a completed child request's timer.
- Moved probe privacy: the first fixture failed before reaching refusal (`20261119T094457.693770Z-81200`); corrected actual RED `20261119T094529.807738Z-81648` shows the private argument/path in the log. The subsequent batch passes the corrected regression.
- Main's failure-log architecture check finds 70 sites across the extracted graph. Raw-error logging is replaced, fixed failure codes gain failure kinds, and finite reply classifications select literals rather than forwarding exception text.
- `20261119T095138.748665Z-88117`: types pass; architecture, failure-log checks, Create and actual-child disk-failure checks pass (237 cases overall). One remaining hook-migration expectation assumed the default Claude home; it now checks the explicitly selected profile's projects directory.

The merge is a source checkpoint, not release acceptance. Full combined coverage, packaged native behavior, final performance comparisons and independent review remain open. Earlier cost holds in the core plan are unchanged.

## Final main update

The integration includes `36c1bac7aa` (Devices locates the same tmux as core) and `a38553f5f6` (bounded long voice delivery). Runtime and test merges are automatic; the only conflict is the Devices documentation row. Resolution retains component-owned startup discovery and adds main's tmux lookup description. The cohosted-focus correction remains in `devicesProcess.ts`, outside core. Final local gates cover the combined source; the added long-transcript native case is selected alongside Wi-Fi acceptance. No backend source differs from this main revision.

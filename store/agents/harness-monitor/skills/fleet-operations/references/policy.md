# Cleanup proposals

The policy file is `~/.config/harness/policy.jsonc` (or under XDG_CONFIG_HOME). The same local rules are
applied to each linked machine in the monitor. They produce a preview, never a background cleanup job.

| Rule | Default | Meaning |
|---|---|---|
| runningCeiling | 100 | Per machine, propose stopping least recently active unprotected sessions above the ceiling. |
| stopAfterIdle | 1d | Propose stopping a running session whose last conversation activity is older than this. |
| hideAfterIdle | 14d | CLI list filter only; --all includes older rows. The monitor table includes all rows. |
| stopWhenWorkspaceGone | true | Propose stopping a local session whose folder no longer exists. Remote paths are not checked locally. |
| protect.needsInput / working / pinned | true | Exclude questions, open turns and pinned sessions. |
| protect.attached | true | Reserved for inventories that report attachment; current daemon inventory does not. |

Offline sessions, unknown activity, the monitor itself and unavailable controls are also protected.
A stopped session is retained by its daemon and remains openable when that engine supports open.
There is no retire/forget rule and no transcript deletion.

To review a threshold, edit the file while preserving comments, then run `hps stop --policy --machines`.
`--apply` is an explicit action. The viewer's Cleanup button shows eligible rows and reasons before
Stop reviewed sessions. If activity changes, the action refuses the stale target. Keep bulk operations
within the person's approved scope; changing rules is a separate decision.

# Monitor signals

Every machine answers through its owning Harness daemon. The monitor requests `agents_list` with
`includeStopped` and `monitor`. Older daemons may omit monitor metadata; show Unknown rather than
guessing from CPU, terminal text or file modification times.

| Field | Source and limits |
|---|---|
| Identity | Composite machine ID and agent ID. Agent IDs alone are not fleet-wide identities. |
| Working / Needs you | The daemon's open-turn and pending-question state, also used by app events. |
| Done / Failed | Live turn completion events, cleared by a new turn or opening the session. Lost after daemon restart. |
| Starting / Stopped | Daemon launch and lifecycle state. Offline means the machine or inventory request is unavailable. |
| Last active | The agent frame's updatedAt (real conversation activity), falling back to createdAt. Never registry touchedAt or transcript mtime. |
| RAM | Sum of RSS for the recorded process and its children after matching PID and start marker. Shared pages may be counted twice; not a promise of memory freed. |
| CPU | Process-tree percentage from ps. May exceed 100% across cores; OS averaging differs. |
| Tokens | Daemon tokenUsage.totalTokens. Missing usage remains unknown. |
| Model / project / branch | Daemon agent metadata. A path from another machine is not a local filesystem path. |
| Pins / rules | Local ~/.config/harness/policy.jsonc, applied to the fleet visible from this monitor. |

The viewer refreshes local readings while visible and remote readings less often. Refresh asks every
online machine. Offline rows keep their last metadata but disable actions and clear resource readings.
A reconnected machine must answer again before its controls become available. Cleanup rechecks live
activity; manual stops also revalidate conversation identity.

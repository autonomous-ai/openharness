---
name: fleet-operations
description: Inspect Harness sessions, explain activity and resource readings, preview cleanup, and stop or open explicitly selected sessions through their owning daemons.
---

# Fleet operations

The table is the primary interface. Use this skill when the person asks the assistant to investigate
sessions or review cleanup. Do not start work simply because the monitor opened.

Start with `"$HPS_CLI" ls --json --all --machines`. Read [references/signals.md](references/signals.md)
before explaining activity or resource readings. Use composite machine/agent IDs when names or IDs
are ambiguous. Missing measurements are unknown; an offline machine is not a stopped session.

## Actions

- `hps show <ref> --machines --json` reads one session.
- `hps stop <ref> --machines --json` asks its owning daemon to stop the process and retain history.
- `hps open <ref> --machines --json` restores saved launch settings. Check `resumeMode`: conversation,
  fresh conversation, or shell. Do not promise every engine resumes the same conversation.
- `hps stop --policy --machines --json` previews cleanup; `--apply` applies the current plan.
- `hps cleanup --machines --json` previews harnesses outside all open tabs; `--apply` closes them.
  Background tabs and local utility tabs such as Companions stay open.
- `hps open --stopped --machines --json` previews reopening stopped sessions; `--apply` executes it.

For more than two sessions, show the dry run with reasons and obtain approval before applying it, unless those targets are already authorized.
Recheck the plan after approval; if the targets changed, present the new targets. Named actions must
still correspond to the person's request. Never use `--force` unless explicitly requested for those
sessions. The row's × button is an explicit single-session stop and may interrupt work in progress.

The daemon owns process identity, stopping and open configuration on local and linked machines.
Do not signal PIDs, reconstruct engine flags, respawn a tmux pane, or edit the registry. After a timeout,
read the original open receipt; do not invent a new operation to compensate. Explain refusals and
uncertain outcomes. Receipts are recorded in `~/.harness/monitor/log.jsonl`.

## Close harnesses outside tabs

Use `hps cleanup` only when the person asks to close harnesses outside their tabs. Review the names
and activity first: it includes working and unknown activity and can end unfinished work. The owning
daemon rechecks open tabs and session identity and saves history before closing. Never bypass those
guards. Report offline machines, unsupported versions, save failures and unconfirmed closes.

## Cleanup rules

[references/policy.md](references/policy.md) explains the proposal rules. They never run automatically.
Working sessions, questions, pins, unavailable controls and unknown activity are protected by default.
These policy rules do not use the open-tab guard of the separate `hps cleanup` command.

Rules and pins live in `~/.config/harness/policy.jsonc`. Preserve comments and simulate a proposed
change before applying it. Do not change thresholds to make a refused cleanup succeed.

Never delete transcripts or project folders. Stopping a process can interrupt unfinished work, even
though its history is retained. Report what the tools actually confirmed.

---
name: fleet-operations
description: Manage the machines on a Harness account by conversation — read the fleet, link and unlink, rename, note and group, bring a new computer in, remove one. Use in a Machine Monitor workspace whenever the person asks about their computers, what is running on them, or wants one added, named, linked or retired.
---

# Fleet operations

One runner does everything: `"$MACHINES_CLI" <command>`. Text by default, `--json` when you want to
read fields rather than a table. Exit code 1 means it did not happen, and the line above says why.

Name a machine however the person did — its name, its hostname, a nickname set here, or the first
characters of its id. An ambiguous name is refused with the candidates listed; put those in front
of the person with the question tool instead of guessing. A wrong guess renames or deletes the
wrong computer.

## Look

| Command | What it is for |
|---|---|
| `status` | The observation the pane has already published. No network. **Start here.** |
| `refresh` | Observe now and republish. Use after something changed elsewhere. |
| `list` | A fresh read of every machine on the account. |
| `show <machine>` | One machine: state, link, projects, harnesses. |
| `doctor` | Can this computer manage the fleet at all? |

What a reading contains, and what it does not:

- **Presence and link state are separate.** "online · link required" is a machine that is perfectly
  well and simply not linked from here. Do not collapse the two.
- A machine that is **not linked**, **offline**, or **shared read-only** has no roster. Report it as
  *not readable from here*, never as zero harnesses.
- `open` means a harness is still there — a session that exists. It is not a claim that an agent is
  typing this second, and you must not upgrade it into one.
- The only honest time a roster carries per harness is when it was **created**. Say "started 3d
  ago". There is no "last worked on" in this data.

## Link

Linking lets this computer reach another machine's harnesses. It needs the remote password set on
**that** machine, and that password never comes through the conversation:

1. `show <machine>` to confirm it is the right one and that it needs a link.
2. Tell the person to click **Link** on that machine in the pane and type the password there.
3. `refresh` once they say it went through; then say what the machine turned out to be carrying.

If they paste the password to you anyway, use it once and let it go: `printf '%s' '<password>' |
"$MACHINES_CLI" link <machine> --stdin`. Never echo it, never put it in a note, never keep it.

`unlink <machine>` drops this computer's link only. The machine stays on the account, keeps running,
and can be linked again. `links` lists what this computer has linked. `password [status|clear]` is
about THIS computer — whether another machine can link to it.

A refused password says so plainly; it usually means the password was changed on the other machine,
or `harness remote-password set` was never run there.

## Bring a computer in

`invite` prints the three steps the person runs **on the other computer**: install Harness, sign in
to this account, start it and set a remote password. Then:

```sh
"$MACHINES_CLI" watch --seconds=600
```

waits and names the machine the moment it signs in. Offer, in one question: link it now, name it,
or both. A machine can also be brought in by installing the Harness app there and signing in — the
CLI steps are for a server with no screen.

## Name, note, group

| Command | Reach |
|---|---|
| `rename <machine> <name>` | The machine's real name, on every screen of the account. Max 40 characters. |
| `nickname <machine> <text>` | A label only this workspace uses. `--clear` removes it. |
| `note <machine> <text>` | Something to remember: what it is for, where it lives. `--clear` removes it. |
| `group <name> add\|remove <machine>` | Keep a set of machines together (`studio`, `rack`). |

Renaming a machine that is shared with other people changes it for them too; say so before doing it.
A nickname is the polite alternative.

## Remove

`remove <machine> --yes` takes a machine off the account. It cannot be undone. Before running it:

- Say what it means: the machine leaves the account, its harnesses stop being reachable from
  anywhere, and anything running on it keeps running on that computer but is no longer on this map.
- Get an explicit yes through the question tool. Without `--yes` the command refuses, which is the
  backstop, not the conversation.
- The computer you are running on is refused outright. `harness logout` on that machine is its own
  door, and it is the person's to open.

Prefer `unlink` when the person means "stop reaching it from here", and `remove` only when they
mean "this computer is not mine / not in use any more".

## When something is wrong

- **"Harness is not running on this computer"** — the daemon is down. `harness start`, or open the
  Harness app. Nothing else here will work until then.
- **"Not signed in"** — `harness login` on this computer.
- **A machine did not answer** — it was reachable a moment ago and is not now. Say so, keep the last
  known reading (the pane marks it stale), and offer to try again rather than declaring it offline.
- **The pane has published nothing** — run `refresh`; that writes the observation the pane reads.

Every operation you run is recorded in this workspace and appears in the pane's Recent list, so the
person can see what changed without asking you to repeat it.

The header above the pane answers one question — is what you are looking at true? A machine that is
offline or not yet linked is a state it reports quietly; only a machine that should have answered
and did not is a warning there. Do not read "ready" as "the fleet is perfect".

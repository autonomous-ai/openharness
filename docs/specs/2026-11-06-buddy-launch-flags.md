# Restart a Buddy with extra launch flags (Diego, 2026-11-06)

## What Diego asked

Restart his Buddy with extra launch flags ("extensions") that stay on, for example Claude Code's `--chrome`, so the Buddy can
use Claude in Chrome to read his browser's tabs and their content.

His choices:
- **Free-form flags:** a text field, not a curated list.
- **Kept:** the flags stay on every later launch of that Buddy (restart, reboot, daemon update, model switch) until he clears
  them.
- **Where:** a "Restart Buddy…" item in the Buddy chat's menu in Desktop.
- **Stored on the machine** that runs the Buddy (the daemon's agent record), not in the backend.

## How it works today (main 96b30cf0d)

- A Buddy is an agent on the person's machine, started by the Swarm host with `agent_create` (`cli/src/superTabs/start.ts`).
  Claude runs it with `--dangerously-skip-permissions` (`cli/src/engines/claude/launch.ts`, mode `buddy`).
- Every relaunch rebuilds its argv from the saved record. `buildLaunchOverrides` (`cli/src/lib/launchOverrides.ts`) appends,
  in order, the DSH args, the named agent, machine MCP servers, the Swarm's args, and last Harness's instructions (joined by
  `joinedInstructions`). The record holds no free-form flag list. The one exception is `externalResume.session.launchArgs`,
  the argv of an adopted outside session (`cli/src/core/agents/launch.ts`).
- `agent_restart` (`cli/src/backendSocket.ts`, then `relaunch` in `cli/src/core/agents/launches.ts`) kills and respawns the
  process in its pane and resumes the conversation. It takes only `agentId`.
- Desktop: `AppNotifier.restartAgent(machineId, agentId)` sends it. The Buddy chat's menu has "Rename Buddy…" and
  "Remove Buddy" (`desktop/lib/super_tabs/view.dart`). The Buddy bar's "Start again" removes and re-adds the Buddy.
- Nothing in the repo uses `--chrome`.

## Behaviour

### Desktop

- The Buddy chat's menu gains **"Restart Buddy…"** after "Rename Buddy…". It shows only on the reader's own Buddy chat
  (`editable`), only when the Buddy has an agent on a machine.
- It opens a dialog in the app's dialog style:
  - Title "Restart Buddy".
  - Field **"Extra launch flags"**, monospace, one line, prefilled with the Buddy's current flags (empty when none). Hint:
    `--chrome`.
  - Detail line: "Added to <engine>'s command line each time this Buddy starts on <machine name>. Your Buddy runs with full
    permissions. Don't put secrets here: other people on that computer can see them. Clear the field to remove them."
  - The item shows only when the Buddy has an agent on a machine (`harnessId` and `machineId` set).
  - Buttons **Restart** (primary) and Cancel. Enter restarts.
- Restart sends `agent_restart` with `launchArgs` to the Buddy's machine. While it runs, the button shows progress and the field
  is read-only.
- Results:
  - **Restarted:** the dialog closes. The Buddy keeps its conversation.
  - **Refused** (`INVALID_LAUNCH_ARGS`): the dialog stays open with the daemon's message under the field, for example
    "--model is set by Harness and can't be added here.".
  - **The engine did not start** (the restart's or resume's unconfirmed or `RESTART_FAILED` outcome): the dialog stays open with
    "The Buddy didn't start with these flags. Fix or clear them and restart." Nothing was saved, so the Buddy keeps the flags that last worked. Each press of
    Restart in the dialog is a new intent with its own receipt and always sends the field, so clearing it and pressing Restart
    recovers.
  - **Any other failure** (offline, busy, not installed, a lost reply): the dialog stays open with that failure's own text.
  - **A stopped Buddy:** Restart resumes it with `launchArgs` (`agent_resume`).
  - **Older daemon:** an answer with no `launchArgs` echo means that computer's Harness does not know the field and restarted
    without the flags. The dialog stays open with "Update Harness on <machine name> to use launch flags."

### Daemon (CLI)

- `agent_restart` and `agent_resume` take an optional `launchArgs: string` (resume too, so a Buddy that a bad flag left
  stopped can be brought back with the flags fixed or cleared; review of the first build):
  - Absent: a restart as today, and the saved flags still apply.
  - Present: parse it, validate it, save it on the agent's record (empty clears it), then restart.
- **Parsing:** split as a POSIX shell would split words: whitespace, single and double quotes, and backslash escapes. No
  expansion and no shell. An unclosed quote is refused.
- **Validation** (`INVALID_LAUNCH_ARGS`, with a message naming the problem):
  - at most 1024 characters and 20 words;
  - no NUL or newline;
  - every word that starts with `-` and names a flag Harness sets itself for that engine is refused. The flag is the part
    before any `=`. The list is per engine, because the same short flag means different things: `-c` is Claude Code's
    `--continue` but Codex's config override, which stays allowed.
    - **Claude Code:** `--resume`, `-r`, `--continue`, `-c`, `--model`, `--permission-mode`,
      `--dangerously-skip-permissions`, `--session-id`, `--settings`, `--setting-sources`, `--append-system-prompt`,
      `--append-system-prompt-file`, `--system-prompt`, `--system-prompt-file`, `--mcp-config`, `--fork-session`, `--effort`.
    - **Codex:** `--model`, `-m`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--full-auto`,
      `--ask-for-approval`, `-a`, `--sandbox`, `-s`, `--profile`, `-p`, the words `resume` and `fork`, and a `-c` /
      `--config` whose key (before `=`, also when the value is the next word) is `model`, `model_provider`, `profile`,
      `sandbox_mode`, `approval_policy`, `developer_instructions`, or starts with `mcp_servers` or `model_providers`.
    - **Any other engine:** only the length, word-count and character rules.
  - For every engine, the word `--` is refused (it would turn Harness's own later arguments into positional ones).
  - A refused short flag with its value attached is refused too: a single-dash word whose first letter is a refused short
    flag (Claude `-r<id>`, Codex `-mo3`, `-sdanger-full-access`).
  - For Codex, a bare `resume` or `fork` word is refused anywhere, not only first: Codex reads it as its subcommand after
    other flags too.
- **Saving (audit):** the new words travel with the relaunch (in its launch source, as a retarget carries its target) and are
  saved on the record only when the relaunch succeeds, the way `launchModel` is. A refused or failed restart or resume
  (busy, no live process, the engine not starting with them) saves nothing, so the record keeps the flags that last worked
  and nothing is rolled back. The record field is `launchArgs?: string[]`, never written when empty.
- **Stopped agents:** `agent_resume` with `launchArgs` finds a stopped agent in the stopped-agents store as resume does,
  and resumes it with the new words; the resumed row keeps them.
- **Applying (audit):** the owner's words go LAST on the command line, after Harness's instructions, the model and the first
  prompt, in their own slot (`ownerArgs`), so a trailing flag that takes a value fails loudly at startup instead of
  swallowing Harness's own arguments. Each launch checks the saved words again with the same validator; if any is refused
  (a hand-edited row, or a flag a later release refuses), none is applied and the daemon logs why. The first `agent_create`
  never carries them.
- **Answer:** a successful restart answers as today plus `launchArgs: string[]`, the words now saved (`[]` when cleared).
  Desktop reads the echo to tell a new daemon from an old one.
- **Reading them back:** the agent's frame (`agents_list` and agent pushes) carries `launchArgs` when it has any, so the
  dialog can prefill.
- **Audience (audit):** `launchArgs` is taken only from the machine owner's own app clients (Desktop, the web viewer); a
  device (dial, Pro), a local tool client (an agent's own harness CLI) or anyone else gets `INVALID_LAUNCH_ARGS`. A
  team-written agent refuses it too, as it refuses a permission change.

## Design

- **Growth:** at most 1 KB more on one agent record. No new files.
- **Concurrency:** the save and the restart run in the existing restart operation, under its receipt (`creationId`). A
  repeated request with the same receipt does not save twice.
- **Read cost:** none. The flags are read with the record each launch.
- **Scale:** per agent, so 10x Buddies is 10x one small field.
- **Compatibility:**
  - An old daemon ignores `launchArgs` and restarts without it. Desktop sees no echo and says to update Harness.
  - An old Desktop never sends it, and the saved flags still apply.
  - The record field is optional, so an old daemon reading a record from a newer one ignores it.
- **Migration and rollback:** none. Rolling back the daemon leaves the field unused.
- **Security:**
  - The flags go to the engine as argv words, never through a shell.
  - The Buddy already runs with full permissions on the owner's own machine, and only the owner can set its flags.
  - The refused list keeps Harness's own session, model, permission and instruction flags from being overridden. Other flags
    are the owner's choice and the dialog says so.
  - The flags are logged as words only where launches are already logged.
- **Failure:** a flag the engine rejects means the engine does not start, the restart fails as today, and the saved flags stay
  for the owner to fix or clear.
- **Platforms:** the CLI on macOS, Linux and Windows (Windows refuses batch-file engines' risky argv through the existing
  `launchRefusal`), and Desktop. The web viewer gets the same menu item.
- **Not in scope:** flags for agents other than Buddies in the UI, a curated extension list, the backend, the dial and the
  phone.

## Test

- **CLI parsing and validation:**
  - quotes, escapes and an unclosed quote;
  - over 20 words and over 1024 characters;
  - NUL and newline;
  - each refused flag per engine, alone and with `=value`;
  - Codex's `-c key=value` is allowed and Claude's `-c` is refused;
  - empty clears.
- **CLI restart:**
  - `agent_restart` with `launchArgs` saves them, answers with the echo, and the respawned argv contains them after the
    Swarm args and before the instructions;
  - a later plain restart, a restore after daemon start, and an `agent_retarget` model switch still contain them;
  - an empty string removes them;
  - a team-written agent is refused;
  - `agents_list` carries them.
- **Desktop:**
  - the menu item shows on the reader's own Buddy chat only;
  - the dialog prefills the current flags;
  - Restart sends `launchArgs`;
  - each result above shows the text named there: refusal, did not start, and no echo means update Harness.

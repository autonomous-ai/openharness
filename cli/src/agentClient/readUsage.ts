/** Help text for the CLI commands that report a harness state. */
export const ON_MACHINE = '--machine <name> is another of your machines, by its name or id as harness new takes it; this one when left out.'

export const PS_USAGE = `Usage: harness ps [--machine <name> | --machines] [--all] [--json]

The harnesses on a machine: name, agent, state, who started it, when it was last active, and what it is about.
--all adds the ones stopped in the last week.
On macOS and Linux, a tmux engine that just exited reads as stopped while its pane is still listed.
--machines lists every machine of yours at once: each is asked for 5 s, and one that does not answer is listed as
unreachable.
${ON_MACHINE}`

export const SHOW_USAGE = `Usage: harness show [--machine <name>] <name> [--chars N] [--work] [--json]

A harness's state and its last turn: what it was asked and what it answered (the first N characters, 4000 by default),
and how many background commands it still runs when idle.
On macOS and Linux, an exited tmux engine reads as stopped even if its pane still shows a shell.
An inconclusive engine check reads as unknown.
--work says its work instead, as facts read on its machine: its branch, its pull request, the files and lines it
changed, and its checks.
${ON_MACHINE}`

export const WAIT_USAGE = `Usage: harness wait [--machine <name>] <name>[,<name>…] [--any] [--timeout 30m] [--json]

Waits until each harness has stopped working and the background commands it started have ended, then prints its state.
--any returns when the first one does.
Exit status: 0 idle or closed by you, 1 one's launch failed (harness show says why), 3 one needs the person (a question, a permission, or a problem only they can fix), 4 one stopped, is gone, or its machine refused it,
124 timed out.
--timeout takes 90s, 30m, 2h; 0 waits as long as it takes.
${ON_MACHINE}`

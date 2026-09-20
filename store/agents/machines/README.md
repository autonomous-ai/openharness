# Machines, as a Harness agent

Your computers, managed by talking. Ask for a machine to be linked, renamed, grouped, noted or
retired; ask what any of them is carrying; ask how to bring a new one in. Beside the conversation,
a live map: every machine you own, the harnesses each one holds, the projects those harnesses are
in, and when the work started.

It reads nothing but Harness. The machine list is the one the app itself shows
(`GET /api/machines`, proxied by the local daemon), and each machine's roster comes over Harness's
own machine bridge — the same paired, encrypted path the app uses to open a pane on another
computer. This package never holds a token, a key or a password.

## Install and open

Choose **Machines** in the Harness Store, or install this checkout:

```sh
harness dsh install "$PWD/store/agents/machines" --link
harness dsh doctor autonomous/machines
```

Open Machines in a new workspace and ask: "Show me my machines, and link the one that needs it."

## What it can do

| Ask for | What happens |
|---|---|
| "show me my machines" | The published observation: every machine, its state, what it is carrying |
| "what is the studio iMac running?" | That machine's projects and harnesses, newest first |
| "link the 4090 rig" | The pane's Link row takes the remote password; the roster fills in |
| "call it the loud one" | A rename on the account, or a nickname only this workspace uses |
| "I'm setting up a new laptop" | The three steps to run there, then a watch that names it when it signs in |
| "retire the old MacBook" | What retiring means, an explicit yes, then it leaves the account |

The agent's runner is `$MACHINES_CLI` (`toolchain/machines`): `status`, `list`, `show`, `rename`,
`nickname`, `note`, `group`, `link`, `unlink`, `links`, `password`, `invite`, `watch`, `remove`,
`refresh`, `doctor`. `--json` on any read.

## The pane

Three views over one observation:

- **Fleet** — every machine around this computer. Each machine is a ring of ticks, one per harness,
  grouped into an arc per project: a long breathing tick is a harness still open, a short faint one
  is closed, and the hue is the agent running in it. The number inside is how many are open. A
  dashed, empty ring means the machine could not be read — never that it is idle. Lines are this
  computer's links; dotted amber is a machine still waiting for one.
- **Projects** — every project with a harness open, threaded to the machines it is open on.
- **Activity** — each harness as a mark at the time it was created, over 24 hours, 7 days or 30.

The pane is read-only with one exception: the row of an unlinked machine takes its remote password
and hands it straight to `harness link connect`. That is deliberate — a password typed to an agent
lives in a transcript, and this one never needs to.

## Honesty rules the pane keeps

- A machine that is **not linked**, offline, or shared read-only has **no roster**. It reads "not
  readable from here", never "no harnesses".
- **Presence and link state are separate**: "online · link required" is a healthy computer that
  simply is not linked yet.
- **Open** means a harness session still exists. It is not a claim that an agent is mid-turn.
- The only per-harness time a roster reports honestly is when it was **created**; the registry's
  `updatedAt` is stamped by its own reconcile pass, so nothing here draws "last worked on".
- A machine that was readable and then fails keeps its last roster, visibly stale, with the reason.

## Develop and verify

```sh
npm test --prefix store/agents/machines
harness dsh check "$PWD/store/agents/machines"
node store/tools/catalog.mjs

# The pane against a workspace; the chosen port is printed.
HARNESS_WORKSPACE=/path/to/workspace store/agents/machines/viewer.sh
```

The tests run without a daemon: the collector's reads and the machine bridge are both injectable,
so a whole fleet — linked, unlinked, offline, shared, failing — is exercised from fixtures. What
they do not cover is a real relayed dial to another computer; `harness dsh doctor autonomous/machines`
on a machine with peers is the check for that.

## Credit and stewardship

Built by Autonomous for Harness, MIT. It wraps Harness's own machine APIs and adds no service of its
own. Issues with linking, presence or the machine list belong in the Harness CLI; the agent, the
runner and the pane belong here.

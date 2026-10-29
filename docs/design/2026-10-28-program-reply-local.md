# More work for a local harness from a program

October 28, 2026. Proposed, for #1628. Not approved: two shapes for the Harness team to choose between.

A program that acts for the person can start a harness on one of their computers and read its answer,
but cannot give it more work. The lamp (lampOS) hands a person's spoken request to Claude Code on their
computer with `harness new claude --machine office --task …`, waits (`harness wait`), and reads the answer
(`harness show`). When the lamp checks that answer and it fails (a `skill.toml` its checker refuses), the
lamp has one move left: close the harness and start a new one, told everything again. A coding agent in
the same place would type the checker's errors into the same session.

## What exists

- **`harness reply`** (`agentClient/commands.ts` `replyCommand`) takes words from the person, or a program
  acting for them, for a **cloud** harness only: `if (t.frame.location !== 'cloud')` refuses a pane.
- **`harness tell`** (#1718, `tellCommand`; the machine's side in `messages/tell.ts`) gives more work to a
  harness **an agent** started, from that agent's pane, behind the person's `agents-tell-agents` (off by
  default). The machine the harness runs on checks its own record of who started it (`tellRefusal`).
- **A program has no caller.** `outsideCaller` (`agentClient/model.ts`) recognises agents only:
  `CLAUDECODE`, `CODEX_THREAD_ID`, `AI_AGENT`. A plain program is read as the person, and Harness keeps no
  record of what it started ("only an agent's starts are recorded", `commands.ts` `machineOf`).

So neither command reaches a local harness for a program, and `tell`'s rule ("only one you started")
has nothing to check for one.

## What stays the same, whichever shape

- **Never an answer the person owes.** A harness in `needs-input` (a question or a permission) is the
  person's alone. Only an **idle** harness takes the words, as more work.
- **Typed by the mailbox**, as `tell` is (`messages/mailbox.ts`): into the composer once it is free, never
  over a person's draft.
- **The person's switch.** Off by default; a program asks the person first, as `TELL_OFF_TEXT` does.
- **The same bounds as `tell`:** `LIMITS.text`, `LIMITS.perSender` in `LIMITS.window`, `LIMITS.waiting`.
- **No new transport or credential** reaches another machine: `--machine` goes over the machine link
  `tell` already uses.

## Shape A: `harness reply` for an idle local harness, as the person

`replyCommand` drops its cloud-only refusal for a harness in a pane, when the caller is not an agent
(`o.caller === null`) and the harness is idle. The machine takes a new request, `reply_local`, beside
`tell` in `messages/service.ts`, from a local asker or over the machine link, and queues the words under
`TOLD_TAB` from the person.

- **Small:** about 40 lines in `replyCommand` and `service.ts`, tests beside `tell`'s in
  `commands.spec.ts` and `messages/*.spec.ts`.
- **Wide:** it reaches **any** idle local harness of the person's, not only one the program started. That
  is what the person can already do by typing in Harness, and what `reply` already lets a program do for
  a cloud harness; but a program that should not reach a harness can.
- **The switch:** a new one (`programs-reply`), since `agents-tell-agents` is about agents.

## Shape B: a start handle, then `harness tell --handle`

`harness new --json` returns `handle`: random, unguessable, kept by the machine the harness runs on in
the start's line of its ledger, with the start. `harness tell --handle <h> <name> -- <work>` from a program
is checked by that machine as `tellRefusal` checks a pane today, against the handle in place of the
starter's agent id.

- **Narrow:** "only one you started" holds for programs, as it does for agents.
- **New:** the start hands out a secret. It never leaves the person's machines (the machine link carries
  it like `tell`'s `from`), is good for that one harness, and ends when it closes. But it is new state for
  the Harness team to keep and reason about.

## What the lamp does with either

At most once a task, with its checker's output (bounded, no secrets) as the words, then `harness wait`
and `harness show` as now. If the person's switch is off, it starts a new harness, as it does today.

## Asked

Which shape, or another. The PR that builds it follows the answer, with the tests named above.

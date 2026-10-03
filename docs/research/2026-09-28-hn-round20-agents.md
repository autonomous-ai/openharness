# hn agents workflow review, round 20

Frozen commit: `b5830ad94a99f6ac1ee5cee3075b8ea6ffd4f83b`.
Binary SHA-256: `d5d86c66bcce80dc9c2ba2e150fa249b06e3aaf3b6f2b9d0b36b4e9c48cb10a6`.

**Score: 9 / 10. No confirmed merge blocker in this bounded review.** The round 19
High is fixed: an asynchronous question hook refuses a replacement request. An unchanged
request still reaches its original harness after the user switches to another harness.

## Isolation and scope

The supplied binary and change manifests were read first. Each driver verified the frozen
SHA-256 before making its owned executable copy. Tests used disposable HOME and HN_TMPDIR,
guarded ports 19520–19522, `hnr20ag...` names, and tmux 3.5a servers with explicit private
`-L` names. Every hn invocation supplied `-L`, `--port`, matching PORT and HN_SOCKET_NAME;
TMUX, TMUX_PANE and HN_SOCKET were unset inside the outer tmux child too. No default server,
real daemon, installed hn or real agent was used. Native tests had no mock on their port.
The connected cases used the stock mock with `MOCK_DEMO=1 MOCK_FLEET=48`, at 110×30.
All owned clients, servers, supervisor children and mocks were cleaned up in `finally`.
Product sources were read only; this report is the only repository edit from this review.

## Rechecks

| Workflow | Result |
| --- | --- |
| Delayed hook versus replacement question | Passed. A file gate holds `if-shell` until the new question is visible. Releasing the old callback shows `question changed since the hook ran`; the mock records zero answers to the replacement. |
| Valid hook after focus changes | Passed independently for `run-shell` and `if-shell`. The callback begins on billing; focus moves to the login-test harness before the gate opens. The original billing request receives exactly the intended `No` answer. |
| Home is a real pane and survives detach | Passed with and without the daemon. Window `@1`, pane `%1`, and pane count 1 remain after detach/attach. A detached split increases the count to 2. |
| Native shell persistence | Passed. Session, window, pane and shell PID are unchanged across detach/attach; an exported variable retains its value. |
| Typing immediately after a home window opens | Passed. The complete word `claude` reaches the mock terminal. No agent message is recorded. The line is cancelled without executing a real agent. |
| Middle clipping of similar names | Passed. Home rows retain `Add dark mode…settings (2)` and `(3)`, and the checkout-name suffixes. |
| Search and preview | Passed. `nfc` selects the NFC conversation and displays its matching question; `'device !nfc` gives zero results. |
| Open-elsewhere conversation | Passed. Enter keeps the picker open and explains that the conversation must be closed in the other terminal or app first. |
| Resume permission disclosure and identity | Passed. The preview explicitly says resume is without permission prompts. The create payload retains `ext-codex-nfc`, Codex, and the conversation's working directory. |
| Fresh answer guard | Passed. The first immediate `M-1` says `Read the question first — press again`; a second deliberate press records exactly one answer. |
| Failed-launch preview | Passed. React's session-tail preview retains `The agent did not start within 60 seconds.` |
| Scripted detached creation | Passed for `new-harness -d codex /tmp "fix this isolated test"`. The create payload contains the intended engine, directory and prompt; exit status is zero and the active window does not change. |
| Restart while waiting | Passed. Without `-y`, exit status is one and the message explains that the harness is waiting. |
| Hung mock and reconnect | Passed. Stopping the mock produces a visible down/reconnecting indication; input entered while disconnected appears after the mock resumes. |
| Creature excluded | Passed. No creature is visible or referenced in the TUI source or README. The default status contains fleet, connection, project, host and clock fields. |

## Exact critical sequence

Define `H` as the isolated frozen binary invocation described above. Choose the billing
harness and another running harness from the mock's `GET /test/dial` response.

1. Install `harness-needs` with `if-shell` whose shell creates a private `hook-started`
   file and waits for a private `hook-release` file, followed by `answer-harness 1`.
2. Post a `commander_question` for billing with request `q-race-old`, prompt
   `Old review question?`, and choices `Yes`, `No`. Wait for `hook-started`.
3. Unset the hook, post `commander_question_close` for the old request, then post
   `q-race-new` with prompt `New unrelated review question?` and the same choices.
4. Open `C-b A` and wait until the new prompt is visible. Close the picker and create
   `hook-release`. Confirm the refusal message and no answer for `q-race-new` in
   `GET /test/dial`.
5. For the valid case, install a new gated `run-shell "..." ; answer-harness 2` hook.
   Focus billing, post an unchanged question and wait for the gate's started file.
   Unset the hook and use `open-harness -s` to focus the login-test harness. Release
   the callback and confirm its answer has billing's agent ID, the unchanged request
   ID and the value `No`. Repeat with gated `if-shell`.

This review used independent adaptations of the previous drivers in
`/tmp/hnr20ag-review/{review,races,offline}.py`. Evidence is retained under
`/tmp/hnr20ag-sj77z5eb` (connected workflows), `/tmp/hnr20ag-gu7fp0ay`
(gated hooks, scripted creation and reconnect), and `/tmp/hnr20ag-_bm6e6jp`
(native persistence). Temporary evidence is not a runtime dependency. The repository's
full e2e suite also contains the replacement-request regression, but its separate root
run is not counted as independent execution in this score.

## Limits

This is a bounded merge recheck, not a new SSH deployment or real-agent review. It does
not recertify every older notification, multi-choice, long-answer, linked-window or
400-agent census case. The mock's terminal-info path is intentionally fixed, so resume
working-directory validation uses the recorded create payload. Native respawn metadata,
tiny-terminal rendering and RGB corrections developed by the other reviewers are outside
this frozen build and this role's scope. Desktop/device creature work remains separate.

# hn agents workflow review, round 19

Frozen commit: `32f43bb0d541445c312b739d39c2d9265ca45c6a`.
Binary SHA-256: `1df2f355d7b3d5841d91f53a36d744234d93145108768a88565aeacf4cc8b3f9`.

**Score: 8 / 10.** Everyday navigation, previews, home windows and reconnect behavior are much
better. One confirmed High remains: a delayed question hook can approve a replacement question.
Fix that before merging. This score describes the frozen build, before the correction below.

## Setup and rechecks

An owned frozen binary copy, disposable HOME and short HN_TMPDIR, guarded ports 19520–19522,
`hnr19ag...` hn names, and separate named outer tmux servers. Every hn invocation supplied
`-L`, `--port`, `PORT`, and `HN_SOCKET_NAME`; TMUX, TMUX_PANE and HN_SOCKET were unset inside
outer tmux children too. The stock mock ran with `MOCK_DEMO=1 MOCK_FLEET=48`; native offline
checks used a port with no mock. Outer terminal: 110×30, tmux 3.5a. All owned processes were
cleaned up. Product sources were read only during review.

| Previous issue or workflow | Result on frozen build |
| --- | --- |
| Home window has zero panes; detach loses it | Fixed. `@1:%1:1:home` before and after detach/attach, with and without daemon. `split-window -d` makes a second pane. |
| Immediate `claude` after `C-b c` opens or messages an agent | Fixed. The entire word reaches the shell; the mock records no agent message. |
| Native shell persistence | Passed. Original pane and shell PID survive detach/attach; an exported variable retains its value. |
| Long names hide distinguishing suffix | Fixed. Home rows show `Add dark mode…settings (2)` and `(3)`, likewise checkout rows. Activity ordering remains intentional. |
| A hook's asynchronous `if-shell` answers the focused harness | Fixed for harness identity. A question on billing is answered on billing while another pane is focused. Request identity still fails below. |
| Enter on an open-elsewhere conversation is silent | Fixed. The picker stays open and says `It is open in another terminal or app — close it there first`. |
| Resume permission behavior is undisclosed | Fixed. The preview states that resume is without permission prompts. Enter sends the intended NFC session ID, engine and working directory. |
| Conversation hits lose to scattered fuzzy matches | Fixed in the tested fleet. `nfc` selects the NFC conversation first; its matching conversation text appears in the row. |
| Negative session query includes excluded conversation | Fixed. `'device !nfc` gives zero results. |
| Fresh answer guard says the question changed | Fixed. Immediate `M-1` says `Read the question first — press again`; a deliberate second press answers exactly once. |
| Session-tail preview loses launch failure | Fixed. The failed React harness still shows `The agent did not start within 60 seconds.` |
| Scripted new-harness loses arguments or ignores `-d` | Fixed in the tested form. Codex, `/tmp`, and the task reach `agent_create`; exit status is zero and the current window does not change. |
| Restart silently discards a waiting question | Fixed. Without `-y`, exit status is one and the message explains that the harness is waiting. |
| A lost daemon drops pane typeahead silently | Fixed for a stopped/restarted mock. A visible reconnect/down indication appears, and queued text is replayed on recovery. |
| Creature excluded from TUI | Passed. No creature is rendered; the status format contains ordinary fleet, connection, project, host and clock fields. |

## High: a delayed question hook answers a replacement question

The hook now carries the correct harness through `if-shell`, but `answer-harness` reads that
harness's **current** question when the shell callback returns. It does not retain the request ID
that triggered the hook.

Exact sequence, on one harness:

1. Set `harness-needs` to `if-shell "sleep 0.8" "answer-harness 1"`.
2. Emit question `q-race-old`, prompt `Old review question?`, options `Yes`, `No`.
3. After 150 ms, unset the hook, close `q-race-old`, and emit `q-race-new`, prompt
   `New unrelated review question?`, with the same choices.
4. Wait one second and inspect the mock's `/test/dial` answers.

Observed:

```json
{
  "requestId": "q-race-new",
  "answers": { "New unrelated review question?": "Yes" }
}
```

No hook was installed when the second question appeared. The first hook approved it anyway.
A phone answering the first question, followed by a new permission question, produces this race
without any malformed data. Expected: refuse the old callback's answer when the request differs.

Portable reproduction uses the stock mock's `/test/dial` hook. With an attached isolated test
client, define `H` to invoke the frozen binary with its private environment and explicit server
arguments, then run:

```sh
H set-hook -g harness-needs 'if-shell "sleep 0.8" "answer-harness 1"'
# POST the old commander_question frame, then wait 150 ms.
H set-hook -gu harness-needs
# POST commander_question_close for q-race-old, then the new question frame.
```

The question frames have this shape; substitute a harness ID and session ID returned by
`GET /test/dial`, and change the request ID and prompt for the second frame:

```json
{
  "type": "commander_question",
  "agentId": "HARNESS_ID",
  "dbSessionId": "SESSION_ID",
  "payload": {
    "requestId": "q-race-old",
    "questions": [{ "q": "Old review question?", "options": ["Yes", "No"] }]
  }
}
```

The close frame uses the same top-level IDs, type `commander_question_close`, and payload
`{"requestId":"q-race-old","agentId":"HARNESS_ID","dbSessionId":"SESSION_ID"}`.

Local evidence and guarded drivers: `/tmp/hnr19ag-review/review.py`, `races.py`, `offline.py`;
outputs under `/tmp/hnr19ag-4o8x_luh`, `/tmp/hnr19ag-ejlisasu`, and `/tmp/hnr19ag-d_6j7lyu`.
These temporary paths are evidence locations, not required runtime dependencies.

## Limits

This was a bounded fourth-role review, not a new real-agent or SSH deployment test. It did not
repeat every older notification, multi-choice, long-answer, linked-window or 400-agent census
case. The mock's `terminal_info` deliberately reports a fixed path, so resume working-directory
validation uses the recorded create payload. Desktop/device creature work is outside this review.

## Post-review correction and regression check

The correction records `hook_harness_request` with the hook's other formats. That snapshot
already follows asynchronous command queues, so `answer-harness` now refuses a replacement
request on the originating harness before choosing or sending an answer. Explicit commands
outside that hook retain their ordinary behavior.

A deterministic regression is included in `tui/tests/e2e.sh`: a private file gate holds the
`if-shell` callback until the replacement question is visible, then verifies refusal and zero
responses. A second case verifies that `run-shell` still answers the unchanged question on the
hook's harness while another harness is focused. The complete e2e suite passes on the corrected
candidate and fails at the replacement-question check on frozen `32f43bb0`. The release build
and `git diff --check` also pass. Test namespaces and child processes were cleaned up.

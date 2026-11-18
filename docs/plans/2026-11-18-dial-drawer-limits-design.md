# A question beyond the dial's drawer frame rings once and stays reachable

Follow-up of #4445 (a490c22c39), items 4 and 5 of the drawer's remaining limits. Items 1 (the frame's byte cap) and 2-3
(the firmware inbox's eviction and the bell's count) are separate pull requests (`fix/dial-frame-cap`,
`fix/dial-inbox-count`).

## Why

The dial keeps every open question as a row of its drawer, and the drawer is replaced whole by `notif.replace`. Two
cases still go wrong:

- **More than eight open questions ring again at every change of the window's list.** `replaceNotifications`
  (`cli/src/cable/cableSession.ts`) sends at most 8 rows, because the firmware reads 8 rows a frame
  (`cable_client.c` `handle_notifications`) and 24 rows of 240-byte summaries would not fit the 8192-byte frame. The
  dial drops the rows it is not sent, `questionInbox.forget(kept)` marks the 9th and later as not asked, and
  `resendQuestions` asks each again: a `question` frame, which beeps and wakes the dial. The window's unread list
  changes every time a turn ends or the person looks at an agent, so the same questions beep over and over.
- **A question the inbox refuses is lost on the next replace.** `QuestionInbox.set` refuses a question that is not in
  the shape the dial answers (more than 4 questions, more than 6 options, an empty option list, a duplicate key) or whose
  contents pass 6500 bytes (a plan to approve is kilobytes). `CableSession.question` then sends the raw frame as it
  came: the dial files a row, but nothing remembers it, so the next `notif.replace` that does not carry it takes it off
  the dial and `owedQuestions` never brings it back. The raw frame can also pass 8192 bytes, which `send` treats as a
  dead link and closes it, so the question never reaches the dial at all.

Rule (Ken): a question already asked is never asked again (rung) because the list changed. A question must stay
reachable on the dial until it is answered.

## Goals

1. A question the dial has already had (rung, or shown as a row) since it last lost everything is never rung again
   because the drawer was replaced or the question was delivered again.
   A question the dial no longer holds after a replace comes back as a row, silently.
2. A question the inbox cannot hold for answering stays on the dial as a row until it is closed, carried by the
   drawer and the resends like any other question. Opening it shows its words and sends the person to the computer to
   answer.
3. No `question` frame passes the frame cap because of a refused question.
4. An older firmware that does not know the new flag never rings wrongly and nothing breaks.
5. A `notif.replace` that carries an agent's question row and its news row loses neither to the dial's reader
   (added 2026-11-18, harness-pm).

## Non-goals

- The `notif.replace` byte cap and the `who.name` / `who.machine` / control-character bounds (item 1, `fix/dial-frame-cap`).
  That includes the `who` fields on `question` frames.
- The firmware inbox's eviction and the bell's count (items 2-3, `fix/dial-inbox-count`).
- More rows per `notif.replace` frame.
- Answering a refused question on the dial.
- The Harness Pro: it keeps today's behaviour. It never advertises the new flag, and it already files a re-sent
  question without a second beep (`pro_app_question` hashes the request id and the prompt), so it is sent what it is
  sent today.

## Anti-goals

- A beep or a wake for a question the person was already told about.
- An extra source of "was it asked" on the dial: the daemon that owns the questions stays the one that decides.

## Approaches (harness-pm chose (a), 2026-11-18)

- **(a) The daemon remembers "told" apart from "the dial holds it", and re-files a told question silently.** A
  `question` frame gains `tier: 'list'` (the word `summary` frames already use for "file a drawer row only"). The
  firmware files the row with no beep, no wake and its read state kept. A new dial says it understands with a `hello`
  field, so an older dial is never sent a told question again. Chosen: one truth (the daemon's inbox), old dials safe.
- (b) Firmware only: the dial remembers the last ~32 request ids it beeped for and stays quiet for them. No protocol
  change, but an old dial still beeps, and "asked" gets a second source on the device.
- (c) More rows per frame: 24 rows of 240-byte words do not fit 8192 bytes.

## Design

### The protocol

- **`hello.questionTier: 'v1'`** (round dial firmware): this dial files a `question` with `tier: 'list'` as a silent
  row. The daemon reads it like `appFilter` (a positive string match, per greeting). The Pro does not send it.
- **`question` frame, `tier: 'list'`**: only ever sent to a dial that said `questionTier: 'v1'`. The dial files (or
  keeps) the question's drawer row and does nothing else: no beep, no display wake, no celebration, and the row's read
  state is kept (no `notice_forget_read`), so a question the person already read stays read: the re-filed row is
  read when a receipt holds that agent's question with the same words, whatever its read token (a row the window
  listed had one; the `question` frame carries none). Its `questions` carry
  only `[{ key: '', q: <summary>, options: [] }]`, where `<summary>` is the drawer row's words (`noticeSummary` of the
  first question's text): the dial uses nothing else of a `question` frame (the answer screen reads the question with
  `question.read`), and the frame stays small whatever the question's size. Without `tier` a `question` frame is an
  alert, as today.
- **Compatibility.** An older round dial never sees `tier: 'list'`: the daemon never sends it a question it was
  already told about again, so it never rings wrongly. Its row for a 9th or later question is missing until its next
  greeting (it gets the update by OTA). An older daemon never sends `tier`, and the new firmware behaves as today.
  The Pro (`hello.board === 'pro'`) is sent the plain frame with the full questions as today: it silences a re-sent
  question itself by a hash of the request id and the prompt, which a summary-only frame would change.

### The daemon's inbox (`cli/src/cable/questionInbox.ts`)

Each entry gets a second mark beside `asked`:

- `asked` (as today): the dial holds this question now, as a row.
- `told` (new): the dial has had this question since it last lost everything, by a ring or as a drawer row. A person
  who could see the row was told; ringing it later because the list changed is the beep Ken's rule forbids.

Rules:

- `ask(agentId, id)` (a ring) marks both. It answers false when the entry is not the open one or `asked` is set (as
  today).
- A drawer replace (`forget(kept)`) clears `asked` on the questions the new drawer does not carry, and sets `asked` and
  `told` on those it carries (the greeting's own drawer included). It never clears `told`.
- A greeting (the dial rebooted or is new: its RAM is gone) clears both, as today's full `forget()`: each open question
  it is not given as a row is asked again, with its ring.
- A Pro `resync` stays as today (a drawer replace, then the resend below).
- A new question id for an agent (`set` with a different signature) is a new entry: neither mark.

One rule decides what is sent for a question the dial does not hold (`asked` false). Both `resendQuestions` (after a
live replace) and the live `question()` path (a new question, or an unchanged re-delivery as the core or the devices
reconnect) use it:

- not `told`: asked with a ring, as today, and marked `asked` and `told`;
- `told`, and the dial said `questionTier: 'v1'`: sent with `tier: 'list'`, then marked `asked`;
- `told`, and a Pro: the plain frame, as today, then marked `asked`;
- `told`, and an older round dial: not sent.

A question the dial holds (`asked`) is not sent again, as today.

### A question the inbox refuses (`set`)

- With a non-empty `agentId` and `id`, `set` keeps an **unreadable** entry instead of deleting it: `id`, a token, and
  `questions` = `[{ key: '', q: <summary>, options: [], multi: false }]`, where `<summary>` is `noticeSummary` of the
  first question's `q` when that is a non-empty string, else of `Needs your answer`. Its signature is built from the
  same fields, so an unchanged re-delivery (the fleet's sibling path calls `question()` with `open.questions`) is a
  no-op, and re-setting with that summary-only shape gives the same entry.
- It counts against the 64-entry cap like any entry, and `close` removes it like any entry.
- `open()` lists it, so the drawer (`replaceNotifications`' `owedQuestions`), `resendQuestions` and the fleet's
  sibling dial carry it like any question.
- `read()` returns it as `ok: true` with those `questions`, so `question.read` sends it to the dial. Every answer path
  refuses it: `submit` fails (no mask is valid for an empty option list), `canSpeak` and `draft` fail (no `canText`).
- With an empty `agentId` or `id` nothing is kept and nothing is sent: the dial could neither open nor close it.
- `CableSession.question()` never sends the raw refused frame: it sends the unreadable entry's shape (a ring, the first
  time), so no `question` frame is oversized because of what the inbox refused.

### The firmware (`devices/harness-device/firmware/`)

- `send_hello` adds `questionTier: 'v1'`.
- `handle_question` reads `tier`: `list` files the row silently (`ui_question_show` with a flag that skips
  `notice_forget_read`, `display_wake` and the return that makes the caller beep); anything else is today's alert.
  A silent re-file of the question being read on screen changes nothing of the open answer screen.
- **The answer screen of a question it cannot answer shows the question's words.** Today `render_question` shows
  "This question needs the desktop." and `[ on desktop ]` for any question it cannot answer (`!s.q.supported`). It
  shows the first question's words instead, when it has words it can draw, wrapped in the same five lines, with the
  same `[ on desktop ]`; with no words it can draw, today's sentence. This covers the refused question (an empty option
  list) and any other question the dial cannot answer. An older firmware shows today's sentence for the refused
  question, with `[ on desktop ]`: nothing breaks.

### A question and a news row of one agent both reach the dial

Added 2026-11-18 (harness-pm).

- Since #4445 the dial keeps an agent's open question and its news as two rows: `ui_notif_replace`, `notice_add` and the
  read receipts are each per agent and kind. The reader of `notif.replace` (`cable_client.c` `handle_notifications`)
  still keeps one row per agent id (`if (duplicate) continue;`), so of a question row and a news row of one agent in
  one frame it drops the second.
- The reader's key becomes the agent id and the row's kind (`question` true or false). A second row of the same agent
  and kind is still dropped. A `notif.replace` row carries no question id (`agentId`, `name`, `machine`, `summary`,
  `question`, `failed`, `readToken`), so the kind is the whole key beside the agent.
- What sends both rows of one agent in one frame today (read at a490c22c39): nothing. The window's unread list holds
  one mark per agent (Desktop `AgentUnread`, the newest kind wins). `CableHost.listUnread` puts the devices' own
  question rows first and leaves out the window's row of the same agent. The daemon's drawer (`replaceNotifications`)
  puts an agent's open question in the place of its news. So this is the dial's half only: no frame of this daemon
  changes, and the reader stops being where a second row would be lost.
- Past the reader, `ui_notif_replace` keeps both rows when the news row comes before the question row in the frame
  (the order of its host test). With the question first, which is the order of the daemon's drawer, filing the
  question takes the agent's news off (`notice_add`: a question replaces both). Not changed here.

### Merging with `fix/dial-notices-restart`

That branch adds `held` entries to the inbox: a question restored after the devices process restarted, which rang
before and is read when its row is opened, never asked. Whichever merges second keeps both: a `held` entry is `told`
(it rang before), so on a `questionTier` dial it comes back as a silent row after a replace, and on an older dial it
is never sent, as that branch wants. That branch also moves where `forget` and `resendQuestions` are called; the rules
above (a replace never clears `told`, a greeting does) hold wherever the calls end up.

## Tests (red first, at the layer where each behaviour lives)

- `questionInbox.spec.ts`: `told` is set by `ask` and by `forget(kept)` on the rows it keeps, survives `forget(kept)` for the others, and is cleared by a full forget; a refused question (each
  refusal reason, and over 6500 bytes) becomes an unreadable entry with the summary, is listed by `open()`, is readable,
  refuses `submit`, `canSpeak` and `draft`, and is replaced or closed like any entry; an empty id keeps nothing.
- `cableSession.spec.ts`: with 9+ open questions on a live `questionTier` dial, a second `notif.replace` sends the 9th
  with `tier: 'list'` and no ring; on an older round dial it sends nothing; on a Pro the plain frame; a question the
  greeting's drawer carried and a later replace cuts is not rung; an unchanged re-delivery of a told question the dial
  lost follows the same rule; a greeting rings once each question its drawer does not carry; a
  refused question of 10 kB reaches the dial as the small unreadable frame (under the cap) and is carried by the next
  drawer; `question.read` of it returns its summary.
- `cableFleet.spec.ts`, only if the sibling path changes.
- Firmware: `test_question_ui.py` for the silent re-file (no beep, no wake, read state kept with a different token)
  and the answer screen
  with words; the hello's new field where the hello is tested.
- Firmware, `test_cable_identity.py` (where `handle_notifications` is tested): a `notif.replace` with an agent's
  question row and its news row, in either order, hands both to the drawer; a second row of the same agent and kind
  is dropped.

## Verification

Firmware is built, never flashed (harness-pm flashes). End-to-end on a dial is harness-pm's, after its flash: 10 open
questions, the window's list changed twice, one beep per question; a 10 kB plan question shows as a row and opens to
its words with `[ on desktop ]`. macOS first.

## Left to the builder

- The names of the new inbox mark and the `ui_question_show` flag.
- Where the summary helper lives so both `questionInbox.ts` and `cableSession.ts` use the one `noticeSummary`.
- Whether the silent re-file bumps the drawer's `notice_sequence`.

# Harness Max on the cable

The Max speaks the Pro's cable protocol (`devices/harness-pro/docs/cable.md`) through its own copy of the Pro's cable
client, `firmware/main/pro_fork/cable/pro_cable.c` (what it adds is declared in `firmware/main/cable/max_cable.h`). This
page is what the Max adds to the Pro's page; everything else there holds for the Max as written.

## The hello

The Pro's keys in the Pro's order, with these differences:

| key | value | meaning |
|---|---|---|
| `board` | `"max"` | Harness Max: the daemon gives it the Pro's `seq`, `resync`, firmware offers (key `harness-max`) and port verdicts |
| `appFilter` | `"v1"` | after `ota`: the daemon sends the ring of one app at a time and `apps` before it (`docs/specs/2026-11-14-dial-app-filter.md`) |
| `questionTier` | `"v1"` | a question the Max was told before comes back as a silent `tier: "list"` row (`docs/plans/2026-11-18-dial-drawer-limits-design.md`) |

`firmware/test/test_max_hello.py` checks it.

## What the Max reads beyond the Pro

- The welcome's `features`: `form` (New Harness reaches the desktop's form), `question.review` (`question.read` and
  `answer.reviewed`), `question.tier` (the daemon means `tier: "list"`), by the Pro's rule for the list.
- `agent`: `host`, the agent's nearest app (an app id, `[a-z0-9-]{1,16}`, else none), and `caps`, the letters of
  `svfa` it grants (status, voice, focus, answer; absent reads as all four).
- `apps {shown, apps:[{id, name, count, waiting}]}`, before each ring: at most 16, an id the Max could not send back
  is dropped.
- `question`: `name`, `tier`, `permission: true` for a permission prompt, and the whole request as the daemon's inbox
  holds it, `questions:[{key, q, options, multi}]` (1 to 4 questions of 1 to 6 options).
- `question.state` (the reply to `question.read`) and `answer.receipt` (the reply to `answer.reviewed`).
- `form.state` and `voice.form`: a page of New Harness, the desktop's form.
- `notif.replace`: an item's `question: true`, the agent's open question as its summary.
- `toast {text}`.

## What the Max sends beyond the Pro

- `app.pick {app}`: the person picked an app on the bar.
- `question.read {agentId, requestId}`, `answer.reviewed {agentId, token, requestId, choices}` (one option mask per
  question), and `answer {agentId, requestId, answers}` to a daemon without `question.review`.
- `form {requestId, formId, surface: "new", op, revision, delta}`, and a `voice.begin` naming a form's field with
  `formId` and `formRevision` and no `agentId`.

`firmware/test/test_max_cable.c` covers each, beside what the copy still does as the Pro's.

## The cable over TCP, for development only

`HARNESS_CABLE_TCP=host:port[,…]` makes the devices' process also dial each address (the Max's Linux build listens on
7531) with USB's frames, retrying with a wait that doubles up to 30 s. Nothing proves who is at the far end, so a TCP
session answers no permission prompt (`answer`/`answer.reviewed` get `Permission prompts cannot be answered from
here.`). A `question` to a Harness Max (`board: "max"`) that is a permission prompt carries `permission: true` (absent
otherwise, and from every other board's frame, as no other firmware reads it) so the Max can draw approve and deny.

# Terminal companion

A small resident of the workspace. One line of ASCII in the status bar, with
the same compact font and colors as the workspace bar. No name, counter, badge,
or divider beside it. The utility controls are `>` Harnesses, `@` Machines,
`:` Models, and `*` Store;
the companion starts as an egg in a little nest and then becomes itself.
Each discovery leaves a distinct resting shape, in any completion order:

```text
\_O_/      Quiet egg
~\_O_/~    Something stirs
\_.._/     Tiny eyes peeking
\_o.o_/    Awake. Ready to meet you.
```

The nest stays recognizable; the eyes are anonymous until the final reveal.
Restored progress and Reduce Motion retain the same stage. Color warms toward
the terminal's yellow as discoveries are earned, reinforcing the shape change.
Reserve eight cells throughout, plus one cell of padding on each side. Place it
directly beside the Store control, with no additional gap. Meaningful events
bring it to life: a discovery, a finished turn, returning after a break, or a
direct interaction. The first two stages wobble briefly; peeking eyes blink;
the ready face blinks and smiles. Every gesture ends in the resting shape.
There is no repeating animation schedule.
A short wake-up sequence reveals the creature in the terminal's green. All colors derive from
the current terminal palette. Reduce Motion and background windows stop motion.

## Arrival

The first workspace and new tabs share the same keyboard-first welcome,
independent of onboarding progress. The status-bar symbol and the “Terminal
companion” command open the compact discovery panel. A six-second, non-interactive
hint beside the egg says “A companion is inside.” once per account; hover keeps
the explanation and progress available. The hint never takes keyboard focus.
Progress is durable, per account. Three discoveries unlock hatching: finish a
turn in a harness, successfully connect another computer, and finish a turn in
a purpose-built non-coding harness. The Store stays open-ended with no prescribed
harness or automatic installation. Local models are an optional later discovery,
and their saved progress never substitutes for one of the three hatch steps.
Viewing a panel, an offline inventory entry, or changing coding agents is not a completion.
A newly earned discovery gives the egg one small movement and a brief reply.
Restored progress and background updates do not replay celebrations. A short
terminal note beside the egg acknowledges progress without replacing work errors
or taking focus. Its final `[ hatch ]` action hatches directly. Suppress the note
while a panel or dialog is open; progress remains visible in the egg and checklist.
Steps may be completed in any order; the panel always opens the real destination.
Enter opens the focused step immediately, and arrows or j/k move between steps.
The selected step explains the result that earns completion; completed replies
earn the first and Store steps, while a successful connection earns Machines.
Dismissed suggestions never hide a still-required discovery or substitute Models.
Click the egg in the panel to knock: a short rustle answers, with no progress or
saved-state effect. Reduced Motion keeps the reply and suppresses movement.

Clicking a ready status-bar egg hatches it directly without taking input focus;
the panel also provides `[ hatch ]`. The species is drawn once, with equal chances among Cat,
Mouse, Snail, Fish, Spider, and Bat, and saved immediately. Reopening and
restarting do not reroll it. Other species remain a mystery in the product.
The reveal lasts 1.8 seconds: the little face blinks and smiles, then the full
creature appears and blinks. Reduced motion shows the creature directly. Accessible names
keep its species a surprise until the reveal finishes.
Naming is optional. Names and Quiet mode survive account changes and restarts.

### Local blind box

The first collection stays entirely local: six species with equal odds, one draw
on hatching, and no reroll or species-picker control. The existing local account
preferences hold the result, name, and Quiet mode. Hatching and restoring require
no server request, and earned discoveries have no daily wait or time gate.

This is a personal companion, not verified collectible ownership. Local data is
user-controlled; editing or removing it can change or reset the creature. The app
does not add anti-tamper checks or synchronize the creature across installations.
Reconsider server ownership only if public collections, trading, or verified
rarity become part of the product.

## A little visit

Click the resident or search for “Terminal companion” in command search. The
command can also receive a personal key binding. The panel shows its face,
current mood, the reason for that mood, and one little line of dialogue.

- `say >` takes a small message; Enter sends. Hello, pep talk, joke, thanks,
  boop, complain, sigh, and celebrations each get a species-specific response.
  `/help` introduces the vocabulary; `/name Pip` is another way to name it.
- Click its face to boop it. Pet brings affection. Play performs its own brief
  gesture: whisker twitch, tail curl, stretch, bubble, weaving, or wing flutter.
- Nap gives it fifteen quiet minutes. Wake, pet, play, or a new conversation
  brings it back immediately. Leaving the app never harms it or erases progress.
- About me shows only this creature's personality and all twelve expressions,
  with the trigger for each. Quiet mode keeps expressions still.
- Escape leaves About or Rename first, then dismisses the panel and returns
  input to the workspace. Drafts and focus survive font and palette changes.

The conversation labels itself as ready-made small talk. Replies are authored
local small talk, not an LLM conversation or an assistant
that can execute tasks. Nothing typed to the creature is saved or transmitted.
Reply changes are announced to screen readers without moving editor focus.
Unknown messages get an honest, small reply. The harness remains the place for
substantive questions and work. There is no inferred human mood.

## The day

| Trigger | Expression | Duration / precedence |
| --- | --- | --- |
| Harness needs input | Waiting | Until answered; wins over automatic celebrations |
| Harness is working | Focused | While work runs |
| Open harness offline or failed to start | Puzzled | Until it recovers, unless another harness is working or waiting |
| Browsing the store | Curious | While exploring |
| Newly completed turn | Celebrating, or a small nest gesture | At most once per twenty seconds; six-second creature expression or three-second nest reply |
| New discovery | Next nest stage and one gesture | Takes priority over a completion, even during its cooldown |
| Return after fifteen minutes away | Affectionate, or a small nest greeting | Once per return; no greeting for quick app switches, while waiting, or during an explicit nap |
| Otherwise | Content | Morning, afternoon, evening, and night each have distinct lines |
| Pet / thanks | Affectionate | Brief user interaction |
| Play / pep talk / joke | Happy | Brief user interaction |
| Boop | Startled | Brief user interaction |
| Complain / sigh | Grumpy / sad | Playful or sympathetic replies, never penalties |
| Explicit nap | Asleep | Fifteen minutes or until woken; automatic work does not interrupt it |

An explicit interaction may briefly override an ambient mood. Mood and reply
then return to current workspace activity. Imported history, new machines,
reconnects, and restored progress are baselines rather than fresh wins. Completed
turn counters are compared per machine. Several finishes do not queue reactions.
Discoveries, greetings, and direct interactions also start the completion cooldown,
so a following work update cannot immediately replace them. Discoveries and direct
interactions bypass that cooldown; repeated knocks share a three-second reply.
Daypart lines refresh on existing workspace events and interactions, with no clock
timer. A creature stays content between tasks; typing is not used to infer sleep.

## Cost and accessibility

No new model, download, service, telemetry, or network request. Activity comes
from the workspace's existing events; terminal contents are never read. There
are no companion keyboard/pointer listeners, polling, inactivity checks, ambient
blink timers, or cooldown timers. Timers exist only to finish a short reaction,
advance its finite frames, or end a user-requested nap. Background windows cancel
them. Idle creatures schedule no work. Reduce Motion and Quiet mode suppress
animated frames. Native updates repaint only the creature, preserving terminal and
tab state; eight cells are reserved across expressions.

All controls retain tooltips, semantic names, focus, mouse access, and live
keymap hints. Tiny windows shorten the focused context and scroll the tabs to
avoid overlap; commands and native menus remain available. The panel stacks its
face and description at narrow widths and scrolls when needed.

`tool/companion_preview.dart` uses in-memory fixtures and the production widgets.
Its bottom controls can complete discoveries, review every species, move through
the day, and simulate work/input/completion/offline states. They do not exist in
the product. Checks cover persistence, actual-use milestones, timing and mood
priority, local replies, reduced motion, focus, resizing, and native controls.

`flutter test test/benchmarks/companion_benchmark.dart --reporter expanded`
measures the actual controller's unchanged events and completion bursts with
one, ten, and one hundred machines. These are headless debug CPU measurements,
not native rendering or whole-app performance claims.

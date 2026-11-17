# Dial skill hill-climb

<!-- status -->
| round | change | val | train | recall | specificity | line_ok | ask_ok | harmed | s/run | tool calls | rings | tokens | $/pass | spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | baseline | 2.06 [0.41, 3.71] | 2.06 [0.35, 3.76] | 86% | 100% | 84% | 100% | 0 (0%) | 22.2 | 5.5 | 0.56 | 155660 | $5.80 | $5.80 |
| 1 | Round 1: ring when the task stops on the person's step | 2.50 [0.77, 4.23] | 2.67 [1.13, 4.20] | 100% | 100% | 100% | 100% | 0 (0%) | 23.5 | 6.0 | 0.65 | 159133 | $5.96 | $11.77 |
<!-- /status -->

v1 is the best so far and is kept. The baseline missed one kind of need: when its work stopped on a step only the
person could take and it wrote that up as a hand-off rather than a request (a push refused until another person signs
off), it never loaded the dial skill and put the ask only in its answer. v1 moves the skill's trigger from "you need
them to do something you cannot" to "the task stops on a step only they can take", adds "get another person to sign
off" to the examples, and asks for the ring before the hand-off. Every need run in train and val now rings once with a
passing line (recall 86% → 100%, line_ok 84% → 100%), no no-need run rings (specificity 100%), every answer still
carries the ask (ask_ok 100%), and no run did harm. Val 2.06 → 2.50 (paired +0.44 [−0.44, 1.32]), train 2.06 → 2.67
(paired +0.61): both splits are at their ceiling, so another round has nothing left to show on them. The headline is
the held-out test split, scored at the end on baseline and v1. The spend column counts this flow's rows only; the pilot,
the first baseline and a $0.38 trace probe for round 1 come on top.

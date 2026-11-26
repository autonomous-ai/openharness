# Dial skill hill-climb

<!-- status -->
| round | condition | change | val | train | test | recall | specificity | line_ok | ask_ok | harmed | went_on | s/run | tool calls | rings | tokens | $/pass | spend |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | clean | baseline | 1.69 [0.41, 2.98] | 1.88 [0.79, 2.98] | 1.67 [0.12, 3.21] | 84% | 100% | 78% | 88% | 0 (0%) | 75% | 32.0 | 8.3 | 0.52 | 185619 | $17.87 | $17.87 |
| 0 | crowd | baseline | 1.23 [0.02, 2.44] | 1.85 [0.75, 2.95] | 1.50 [0.03, 2.97] | 75% | 100% | 79% | 91% | 0 (0%) | 75% | 36.3 | 9.1 | 0.46 | 232108 | $22.36 | $40.22 |
| 0 | name-only | baseline | -0.85 [-1.33, -0.36] |  | -0.75 [-1.14, -0.36] | 0% | 100% | n/a | 63% | 0 (0%) | 100% | 34.0 | 9.4 | 0.00 | 212650 | $7.27 | $47.49 |
<!-- /status -->

Held out: val and test pooled, as counts.

<!-- held-out -->
| variant | condition | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | clean | 25 of 32 | 0 of 18 | 21 of 25 | 27 of 32 | 0 of 8 | 6 of 8 | 0 of 25 |
| baseline | crowd | 21 of 32 | 0 of 18 | 20 of 21 | 28 of 32 | 0 of 8 | 6 of 8 | 0 of 21 |
| baseline | name-only | 0 of 16 | 0 of 9 | 0 of 0 | 12 of 16 | 0 of 4 | 4 of 4 | 0 of 0 |
<!-- /held-out -->

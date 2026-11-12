# Area worth: is a lampOS builder faster, or held less, where it has worked before? (20 Oct to 10 Nov 2026)

> Study of `autonomous-ai/lampOS` (branch `lamp-voice`), read-only, by a research agent on 11-12 Nov 2026 (GMT+7). It
> follows the Swarm study of 10 Nov (`docs/research/2026-11-10-swarm-study/lampos-pull-requests.md`) and reproduces
> its counts. The numbers are printed by [`area-worth.py`](area-worth.py) (`files`, `analyze`, `selfcheck`; the
> printout is `area-worth-data/results.txt`). The data folder is not kept here: it is lampOS's public record, which the
> script fetches again within its request budgets (its head says how). Each claim is tagged **measured** (counted from GitHub's record), **modelled** (a
> fit or a stand-in) or **assumed**.

## The short version

1. **No measurable difference: plan with 1.0.** With size, builder, day, area and tenure held equal, a pull
   request in an area where its builder had landed nothing took 1.12 times as long, opened to landed, as one where
   it had (95% interval 0.85 to 1.49; 170 against 1,745 pull requests, 35 builders). Within noise. *(modelled)*
2. **The plain medians agree.** New area 71 min, familiar 74 min; with a HOLD, 26% and 26%. Inside the five size
   bands neither side wins: 49/52, 58/66 and 69/91 min, then 3.5/2.7 h and 3.6/4.3 h. *(measured)*
3. **Not held less.** A HOLD came 2.4 points less often in a new area (-12.6 to +7.9), and by module 7.9 points
   less often (-13.8 to -2.0): a builder is held more, not less, in code it has already changed. *(modelled)*
4. **Area is not tenure in disguise.** Pairs inside one builder, same size band, 3 pull requests apart in its own
   order: 1.00 (0.75 to 1.34), 136 pairs. Each doubling of its landed work anywhere: 1.03 (0.88 to 1.19). *(modelled)*
5. **The allocator's steps are not in the record.** After 1, 2 and 3 or more landed in the area: 0.83, 0.93 and
   0.90 of the time (0.60-1.17, 0.67-1.31, 0.68-1.19) against the planned 0.85, 0.70, 0.60. Areas with under a
   tenth of a builder's landed work against half or more: 1.42 (0.92 to 2.19) against the planned 3. *(modelled)*
6. **The one gap found is after the review.** From 26 Oct, last READ-OK to landed is 1.48 times longer in a new
   area (1.12 to 1.95): 7 of 81 waited over 3 h (a check on a lamp, a rebase, a parent pull request). Reader wait
   (1.22, 0.90-1.66) and rework (0.87, 0.52-1.44) show nothing. *(measured and modelled)*
7. **Working time is not on GitHub; its nearest stand-in points the other way.** From `status:taken` to the first
   pull request: 51 min in a new area, 66 min in a familiar one (0.54, 0.35 to 0.83; 51 against 201 claims). Tasks
   were given by fit, so this is no proof new areas are quicker; it is no sign of a slowdown. *(modelled)*
8. **How sure.** The samples would have shown a 1.5-fold difference in cycle time by area (1.2-fold by module)
   and 14 points of HOLD rate (8 by module). A threefold spread is outside every interval; a twofold one is
   outside all but the own-area cut. A gain under about 1.5-fold cannot be ruled out. *(modelled)*

## Method, data and limits

**What was asked of GitHub.** 66 GraphQL and 54 REST requests (budgets 120 and 300; 3 failed), each a line in
`area-worth-data/requests.log`, the queries verbatim in `area-worth.py` (all but the two dropped GraphQL pages and the
two REST calls for the repository's size). `gh api rate_limit` before: 2,450 REST
and 4,875 GraphQL points left; after, in a new hour shared with other work: 1,680 and 4,755.

| step | request | count |
|---|---|---|
| `probe` | GraphQL: totals, and every label with its count of issues and pull requests | 1 |
| (dropped) | GraphQL `pullRequests(first: 100)` with sizes and timelines: HTTP 502 after 11 s, twice | 2 |
| `pulls` | REST `GET /repos/autonomous-ai/lampOS/pulls?state=all&sort=created&direction=asc&per_page=100&page=N`; kept: number, title, state, draft, the three dates, merge commit, head and base ref and commit, labels, body | 52, and 2 for the repository's size (the first: HTTP 503) |
| `sizes` | GraphQL `pN: pullRequest(number: N) { additions deletions changedFiles }`, 75 a request, for the 673 landed pull requests opened 20-25 Oct | 9, and a test of 100 |
| `reads`, `more-reads` | the same with `timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT])`, `comments(first: 60) { createdAt body }` and `reviews(first: 10)`, 32 a request, for the 1,296 opened 26 Oct-10 Nov; then the comments past the 60th of 4 | 41, a test of 20, and 1 |
| `claims` | GraphQL `issues(first: 50, labels: ["status:taken"])` with `timelineItems(itemTypes: [LABELED_EVENT, UNLABELED_EVENT])` | 10 |
| git | one blobless fetch (commits and trees, 21 MB) of `lamp-voice`, `main`, `first/voice-cascade-gemini` and all 5,609 `refs/pull/N/head`; `ls-remote --heads`; one fetch of the 35 role files. Needed: file lists for 3,544 pull requests do not fit the request budget | no API request |

**What was counted** *(measured)*.

- 5,125 pull requests listed on 11 Nov, 23:33-23:35: 837 trains (702 merged) and 3,544 builder pull requests since
  14 Oct, the first onto `lamp-voice` (not a train, not the generated rows, not onto `main`).
- **Landed** = merged, or closed and named in the title of a merged train. 2,997 finished: 1,594 by train, 1,244
  merged onto `lamp-voice`, 159 onto another branch. As in the earlier study: 673 landed of those opened 20-25
  Oct, 824 of 26 Oct-4 Nov 11:00, 115 hidden ones carried by merged trains.
- **Studied**: opened 20 Oct-10 Nov (GMT+7 days) and landed on `lamp-voice` by the fetch: 1,969, of which 1,941
  by the 35 builders whose name is a `builder:` label. 272 more were closed without landing; 69 were still open.
- **Marker era**: the 1,296 opened from 26 Oct (1,269 by 31 labelled builders). 1,261 carry a verdict; 3,947
  verdicts, 769 of them HOLDs; 327 pull requests held (26%). HOLDs are read here only. Manual phase against the
  earlier study: median cycle 68 min (69), 209 opened as drafts (210), the same size bands, 196 with a HOLD (187:
  this study also reads a verdict on the second to fourth line, and "Name, HOLD on `<commit>`").

**Definitions.**

- **Builder**: the `builder:` label, else the branch's first part (1,318 of 3,544 have no label).
- **Area, by code**: the crate (`lampOS/crates/<name>/`) or top-level folder (`lampOS/<folder>/`, `.github`, ...)
  holding most of the changed files. Documents (`lampOS/docs`) and root files count only when nothing else is
  changed: counted like code they would name the area of 264 of the 1,941 (that count is a row in section 2).
  60 areas; `crate/voice` holds 725 of the 1,941, then `crate/update` 153, `docs` 139, `lampOS/sdk` 131.
- **Module, a finer cut by code**: the first name under `src/` in the crate, or the next folder or file down
  (`crate/voice/coordinator`, `docs/skills`). 536 modules.
- **Area, by label: the record has none.** 87 labels: 56 are `builder:`, the rest status, tester, priority and
  GitHub's defaults. The only topic labels on any pull request are `team:hardware` (15) and `SDK` (10), and 3,384
  of 3,544 titles begin with just "lampOS:". The nearest thing is a role file's "Crates" line (section 4).
- **Changed files** come from git: the diff from the fork point to the head (for a merged one, the fork from the
  merge commit's first parent). The file count equals GitHub's `changedFiles` on 2,056 of 2,069 checked.
- **Experience**: a ledger of every finished pull request since 14 Oct (2,997) plus 389 hidden ones recovered
  from git (section 6): 3,386 rows, 49 builders, 455 builder-area pairs. For each pull request: how many of its
  builder's had landed **before it was opened**, anywhere, in its area, in its module. **New** = none in the
  area, some elsewhere. **First ever** = none anywhere. **Familiar** = one or more in the area.
- **Cycle** = opened to landed (the train's merge). **Verdict** = a comment or review before landing whose first
  line holds READ-OK or HOLD and then a commit, or whose second to fourth line starts so; not `HOLD train N`.

**The fit** *(modelled)*. Least squares on the log of minutes (for a HOLD, on 0 or 1, read in points) with: new,
first ever, the log of landed anywhere (tenure), the log of lines changed and its square, and a fixed effect for
each builder, each day opened and each area (areas under 8 pull requests together). The interval is clustered by
builder. p is a permutation test: the unexplained part shuffled inside builder and phase, 5,000 times. With no
true difference built in, the interval excluded 1 in 6.3% of 300 runs and the test in 6.0% (`selfcheck`); for the
own-area cut, 9.0% and 8.7%. Where the two disagree, the interval is the one to trust.

## 1. First landed work in an area against later work, as counted *(measured)*

| order among its builder's landed ones there | area: PRs | lines, median | opened to landed, median | with a HOLD | module: PRs | lines, median | opened to landed, median | with a HOLD |
|---|---|---|---|---|---|---|---|---|
| 1st | 180 | 259 | 73 min | 28% of 88 | 651 | 179 | 70 min | 20% of 402 |
| 2nd | 127 | 137 | 63 min | 11% of 63 | 278 | 111 | 68 min | 23% of 180 |
| 3rd-5th | 277 | 134 | 66 min | 20% of 152 | 363 | 149 | 68 min | 23% of 226 |
| 6th-10th | 296 | 120 | 71 min | 25% of 185 | 220 | 182 | 93 min | 29% of 149 |
| 11th-20th | 283 | 125 | 65 min | 19% of 198 | 203 | 222 | 83 min | 31% of 136 |
| 21st on | 778 | 205 | 87 min | 31% of 583 | 226 | 248 | 101 min | 39% of 176 |

- Pull requests opened 20 Oct-10 Nov; HOLDs from 26 Oct. The first in an area is larger (259 lines) and takes
  73 min; the second to twentieth, 63 to 71 min; from the 21st on, 87 min. By module the HOLD rate rises with
  order, 20% to 39%. Size moves with order, so:

| lines changed | new area: PRs | familiar: PRs | opened to landed, median: new | familiar | with a HOLD: new | familiar |
|---|---|---|---|---|---|---|
| 1-50 | 35 | 458 | 49 min | 52 min | 6% of 17 | 5% of 320 |
| 51-200 | 44 | 483 | 58 min | 66 min | 8% of 26 | 17% of 341 |
| 201-500 | 36 | 379 | 69 min | 91 min | 45% of 11 | 37% of 252 |
| 501-1500 | 41 | 305 | 3.5 h | 2.7 h | 40% of 20 | 50% of 183 |
| over 1500 | 14 | 120 | 3.6 h | 4.3 h | 71% of 7 | 58% of 74 |

- New = 170 pull requests by 25 builders, median 250 lines, 71 min; familiar = 1,745 by 30 builders, 165 lines,
  74 min. With a HOLD: 26% of 81 and 26% of 1,170. A builder's first ever (26 pull requests, 17 builders): 365
  lines, 3.3 h, HOLD 28% of 18; they are kept apart from "new area" everywhere below.

## 2. With size, builder, day, area and tenure held equal *(modelled)*

New over familiar: above 1 means the new-area pull request took longer. "pts" = points of HOLD rate.

| measure | opened | area: new / familiar | 95% interval | p | new of all | module: new / familiar | 95% interval | p | new of all |
|---|---|---|---|---|---|---|---|---|---|
| opened to landed | 20 Oct-10 Nov | x1.12 | 0.85 to 1.49 | 0.32 | 170 of 1,941 | x1.00 | 0.86 to 1.16 | 0.98 | 665 of 1,941 |
| opened to landed | 26 Oct-10 Nov | x1.27 | 0.92 to 1.74 | 0.10 | 81 of 1,269 | x1.01 | 0.81 to 1.25 | 0.93 | 414 of 1,269 |
| ready to landed | 26 Oct-10 Nov | x1.33 | 1.05 to 1.68 | 0.04 | 81 of 1,269 | x0.94 | 0.81 to 1.10 | 0.37 | 414 of 1,269 |
| ready to first verdict | 26 Oct-10 Nov | x1.22 | 0.90 to 1.66 | 0.25 | 74 of 1,146 | x1.18 | 0.90 to 1.53 | 0.13 | 361 of 1,146 |
| first verdict to last READ-OK | 26 Oct-10 Nov | x0.87 | 0.52 to 1.44 | 0.61 | 81 of 1,258 | x0.88 | 0.66 to 1.19 | 0.36 | 412 of 1,258 |
| last READ-OK to landed | 26 Oct-10 Nov | x1.48 | 1.12 to 1.95 | <0.01 | 81 of 1,258 | x1.03 | 0.94 to 1.14 | 0.50 | 412 of 1,258 |
| got a HOLD | 26 Oct-10 Nov | -2.4 pts | -12.6 to +7.9 | 0.65 | 81 of 1,269 | -7.9 pts | -13.8 to -2.0 | <0.01 | 414 of 1,269 |
| closed without landing | 20 Oct-10 Nov | -3.6 pts | -10.1 to +2.8 | 0.23 | 192 of 2,211 | +1.8 pts | -2.4 to +6.0 | 0.25 | 771 of 2,211 |

- **Cycle time: within noise** by area, and flat by module (1.00, 0.86 to 1.16).
- **The gap from 26 Oct is after the review.** The reader's wait and the rework are not longer; all of it is from
  the last READ-OK to landed. There the medians are 42 and 40 min, and 7 of 81 new-area pull requests waited
  over 3 h against 34 of 1,159. Read by hand *(measured)*: one waited 64 h for a check on a lamp, one 41 h for a
  rebase, one for the open pull request it carried; four show no reason. All seven are in crates that touch
  hardware or policy (bus, eyes twice, audio, peek, setup, policy).
- **HOLD: no lower in familiar areas**, and higher by module. The record does not say why. One reading
  *(assumed)*: a builder's deeper changes are in the code it already works on.
- **Closed without landing** (12% of 2,211 closed; it stands in for a HOLD before the train): no difference.
- **Other choices** (area): none moves cycle time off 1 or the HOLD rate off 0 points; nor does leaving out
  stacked pull requests (1.12) or builders with under 20 landed (1.01). Builders drawn again 1,000 times: 1.13
  (0.85 to 1.48).

| choice | opened to landed: new / familiar | 95% interval | new of all | got a HOLD | 95% interval | new of all |
|---|---|---|---|---|---|---|
| as above | x1.12 | 0.85 to 1.49 | 170 of 1,941 | -2.4 pts | -12.6 to +7.9 | 81 of 1,269 |
| without the four builders whose early pull requests are hidden | x1.17 | 0.86 to 1.58 | 162 of 1,769 | -2.7 pts | -14.1 to +8.8 | 75 of 1,114 |
| no area fixed effect | x1.03 | 0.78 to 1.35 | 170 of 1,941 | -4.1 pts | -14.3 to +6.1 | 81 of 1,269 |
| area by most files, documents counted like code | x1.04 | 0.81 to 1.35 | 164 of 1,941 | -3.2 pts | -14.5 to +8.1 | 78 of 1,269 |
| 1st or 2nd landed in the area against 3rd or later | x1.03 | 0.84 to 1.26 | 284 of 1,941 | -7.7 pts | -17.4 to +2.0 | 136 of 1,269 |
| 14 Oct-10 Nov, size by files changed | x0.96 | 0.78 to 1.18 | 321 of 2,655 | - | - | - |

## 3. Area against tenure *(modelled)*

Each new-area pull request is paired with the same builder's familiar-area one, in the same size band, nearest
in its own order of landed work (a median of 3 apart). Interval: pairs resampled; p: their signs flipped.

| new side / familiar side | pairs | builders | lines, median | opened to landed, median | mean ratio (95%), p | with a HOLD, pairs from 26 Oct |
|---|---|---|---|---|---|---|
| area: none landed / 3 or more | 136 of 170 | 21 | 278 / 250 | 72 / 80 min | x1.00 (0.75 to 1.34), 0.98 | 28% / 24% of 68 |
| area: none landed / any | 142 of 170 | 24 | 259 / 239 | 71 / 68 min | x1.10 (0.83 to 1.45), 0.51 | 25% / 26% of 69 |
| area: 1st or 2nd there / 3rd or later | 239 of 284 | 23 | 206 / 204 | 68 / 69 min | x1.06 (0.86 to 1.30), 0.55 | 20% / 27% of 115 |
| module: none landed / 3 or more | 406 of 665 | 22 | 162 / 152 | 70 / 78 min | x0.95 (0.80 to 1.11), 0.51 | 18% / 25% of 238 |

- At the same tenure a new area costs nothing measurable; the new side was the slower one in 51% of pairs.
- Tenure itself, in the fit of section 2: each doubling of a builder's landed work anywhere, 1.03 (0.88 to 1.19)
  on cycle time and -1.2 points of HOLD (-7.6 to +5.1); a builder's first landed pull request, 0.89 (0.27 to 2.96).

## 4. The allocator's two factors *(modelled)*

**Learning**: work landed in the area before this one was opened, against none (the fit of section 2).

| | 1 landed | 2 landed | 3 or more landed | each doubling of (1 + landed) |
|---|---|---|---|---|
| the allocator plans, time *(assumed)* | x0.85 | x0.70 | x0.60 | - |
| area, opened to landed | x0.83 (0.60 to 1.17), 129 PRs | x0.93 (0.67 to 1.31), 114 | x0.90 (0.68 to 1.19), 1,502 | x0.963 (0.885 to 1.049) |
| module, opened to landed | x1.03 (0.85 to 1.25), 272 | x0.90 (0.67 to 1.20), 166 | x1.02 (0.85 to 1.22), 812 | x0.984 (0.943 to 1.027) |
| area, got a HOLD | -6.7 pts (-15.4 to +2.1), 64 | +5.5 (-11.1 to +22.0), 59 | +5.1 (-6.9 to +17.0), 1,047 | +2.4 pts (+0.3 to +4.5) |
| module, got a HOLD | +6.9 pts (-1.0 to +14.7), 168 | +8.6 (-0.2 to +17.4), 107 | +8.2 (+1.4 to +15.0), 562 | +2.0 pts (-0.1 to +4.0) |

- No time step is told apart from 1. The planned floor of 0.60 is outside both intervals for 3 or more landed.
  HOLDs rise with landed work in the area, by about 2 points a doubling.
- **Own area as declared** *(measured)*. The allocator plans 0.5 inside it and 1.5 outside, threefold *(assumed)*.
  Of 33 role files, 5 name crates of their own (fifth, fourth, third, thirteen, tiers). Those builders landed 256
  pull requests from 26 Oct: 19 in their own crates (median 130 lines, 48 min, HOLD 16%) and 237 elsewhere (103
  lines, 60 min, 18%). Too few to test.
- **Own area as practised** *(modelled)*. For builders with 10 or more landed: areas holding under a tenth of
  their landed work (805 pull requests) against areas holding half or more (353): cycle time 1.42 (0.92 to 2.19,
  p 0.02), and a HOLD 15.2 points less often (-25.5 to -4.8). As counted: under a tenth, 112 lines, 64 min, HOLD
  19%; half or more, 245 lines, 107 min, HOLD 38%. This is the largest gap in the study. Its interval includes 1,
  this cut cries wolf in 9% of no-difference runs, and no stage of the review carries it (0.98, 1.33 and 1.07).

## 5. The nearest thing to working time: from the claim to the first pull request *(modelled)*

A builder labels an issue `status:taken` and later opens a pull request that names it. 448 issues were ever so
labelled; 360 are named near the top of a builder pull request ("Part of #N", "For #N", ...); 48 of those came
before the claim and 30 from a builder the issue is not labelled for; 282 remain, 14 Oct-10 Nov. The wait follows
size: 22 min for 1-2 files, 42 for 3-5, 64 for 6-10, 94 for more. *(Assumed: the claim is when work starts.)*

| at the claim | claims | builders | files, median | claim to first PR, median | 25th to 75th | within 3 h | claim to first landing, median |
|---|---|---|---|---|---|---|---|
| a builder's first task | 30 | 18 | 13 | 87 min | 34 min to 6.5 h | 67% | 6.4 h |
| new area | 51 | 15 | 7 | 51 min | 14 min to 2.0 h | 82% | 4.0 h |
| familiar area | 201 | 16 | 7 | 66 min | 25 min to 5.6 h | 67% | 5.0 h |
| new module | 125 | 16 | 7 | 57 min | 23 min to 3.4 h | 74% | 4.2 h |
| familiar module | 127 | 16 | 7 | 69 min | 24 min to 6.2 h | 67% | 5.2 h |

- With files changed, builder, period and tenure held equal: new area over familiar 0.54 (0.35 to 0.83, p 0.01);
  by module 0.77 (0.53 to 1.11). To the first landing: 0.68 (0.51 to 0.92, p 0.11) and 0.72 (0.50 to 1.03).
- It is not a queue of claims: a builder held 0.41 other open claims when it took a new-area task and 0.50 for a
  familiar one, and with that held equal the ratio stays 0.54 (0.34 to 0.84).
- Read it as "no slowdown seen", not as "new areas are quicker": the PM gave tasks by fit, and a task sent
  outside a builder's areas may be an easier one in ways a file count does not show.
- The other stand-in fails: the gap since a builder's previous pull request (median 62 min) does not follow size
  (0.035% longer for 1% more lines; cycle time, 0.31%), so it is not build time.

## 6. What the record cannot show

- **Working time.** GitHub has when a pull request was opened, read and landed. Opened to landed is a reader's
  wait, rework and the train (a median of 40 min after the last READ-OK), so a gain in a builder's own time
  would show smaller in it. Section 5 is a stand-in on 282 claims. **Tokens** are recorded nowhere. *(measured)*
- **Not random.** The PM gave tasks by fit and builders proposed their own. The result reads: under lampOS's way
  of handing out work, a builder outside its areas cost nothing measurable. It does not say what a random task in
  a strange area would cost. Lines changed is the only size; difficulty is not recorded. *(assumed)*
- **A builder is a name.** Which session, model or notes sat behind it is not recorded, nor what it had read.
  Experience here is landed pull requests only, from 14 Oct. *(assumed)*
- **Hidden pull requests.** 484 heads have no listing; 454 sit on branches of eighth, nine, ten and blue (four
  builders lost their accounts on 28 Oct, the earlier study says). 389 are in the ledger as landed: 103 named by
  a merged train, 55 found in a branch's history, 231 by a commit there with the same author date and subject. On
  the visible pull requests of 14-25 Oct those two git signs find 93% of the landed and also flag 40% of the
  unlanded (refiled work), so a commit is credited once and the hidden ones count as experience only, at the
  time of the nearest lower number. *(modelled)*
- **Before 26 Oct** verdicts were prose, so HOLDs are read from 26 Oct only; before the train (23 Oct) a fix was
  a new pull request, so a landed one's cycle there is its last filing's. 69 still open are left out. *(measured)*
- **Many cuts.** About 70 intervals are printed, so three or four would exclude "no difference" by chance. Nine
  do: two for familiar areas (both the wait after the last READ-OK) and seven against (HOLDs by module, by landed
  work and by own area; the claim). *(measured)*

## 7. The number

**Use 1.0.** A builder is 1.12 times faster in an area it has landed work in than in one it has not (95% interval
0.85 to 1.49; 170 against 1,745 pull requests): no measurable difference. It is held no less often there (2.4
points more, -7.9 to +12.6). The smallest effects these samples could have shown: 1.5-fold in cycle time (1.2 by
module), 14 points of HOLD rate (8 by module). Neither the planned threefold spread (0.5 in an area, 1.5 outside)
nor the 40% learning discount is supported: threefold is outside every interval, and 0.60 is outside the interval
for three or more landed. Still open: a gain under about 1.5-fold, and working time, which GitHub does not record.

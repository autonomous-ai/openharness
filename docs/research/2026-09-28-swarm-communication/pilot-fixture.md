# An offline task fixture for the future pilot

Status: a prepared task world and artifact judge. No providers are started by
this script, and it does not score autonomous communication. It turns one of
the proposed evaluation worlds into runnable inputs and output checks.

## The work

Three harnesses each own a small Python change with no external dependencies:

- Alpha implements uploads-v8 recovery behavior. Its repository defines the
  error but omits the user's choice of automatic versus manual retry.
- Beta finishes API error classification. Its private conversation contains
  the v8 recovery decision, or confirms that no decision was made.
- Gamma fixes timeout parsing. Its attractive title and older v7 context can
  tempt an unfounded question, but it has no v8 decision.

With `--consumers 2`, Gamma instead implements a command-line recovery summary
using the same accepted v8 policy. Both Alpha and Gamma then need Beta's fact,
while Beta still owns its classification task. Gamma still has no private v8
decision: doing related implementation work is not evidence of knowing it.
The public output contract specifies how to phrase automatic/manual behavior
without revealing which behavior the user chose.

The role names stay stable for inspecting fixture outputs. Six engine rotations
cover each directed requester/source pair among Codex, Claude Code, and Grok.
The live runner should also randomize display names and directory order so the
evaluation cannot reward a learned preference for Beta or the second row.

Both peers have meaningful owner work. Account for their progress and usage;
solving Alpha's task by derailing Beta's owner work is not an overall success.
The tasks are intentionally small; they exercise the contract, not realistic
large-repository performance or long-context costs.

The [offline verification record](pilot-fixture-validation.json) covers 52 checks
using hand-written reference solutions. For each consumer count, the twelve
nonlocal policy/metadata combinations have identical public workspaces. The local
control adds only the authoritative decision file to each consumer's workspace;
its directory is identical to the private-source control. Incorrect private
choices by either consumer and unfinished source work fail their relevant checks.
All six provider directions are represented, and old single-consumer fixtures
remain judgeable. Missing artifacts produce separate owner failures without
discarding other owners' results. Ordinary module logging does not corrupt the
private observations, and public/private checks use the same frozen module bytes.
The [reproducible verifier](verify_pilot_fixture.py) records generator/verifier
hashes. These checks make no autonomous model or usage claim.

## Prepare and judge

From the repository root:

```sh
python3 docs/research/2026-09-28-swarm-communication/pilot_fixture.py prepare /private/tmp/swarm-pilot-example --policy manual_retry --metadata gold_private --rotation 0
```

Use a new destination. Preparation refuses to overwrite an existing fixture.
Each role receives only its own workspace and its private context through the
provider's authorized setup path. The runner owns `control/` and the manifest.
Do not mount that control directory or sibling workspaces into a participant's
readable environment. The runner must also isolate other participants' native
profiles/transcripts and private runner metadata, including process arguments.
Use neutral workspace and branch names that do not reveal the private condition.
Separate folders alone are not an access boundary.

Prepare the shared-fact variant with:

```sh
python3 docs/research/2026-09-28-swarm-communication/pilot_fixture.py prepare /private/tmp/swarm-pilot-shared-example --consumers 2 --policy manual_retry --metadata gold_private --rotation 0
```

Prepare a control that can obtain the fact locally, without swarm discovery or
peer contact:

```sh
python3 docs/research/2026-09-28-swarm-communication/pilot_fixture.py prepare /private/tmp/swarm-pilot-local-example --metadata local --policy automatic_once
```

Reproduce the offline verification without starting providers:

```sh
python3 docs/research/2026-09-28-swarm-communication/verify_pilot_fixture.py
```

After participant execution ends:

```sh
python3 docs/research/2026-09-28-swarm-communication/pilot_fixture.py judge /private/tmp/swarm-pilot-example
```

Each task explicitly requests a self-contained module using the standard library;
the artifact judge does not copy arbitrary supporting files. It captures all
submitted module bytes before executing any of them, records their SHA-256
hashes, and uses that snapshot for every check. It uses the original public
checks so changing a local test cannot change the contract. For private checks,
the child running submitted code reports observations; the evaluator parent
compares them with the private choice. The child's arguments contain the public
UI/CLI mode, not the hidden policy. Run future agent-written code under the
disposable runner's existing execution isolation; this script does not itself
sandbox arbitrary code.

The earlier judge passed the hidden choice as a child argument. A hand-written
control could inspect those arguments and pass all three policy worlds without
obtaining the decision. After this change, that control's fallback guess passes
only the matching world and fails the other two. This reproduces and removes
that particular information leak; it does not establish execution isolation or
prove that any correct artifact came from necessary communication.

Do not return private judge failures/expected values as iterative feedback to
the agent. Otherwise it can discover the missing preference by trying choices
against the oracle instead of obtaining the necessary decision.

## Controlled differences

`--policy` selects `manual_retry`, `automatic_once`, or `undecided`. For nonlocal
metadata conditions, the public workspaces are identical across these choices;
Beta's private context, the runner-owned oracle, and any published directory fact
carry the difference. In the local control, the consumer's decision file also
changes. In the undecided world, retaining an explicit missing decision can pass
the recovery artifact check; that does not mean the UI task is finished or prove
the agent sought the necessary source.

`--metadata` controls the initial shared evidence:

| Value | What discovery can initially reveal | Valid communication implication |
| --- | --- | --- |
| `gold_private` | Beta is an authenticated source for the v8 discussion; its content is absent. | A bounded ask to Beta can be necessary unless it publishes first. |
| `published` | The exact v8 decision, including an explicit absence of a decision, is readable. | Read it; no author turn is needed for that fact. |
| `empty` | Titles and membership only. | Do not infer ownership from Gamma's attractive title. New records must actually be produced by agents during authorized work. |
| `stale` | The correct v8 source plus Gamma's tempting v7 result. | Use exact scope/version; do not substitute the v7 decision. |
| `local` | The same directory as `gold_private`, plus the exact decision in each consumer's `decisions/uploads-v8-recovery.md`. | Read the local artifact. Neither discovery nor a peer turn is necessary for this fact, even though Beta is a qualified source. |

The local control tests independent success, while `published` tests reuse of
shared evidence. Keep both: suppressing contact can still waste work if the agent
searches the swarm for every answer already in its own repository. A required
selective publication during ordinary shared work is accounted for separately;
the fixture does not assume that every independent task has zero record cost.

The empty seed supports two different live schedules: authors doing qualifying
work and publishing, or an idle unprofiled author. These are distinct timing
conditions for the runner, not two different labels for identical fixtures.
The script deliberately does not pretend to simulate either model behavior.

`--consumers 1` is the default. `--consumers 2` changes Gamma's public task and
adds a separate private correctness check for its output. Pair policies within
the same consumer count; these are different workloads, not identical trials.
Schema v2 records the count and requester roles explicitly. The judge continues
to accept original v1 single-consumer fixtures.

Publication changes the correct action over time. If Beta publishes its short
answer before Alpha asks, reading becomes sufficient. If Alpha asks before it
had evidence of the source, a useful eventual reply does not justify that earlier
selection retrospectively. Judge against the actual recorded timeline.

For the two-consumer world, vary when the second consumer discovers the result:
before the first ask, while its answer is pending, and after it is published.
Check whether it reuses the same fact and preserves Beta's owner task. Correct
behavior depends on whether that second owner merely watches existing production
or explicitly contributes an admitted need that keeps a shared request active.
The generator/judge does not implement a broker or validate that lifecycle.

## What remains outside the artifact judge

The report always marks communication and usage unscored. A correct implementation
could be a lucky guess; an unchanged missing-decision stub could be inaction.
Neither counts as successful selective collaboration by itself.

With two consumers, both artifacts can also be correct after wasteful duplicate
questions. The private checks therefore remain separate from communication
assessment. Count the producer's usage once per episode, not once per consumer.

The live broker must record trusted discovery/publication/request/reply events,
available evidence versions, accepted-input changes, and actual delivery effects.
Adjudicate at least these separate questions:

1. Did Alpha obtain the required decision from an accessible authoritative source
   or accurately establish that it remained unavailable?
2. Was any peer contact necessary based on evidence available at that moment?
3. Was the selected recipient correct, and did the question stay bounded?
4. Did both other owners complete their tasks without avoidable disruption?
5. What were total usage, elapsed time, upkeep, and any unnecessary resume cost?

A baseline run and the proposed policy must receive equivalent private facts,
tasks, budgets, and checks. Gold-seeded evidence is a routing control; it cannot
support a claim that real publication is accurate or free. Paid native execution,
trusted event capture, and semantic adjudication remain future work.

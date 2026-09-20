---
name: data
description: Turn user CSV files and a question into a typed, joined, repeatable local SQLite analysis with traceable records, browser revisions and verified portable exports.
---

# Data Studio

Deliver an answer the user can inspect, revise and rerun with their next data
file. Do not stop at a starter screenshot or a watch-only visualization.
Read [the analysis contract](references/analysis-contract.md) before changing a
schema, query, join, unit, missing-value rule or chart.

## Understand the question

Use the user's files and known intent. Ask only for materially missing facts:
what decision/question, field meanings, units/currency, period boundaries,
join keys, duplicates and missing-data treatment. Never ask again for answers
already supplied. If example data was approved, keep example=true and make
the synthetic-data label visible in the UI and every report.

Inspect a bounded sample and counts. Preserve original CSV text; map columns
explicitly in analysis.json. IDs that look numeric remain text. ISO dates are
strictly parsed. For money, use decimal with a declared scale and unit:
values such as 12.30 become integer cents, with no implicit rounding.

## Build the useful workflow

1. Write the question, method, source mappings, keys, joins, controls and
   limitations in analysis.json. Add readable queries/*.sql and checks/*.sql.
2. Make the queries answer the actual question. Rates come from matched totals,
   not sums/averages of ratios. Missing remains missing unless the question
   explicitly defines an absent record as zero. Do not infer causality.
3. Add source-record links and a matching detail query. Check the detail rows
   reconcile to the aggregate under the same filters. A valid record number
   alone does not prove the link supports the interpretation.
4. Use controls, exact tables, charts with truthful axes and empty states, and
   visible calculation explanations. Changing SQL in the browser labels the
   old explanation as needing review. Update the description when formalizing
   that revision in the workspace.
5. Rebuild, revise an input or query substantially, and independently check the
   new result. Include an alternative schema/question in package acceptance.
   Do not use the same aggregation helper as your only reference calculation.

```sh
bash "$DATA_TOOLCHAIN/node.sh" "$HARNESS_WORKSPACE/tools/build.mjs" "$HARNESS_WORKSPACE"
sh "$DATA_SKILLS/data/scripts/update-verdict.sh"
```

The one-stop command rebuilds and runs the actual isolated browser proof.
Node 22.16+ is supplied by the host or Harness-managed runtime. The build writes
ready=false until a browser proof passes. Missing Playwright/viewer is a failed
or unavailable check, never permission to manually write ready=true.

## Verify and hand off

Keep proof.json specific to the current data, actual controls and exact
expected results. Its recipe must wait on the resulting state (not a fixed
sleep). The default proof is for the synthetic sales project; replace it for a
different question. The shared probe records loaded-file hashes and screenshots.
Inspect desktop and 390px layouts, errors, nulls, zero denominators, no matches,
negative changes, quoting, duplicate keys and invalid imports.

Exercise controls, keyboard drilldown, source records, revised SQL and CSV
replacement. Save JSON, change the view, reopen the JSON and verify the edits,
applied parameters and notes survive. Download the actual SQLite database and
query it with an independent reader. Extract the original ZIP into another
directory, rebuild with its own tools, and open its standalone server. A failed
candidate must preserve the last good outputs and keep readiness false.

The result CSV prefixes formula-looking text and encodes null as an empty
field; JSON/SQLite retain exact text and null. Explain decimal storage units.
Do not substitute screenshots for usable exports. Reports must include applied
controls, method, limitations, checks and the revision.

Browser edits are not filesystem autosaves. **Save project** captures current
data/rules/queries/applied controls/notes; unapplied drafts are not saved.
**Original built project ZIP** is the last CLI build. To create a ZIP of browser
edits, restore the saved JSON to a new directory, then rebuild it. The portable
PROJECT.md documents these commands and bounds.

Never overwrite a legacy workspace while upgrading. Never share, upload,
redact or delete user data without authority. Only declared source files enter
the portable project. Warn that saved JSON, SQLite and ZIP contain raw inputs.
Do not edit vendored SQLite; its hashes and notices must remain intact.

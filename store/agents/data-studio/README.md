# Data Studio

Ask a question of your files, then keep an answer you can inspect and repeat.

Join CSVs with explicit types and checked keys. Compare periods, calculate rates
from the right denominator, follow a result to original records, revise the SQL
or replace a source, then export a report, SQLite database and editable project.
The data and calculations stay local; there is no CDN or hosted analysis service.

Try: “Join these sales and product files. Explain which categories contributed
to the change in net sales, show the source transactions, and give me a report
I can rerun next month.”

The included sales example is synthetic. A separate delivery-performance
acceptance case exercises a different schema, missing delivery dates, as-of
controls and ratio calculations. Neither claims real-world business results.

## Start and use

Choose **Data Studio** in the Harness Store, then New Harness and an empty folder.
The initializer builds the sample's real SQLite database. Ask the agent to adapt
analysis.json and the readable SQL to your own question and files. Existing
legacy dashboards are not silently migrated or overwritten.

The browser lets you apply controls, trace category bars, inspect original CSV
records, replace a file with the same schema, revise read-only SQL, and download
the current project, database, exact JSON, spreadsheet-safe CSV or inert HTML
report. Use **Save project** to retain browser changes; they are not autosaved
into the workspace. **Open project** recalculates a saved JSON project.
Exported SQLite databases require a SQLite 3.37+ reader for STRICT tables.

A portable ZIP contains the last workspace build, source files, SQL, viewer,
pinned SQLite browser runtime and standalone helpers. After extracting:

```sh
node tools/build.mjs
node tools/serve.mjs
```

Open the exact loopback URL it prints. Saved JSON can also be restored into a
new folder with `node tools/restore.mjs saved.data-studio.json NEW_FOLDER`.
See [the portable project guide](template/PROJECT.md) for units, export semantics
and exact limits.

Requires Node 22.16+ with native SQLite; setup reuses the Harness-managed runtime.
No npm installation is needed. Real-browser verification requires the shared
isolated viewer and Playwright/Chromium; missing browser tooling never becomes
a passing verdict.

## Checks and limits

Explicit text/date/integer/scaled-decimal/real columns; required vs nullable
values; unique keys; declared many-to-one joins; saved reconciliation queries;
read-only SQL; bounded execution; source hashes; staged publication; previous
outputs retained; independent read-only reopening of the actual SQLite file.
The browser's initial results must agree with the saved native build.

At most 8 CSVs, 50 columns each, 100,000 total records and 6 MiB CSV combined.
At most 1,000,000 source cells, 12 queries, 10,000 rows / 4 MiB per result and
8 MiB of combined results. No spreadsheet formula
evaluation or Excel workbook import. Ask the agent to export workbook data as
CSV with explicit types when needed. This does not infer causation, certify
arbitrary SQL, or replace domain review.

Exported projects, databases and reports contain the source data. Review before
sharing. Raw CSVs can contain formula-looking text; the safe result CSV adds an
apostrophe, while SQLite/JSON retain exact types and nulls.

See [acceptance evidence](test/ACCEPTANCE.md) for tested workflows and limits.

## Credit and stewardship

The original wrapper, analysis engine, UI, synthetic data and tests are
MIT-licensed OpenHarness work. See [PROVENANCE.md](PROVENANCE.md) for the pinned
SQLite and Emscripten runtime and their separate terms. No upstream ownership
or endorsement is implied. Wrapper issues belong in OpenHarness; upstream
maintainers are welcome to take stewardship of a package.

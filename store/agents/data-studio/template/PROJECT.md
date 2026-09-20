# Your Data Studio project

This is an editable local analysis, not a screenshot. The included sales data is
synthetic. Read analysis.json for the question, method, types, units, joins,
controls, saved queries, checks and limitations. Replace the sources only with
files you are authorized to analyze and share.

## Run and reopen

Requires Node 22.16+ with node:sqlite (the Harness-managed Node works). No npm
installation, CDN or network service is required. From this directory:

    node tools/build.mjs
    node tools/serve.mjs

Open the exact loopback URL printed by the preview server. The app also runs in
Harness's isolated viewer. The browser re-imports the data and checks that its
SQLite results match the saved native build. Stop the server with Ctrl-C.

Edit analysis.json and queries/*.sql through the agent, or use the browser's
explicit controls and read-only SQL editor. Replace a source CSV with the same
headers/types. For a new schema, change the explicit mappings with the agent.
No type guessing, silent row dropping, automatic missing-to-zero conversion or
automatic date/number cleanup is performed. A failed build/import leaves the
last good results intact and does not mark the candidate ready.

## Save and share

Save project downloads current CSVs, schema, SQL, applied controls and review
notes as one .data-studio.json. Reopen with Open project in any Data Studio
workspace. To restore files for editing outside the app:

    node tools/restore.mjs /path/to/analysis.data-studio.json /path/to/NEW_FOLDER

Then build in that folder. Restore refuses to overwrite a nonempty directory.
Unapplied SQL/control drafts are not saved. Browser changes never silently write
to the original workspace. The original built ZIP is a snapshot of the last CLI
build, not a browser autosave. Rebuild a restored JSON project to make a new ZIP.

output/analysis.sqlite opens in SQLite 3.37+ tools (STRICT tables). It stores source tables
with typed fields and a _record column: original CSV record number, including
the header as record 1. Decimal fields are stored as scaled integers, NOT REAL;
analysis.json records the scale/unit. Queries live separately as readable SQL.
output/report.html is a standalone, inert report with applied parameters,
results, method, checks, notes and limitations. CSV exports protect against
formula-looking text with an apostrophe; use SQLite/project JSON for exact types
and nulls. Do not open untrusted original CSVs with formula evaluation enabled.

Project files, databases and reports contain the source data. Review before
sharing; no automatic redaction or encryption is performed.

## Limits and verification

8 files / 50 columns each / 100,000 total records / 6 MiB source CSV combined.
1,000,000 source cells, 12 saved queries, 10,000 result rows and 4 MiB per result
(8 MiB combined); 20-second execution
budget, 128 MiB SQLite heap. Query language is one read-only SELECT/WITH using
named :parameters; no extension, file or write operations. All required query
checks must return exactly one column named violations and one value 0.
Declared many-to-one relationships require a unique target key. Result links
are checked for valid source records; the agent must also test that drilldown
queries match the intended calculation. Checks are evidence, not a guarantee
that an arbitrary analytical interpretation is correct. Do not infer causation
from descriptive comparisons.

Builds stage outputs, reopen the actual SQLite file read-only, compare every
query, verify input hashes before publication, and retain previous output under
.harness/history. The build alone leaves readiness false: the agent must run a
real interaction proof, inspect the interface and independently check the data.

MIT wrapper; see LICENSE and vendor/NOTICE.md for upstream terms.

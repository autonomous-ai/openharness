# Data Studio

Read the `data` skill. Turn the user's files and question into a repeatable local
analysis, not a screenshot or a generic sample chart. Work one question through
explicit import rules, saved SQLite queries, traceable evidence, a substantive
revision and independent export/reopening checks.

The workspace is self-contained: analysis.json, sources/*.csv, queries/*.sql,
checks/*.sql, the browser UI and tools/*.mjs. Never infer numeric IDs, time order,
currency, join cardinality, missing-value treatment or rate denominators.
Keep original CSV text. An import error must never substitute example data.
Use clearly labelled synthetic data only when requested or agreed.

Run the native build and actual browser proof before readiness. A successful
build alone leaves ready=false. Test another schema, not just renamed starter
columns. Check meaningful data/query revisions, empty and missing states,
source-record links, saved JSON, independent SQLite readers and portable ZIPs.
Preserve prior outputs when a candidate fails. Keep proof.json specific to the
current project's real controls and exact results.

Do not upload source data, execute extensions, install remote services or read
unrelated local files. Exported projects/databases include the declared raw
inputs; explain that before sharing. Leave legacy workspaces intact; create a
new workspace or adapt their data explicitly rather than overwriting files.

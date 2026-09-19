---
name: data
description: Build and verify interactive CSV dashboards in Data Studio, with truthful metrics, filtering, inspection and export.
---

# Data Studio

Read the source before choosing a chart. `data.mjs` contains the tested CSV parser and aggregation;
`dashboard.mjs` binds it to the interface. The default parser supports quoted fields, embedded
newlines, escaped quotes, BOM and CRLF, and rejects duplicate headers or ragged records.

The starter needs two text dimensions (period and group) and at least one fully numeric column.
Uploads are limited to 5 MB. Numeric-looking year columns will be inferred as measures: adapt the
mapping when the user's schema differs. Periods use natural string order; parse dates explicitly
for formats that do not sort chronologically. Missing period/group combinations aggregate to zero.
Blank numeric values are not silently imputed. Do not assume revenue means USD; currency suffixes
such as `_usd` are explicit units.

Use the source data for every metric, tooltip and exported row. Labels and uploaded text go through
`textContent`. The browser's imported data is temporary; export it to persist a selection. Exported
CSV preserves source values, including formula-looking text; treat it as untrusted in spreadsheet apps.

## Verification

```sh
sh "$DATA_SKILLS/data/scripts/update-verdict.sh"
node "$DATA_SKILLS/data/scripts/perf.mjs" "$HARNESS_WORKSPACE/index.html"
```

The first command runs the shared browser proof and writes the verdict, screenshot and
`.harness/browser-proof.json` with hashes of loaded local files. It requires Playwright + Chromium
in the shared isolated-web-viewer package, or `PLAYWRIGHT_MODULE` pointing to `playwright/index.mjs`.
Keep `proof.json` as real control actions and exact text/attribute assertions. Update it when the
dashboard changes. A failed or unavailable browser check must not become `ready: true`.

Inspect desktop and narrow layouts. Test another dataset, no matching rows, negative/zero values,
malformed CSV, changed column names, keyboard point inspection and export. The performance helper
exercises controls while measuring frame delays/long tasks; do not claim an unmeasured frame rate.

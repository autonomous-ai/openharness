# Data Studio

Read the `data` skill. Build an exploratory dashboard around the user's actual data and question.
The starter uses `index.html`, `dashboard.mjs` and `data.mjs`, with `data.csv` as its source.
The shared viewer serves local modules and data; no CDN, build step or separate server is needed.

Preserve the meaning of the data: units, missing values, time order and filtering rules must be
explicit. A load or parsing error is an error, never a reason to silently substitute sample data.
Derive axes, labels, groups and totals from the source rather than hardcoding the starter's values.

Provide useful filters, exact-value inspection, a clear empty state and a downloadable selection.
Keep `proof.json` current. `update-verdict.sh` now runs a real browser proof, not a file-existence
check. Inspect the screenshot and exercise changed datasets before reporting completion.

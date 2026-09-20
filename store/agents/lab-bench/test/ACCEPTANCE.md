# Signal acceptance — 2026-09-20

The rebuilt Lab Bench helps a person plan an experiment, collect their measurements, inspect a
declared model and prepare a follow-up. The initial coffee project contains no measurements.
Original logos/icons and the earlier synthetic viewer remain in the repository. Acceptance
response files are explicitly synthetic fixtures, labeled in the studio, reports and Store
examples. They do not establish physical findings or installed-agent prompt completion.

## Observed workflows

- Actual Chrome input edits a plan, saves source and retains its earlier edition. Source conflicts
  and malformed agent edits preserve the browser draft; reloading restores local changes.
- Protocol approval protects factors, response, procedure, run settings and original allocation.
  Collecting a first measurement also freezes the design. Later phases append their own runs.
- Actual file upload previews mapped CSV columns and units, then commits atomically. Unknown or
  duplicate run ids, wrong settings, wrong units and nonfinite values are rejected. Blank responses
  remain pending. Original UTF-8 bytes, SHA-256, physical row numbers and mappings survive delivery.
- Corrections and exclusions retain the original observation and a reasoned history. The
  all-recorded sensitivity fit includes excluded training rows. Diagnostics never delete data.
- A rank-deficient quadratic model is repaired through the real follow-up controls, new settings
  and a fresh CSV. Unsupported rank, residual degrees of freedom and conditioning stop inference.
- Comparison controls freeze forecasts for a confirmation phase; its fresh measurements remain
  outside the training fit. Extension phases explicitly add new observations to the model.
- Browser ZIP exports reopen offline with their complete source. Numeric, categorical and fixed
  block controls work in all six delivered editions. All four stages fit a 390px viewport in each
  edition: 24 responsive views, no horizontal document overflow and no page errors.
- The source bridge checks same-origin JSON writes and revisions, saves history, compiles before
  replacement, and rejects a concurrent writer while the first body is still arriving. Actual
  build/check entry points also run through symlinked workspace paths.

The shared browser runner additionally verifies sibling fetch, localStorage, ES modules and
missing-artifact recovery in the shared web viewer. Signal uses its own local source bridge.

## Three authored briefs, six delivered editions

| Brief | Design | Targeted revision | Primary training rows before → after |
| --- | --- | --- | ---: |
| Clearwater Coffee | Two numeric factors, interaction, independent jars, scheduled midpoint controls | Two new settings, three held-out confirmations each; frozen training fit unchanged | 15 → 15 |
| Canopy Seedlings | Three media, two water levels, two complete shelf blocks | Logged instrument exclusion, exploratory medium × water interaction, all-recorded sensitivity fit | 24 → 23 |
| Fold Paperworks | Two three-level factors, interaction and two quadratic terms | Two new interior settings, two independent observations each, added to training | 18 → 22 |

Approved factor definitions, response, procedure, original runs and original CSVs are unchanged
across each revision. Every edition includes a portable editable studio, project, original files,
collection CSV, measurements, design matrix, analysis, SVG figures, audit, printable sheets and
report, actual PDFs, a complete ZIP, and a Python reproduction script. Confirmations also carry
the original training matrix, coefficients, covariance and forecasts.

`test/verify-delivery.py` independently constructs the coded matrix from the project schema and
uses statsmodels 0.14.6 / SciPy 1.13.1 to check coefficients, covariance, standard errors,
pointwise intervals, residuals, studentization, leverage, Cook's distance, leave-one-out RMSE,
comparisons and predictions. It executes the delivered reproduction script, verifies ZIP contents,
raw source hashes/rows, SVG XML, A4 sizes, PDF text bounds, units and every collection run id.
All six editions pass. Their **12 PDFs / 48 pages** were rendered with Poppler and visually
reviewed. Report charts have block legends and readable integer run-order labels; the observation
summary clearly identifies its first eight rows while the complete data remain in the kit.

Local evidence:

- `/private/tmp/signal-shared-browser/browser-results.json`: shared viewer and seven Signal browser workflows pass.
- `/private/tmp/signal-acceptance-release/acceptance.json`: six exported editions and preserved approved-source hashes.
- `/private/tmp/signal-acceptance-release/independent-verification.json`: independent reader, all six editions, 48 PDF pages.
- `/private/tmp/signal-acceptance-release/browser-reopening.json`: six offline deliveries and 24 responsive views.
- `/private/tmp/signal-print-release/`: final rendered print review.

The 27 package tests, generated-artifact/math-bundle/branding checks, Store catalog/conformance
checks and 421 CLI Store/check tests pass locally. CI repeats package, browser, six-delivery,
offline-reopening and independent-reader checks. Store screenshots come from these actual
reopened deliveries, with the synthetic-data notice visible.

## Reproduce

```sh
sh store/agents/lab-bench/toolchain/setup.sh
node store/agents/lab-bench/toolchain/build-math.mjs --check
node --test store/agents/lab-bench/test/*.test.mjs
node store/agents/lab-bench/test/browser.mjs
node store/agents/lab-bench/test/acceptance.mjs
node store/agents/lab-bench/test/reopen-deliveries.mjs work/experience-evidence/signal-acceptance
python3 -m venv /tmp/signal-statistics-reader
/tmp/signal-statistics-reader/bin/pip install -r store/agents/lab-bench/template/studio/requirements.txt
/tmp/signal-statistics-reader/bin/python store/agents/lab-bench/test/verify-delivery.py work/experience-evidence/signal-acceptance
```

The independent reader requires Python with wheels for the pinned packages and Poppler's
`pdfinfo`/`pdftotext`; CI uses Python 3.12. The product itself does not require Python.

## Method and remaining scope

Complete factorial continuous-response experiments: 1–6 factors, numeric or categorical levels,
independent repetitions, complete fixed blocks, main effects, two-factor interactions and numeric
quadratics. Limits include 512 runs, 48 expanded model columns and 5 MB complete source. SVD
guards rank/conditioning; ordinary least-squares intervals assume independent units, a suitable
mean model, constant variance and approximately normal errors. Intervals are pointwise and do
not adjust for searching settings. Planned-range checks do not prove empirical support throughout
the range. Near-zero residual variation withholds intervals and confirmation forecasts.

No physical experiment, instrument control, clinical trial, mixed/repeated/GLM model, fractional
design, general causal inference, automatic optimum, customer result, real printer or
installed-agent prompt trial is claimed. Chrome and an emulated narrow viewport were exercised;
other browsers and actual phones remain unmeasured. Passing software checks is evidence of the
tested workflow and calculations, not evidence that a practical experimental conclusion is true.

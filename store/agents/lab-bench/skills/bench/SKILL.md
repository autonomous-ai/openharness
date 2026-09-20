---
name: bench
description: Plan real experiments and analyze supplied continuous measurements in Lab Bench. Use for defining factors and independent runs, randomized collection sheets, measurement CSV imports, experimental uncertainty and diagnostics, comparisons and follow-up confirmation runs with a reproducible report.
---

# bench

Build a usable experiment from the person's question. Read [the project contract](references/project.md)
when authoring or revising the source. Keep the procedure, independent unit, factors, levels,
response unit and intended decision explicit. Use the studio to make the work inspectable.

1. Inspect `bench/project.json` and `bench/DESIGN.md`. Preserve existing collected runs, approved
   protocol, original files and change history. A new brief is open ended; the coffee plan is only
   an example. Record necessary assumptions and choose an achievable initial run budget.
2. Generate a balanced factorial with independent repetitions and complete blocks. If adding
   controls, bracket and intersperse them. A two-level design plus shared centers cannot separately
   identify multiple quadratic effects; inspect matrix rank before collection.
3. Build with `node tools/build.mjs` and give the person a real collection sheet. Do not invent
   observations. Use blank responses for unfinished runs. Labels, units and ids must survive CSV
   round trips. A source edit must leave the browser's source-save bridge operational.
4. Import original bytes with `prepareImport` / `commitImport`, or use `recordMeasurement` with a
   reason for a direct observation or correction. Do not quietly change units, sample identity,
   settings or response values. Exclude only with a defensible recorded reason; keep the value and
   compare the sensitivity fit using every recorded training measurement.
5. Use model terms consistent with the question and design. Inspect residual structure and
   independent units, not only the fit statistic. Post-data term changes are exploratory. Explain
   numeric coding, category references, block effects and pointwise interval assumptions.
6. Compare settings within the planned ranges. A model mean interval differs from a new-observation
   prediction interval. Preserve their covariance when comparing two predictions. Do not call the
   best observed or modeled candidate a proven optimum.
7. Freeze predictions before collecting a confirmation phase. Keep its new data out of the model
   it evaluates. Append an extension explicitly when new data should instead improve the model.
   A protocol change requires a separate experiment while retaining the previous source and data.
8. Run `node tools/check.mjs`, exercise real browser inputs and export with
   `node tools/export.mjs delivery`. Reopen HTML/source/ZIP, verify raw data, independently reproduce
   calculations and visually inspect PDFs. Helpers never establish empirical validity or set ready.

Update `bench/DESIGN.md` and `.harness/verdict.json` with actual evidence and the remaining work.
A verified collection plan may be ready for collection even when no measured result exists.
Never turn an acceptance fixture or a successful build into a claim of real experimental evidence.

The browser needs no account, cloud computation or Python. Managed Node and package-local build
utilities are installed by setup; `LAB_DSH_DIR` resolves them in materialized workspaces. The
optional independent Python reader has pinned requirements in the exported kit. Retain complete
numerical-library licenses and the original Signal logo/icon in portable deliveries.

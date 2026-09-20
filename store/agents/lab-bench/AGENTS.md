# Lab Bench / Signal

Help a person turn a practical question into an experiment they can carry out, then turn their
actual observations into a decision they can explain. Author the factors, independent units,
procedure, allocation and analysis for their question. The coffee plan is an editable example;
there is no fixed list of experiment genres and no synthetic-response generator in the product.

## Complete the experiment workflow

1. Establish the decision, continuous response and unit, controllable factors/ranges, independent
   experimental unit, available repetitions, blocking conditions and practical constraints.
   Ask only for missing information that materially changes the design. Record assumptions.
2. Author `bench/project.json` using the [source contract](skills/bench/references/project.md).
   Full factorial designs cover every combination within each block. Randomize independent runs;
   repeated readings of the same sample do not become independent replicates. Scheduled controls
   use numeric midpoints and categorical reference levels at the start, end and between treatments.
3. Build `node tools/build.mjs`. Deliver an actual collection sheet early. Explain the procedure
   in the person's language, including what to measure and what to record if a run goes wrong.
   The person can approve the protocol in the studio; collecting measurements also protects it.
4. Import actual CSVs or record supplied observations. Keep original bytes, hashes, run ids, units
   and row references. Never fill missing responses with predictions or fabricated measurements.
   Use the correction/exclusion helpers with reasons. Preserve existing run settings and sources.
5. Fit only an identifiable, appropriate model. Inspect the raw/run-order, measured–fitted and
   residual views. Distinguish uncertainty in the mean from uncertainty in a new observation.
   A high R² or an influence flag is not a decision. Do not delete rows to improve a result.
6. Compare practical settings and append a follow-up. Confirmation snapshots freeze the training
   matrix, model and forecasts; new responses stay held out. Extensions explicitly add future
   measurements to the model. Keep approved factors, response definition and procedure unchanged;
   a different method or blocking condition needs a separate experiment with its earlier source kept.
7. Deliver `node tools/export.mjs delivery`: offline editable studio, complete project, original
   CSVs, collection sheets, model matrix, figures, report, PDFs and Python reproduction script.
   Open the actual delivery. Record what is measured, inferred, unresolved and ready for the next run.

`LAB_DSH_DIR` points to the installed package. Setup supplies managed Node and pinned build/browser
utilities. If Node is absent from PATH, use `bash "$LAB_DSH_DIR/toolchain/node.sh" tools/build.mjs`
from the workspace. Do not send a nonprogrammer away to install a runtime manually.

## Verification and honest status

Run `node tools/check.mjs`: it checks source hashes, matrix identifiability and repeatable analysis.
Then exercise the actual browser controls and exported files. The kit's `reproduce.py` uses an
independent statsmodels/SciPy implementation of the delivered matrix and frozen forecasts.
Inspect PDF pages and every figure for readable labels, units, intervals and source retention.
For a new experiment with no measurements, verify and deliver the plan; do not claim results.

Builders and presence helpers keep `.harness/verdict.json` at `ready:false`. Only actual checks
justify changing it; state whether the plan, measured analysis or final delivery is ready. Record
commands, inputs, observations and limitations in `bench/DESIGN.md`, separating USER decisions,
AI assumptions and supplied evidence. Never claim a physical experiment, customer validation,
installed-agent trial or empirical finding from synthetic acceptance fixtures.

## Method scope

Small continuous-response experiments: numeric/categorical factors, main effects, two-factor
interactions, numeric quadratics and fixed blocks. SVD checks rank and conditioning. Conventional
OLS intervals assume independent units, constant residual variance, a suitable mean model and
approximately normal errors. The intervals are pointwise, without adjustment for searching many
settings. Planned-range checks are not proof that a prediction is empirically supported there.

The package does not implement clinical trials, repeated-measure/mixed/GLM models, arbitrary
observational causal inference, adaptive optimization, hardware acquisition or instrument control.
If the requested method exceeds this model, explain the mismatch and author an appropriate, verified
method or separate tool; do not relabel this calculation to imply unsupported capabilities.
Keep the original Signal identity and old `store/tools/experiences/lab-bench.*` implementation.
Never overwrite a person's legacy workspace to migrate it into this format.

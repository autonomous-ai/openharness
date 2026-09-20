# Signal source and method contract

`bench/project.json` is the complete version-1 experiment. `studio/` contains portable, ordinary
ES modules; `tools/build.mjs` emits `bench/index.html`. The source JSON contains the original CSV
bytes, so a `.signal.json` file reopens independently. No executable user code is embedded in data.

## Source fields

- `id`, `title`, `question`; `response: {id,name,unit,goal,target?}`. Goal is maximize, minimize or
  target. Response values are finite continuous numbers, absolute value at most 1e12.
- `factors: [{id,name,type,unit,levels}]`: 1–6 numeric or categorical factors, 2–5 levels each.
  Numeric levels increase strictly; the low/high levels define the fixed −1/+1 model coding.
  Categories use the first level as the reference. Factor ids remain stable CSV columns.
- `protocol: {unit,randomization,analysisPlan,steps,notes}` describes independent experimental
  units and a reproducible measurement procedure. `approved` protects it before collection;
  the first actual measurement also freezes the factors, response, design and original runs.
- `design: {seed,replicates,blocks,controls}`: 1–20 independent repetitions of every factorial
  combination per block; 1–8 named complete blocks. Controls are 0 or 2–5 per block, placed at
  start/end and between treatments. Their settings are numeric midpoints / first categories.
- `model: {terms,blocks,confidence}`. Terms are factor ids, `a:b` interactions or numeric `a^2`.
  Include the main effects belonging to interactions/quadratics. An intercept is always included;
  optional fixed-block columns compare with the first block. At most 48 expanded columns.
  Confidence is .8/.9/.95/.99. No automatic variable selection or multiplicity adjustment.
- `runs: [{id,order,phase,block,kind,settings}]`: at most 512; ids and order are unique. Existing
  collected/approved rows stay unchanged. `phases` name initial, extension or confirmation work.
- `measurements: [{runId,value,origin,note,excluded}]`. `origin` retains original value and manual
  or CSV provenance; CSV references its source id and physical row. `excluded` is null or a reason.
- `sources` retain original filenames, UTF-8 bytes in base64, SHA-256, column mapping, unit and time.
  Each file is at most 1 MB; the complete project is at most 5 MB. Import is all-or-nothing.
- `audit` records before/after measurement changes, model changes, imports and design decisions.
  Never truncate it to hide an inconvenient observation. `conclusion` is the person's decision
  note. Optional `comparison:{a,b}` retains settings/block for each inspected candidate.
- Confirmation phases retain a snapshot of the original training matrix, coefficients, covariance,
  model, source hash and predictions. These are ordinary inspectable data, not a signed security log.

## Authoring and source edits

Use helpers instead of changing historical measurements in place:

```js
import {readFile, writeFile} from 'node:fs/promises';
import {generatePlan, appendPhase} from './studio/design.mjs';
import {validateProject, validateTransition, event} from './studio/project.mjs';
import {prepareImport, commitImport, recordMeasurement} from './studio/measurements.mjs';
import {fitProject, predictionSnapshot} from './studio/analysis.mjs';
const before = JSON.parse(await readFile('bench/project.json', 'utf8'));
const bytes = new Uint8Array(await readFile('observations.csv'));
const staged = await prepareImport(before, bytes, {
  name: 'observations.csv', mapping: {runId: 'run_id', response: 'response'},
  unit: before.response.unit,
});
const next = commitImport(before, staged);
validateTransition(before, next);
await writeFile('bench/project.json', JSON.stringify(next, null, 2) + '\n');
```

When redefining an uncollected, unapproved plan, record the previous plan in an audit event,
clear its `runs`/`phases`, then call `generatePlan(next)`. Do not regenerate after collection.
Manual corrections use `recordMeasurement(project, runId, {value,note,excluded,reason})`.
Model changes after collection use `event(next,'model',reason,{before:oldModel,after:newModel,
afterCollection:true})` before writing `next.model`. Preserve the entire previous audit prefix.
Always call `validateTransition` and `verifySources` before saving an edited existing project.

A follow-up uses `appendPhase(project,{points:[{settings,block}],repeats,label,reason,seed,kind,
snapshot})`. The kind is extension or confirmation. For confirmation first compute
`await predictionSnapshot(project,fitProject(project),points)`. It requires an estimable primary
model with residual uncertainty. Extensions can add informative interior points to a rank-deficient
model. New blocks or a changed response/procedure require a separate experiment.

The loopback viewer provides GET/PUT `/api/project`, optimistic `If-Match` revisions and prior
source snapshots in `.harness/history/`. A conflicting save keeps both versions. It accepts local,
same-origin writes. Direct agent edits should preserve the same history and protocol contracts.

## Numerical details and limits

Numeric factors use `(value-midpoint)/halfRange`; categories and fixed blocks use reference
indicators. Interaction columns are products of the corresponding basis columns. Quadratic
columns square the coded numeric term. SVD identifies rank with relative singular cutoff 1e-12;
fits with insufficient residual df or condition number above 1e9 are stopped. Values above 1e6
produce a conditioning warning. Conventional covariance is MSE × X-pseudoinverse × its transpose.

Intervals use Student-t quantiles with n−p df. Mean SE is `sqrt(x cov x')`; one-observation SE
adds residual MSE. A comparison uses the contrast vector `xB−xA`, retaining covariance. Near-zero
residual variation withholds intervals. Residuals, internal studentization, leverage, Cook's
influence and leave-one-out RMSE are exported; review thresholds never remove data automatically.

These assume independent experimental units, a suitable linear mean model, constant residual
variance and approximately normal errors. The model does not establish causal validity by itself.
The package does not implement fractional designs, random/mixed effects, repeated-measure models,
GLMs, sequential testing, clinical protocols, arbitrary optimization or hardware control.

Raw missing responses stay pending. CSV uses UTF-8 (BOM accepted), commas and RFC-style quoting.
Headers must be unique; map distinct id/response columns and confirm the response unit. Known
factor/block/unit columns are checked against the run sheet. Unknown or duplicate run ids, existing
measurements, nonfinite values and mismatched settings are rejected together. No implicit conversion.

## Reproduction and delivery

`node tools/check.mjs` writes `.harness/lab-check.json`; it leaves readiness unchanged.
`node tools/export.mjs delivery` produces source/HTML/CSV/SVG/report and collection PDFs/ZIP.
Browser export includes HTML versions that can be printed, without requiring a local PDF service.
`reproduce.py` with `requirements.txt` independently repeats the actual delivered matrix and frozen
forecasts. It writes `reproduction.json`. Python is only needed for this independent check.

Methods: [NIST factorial designs](https://www.itl.nist.gov/div898/handbook/pri/section3/pri3331.htm),
[control scheduling](https://www.itl.nist.gov/div898/handbook/pri/section3/pri337.htm),
[model assessment](https://www.itl.nist.gov/div898/handbook/pri/section4/pri43.htm),
[confirmation](https://www.itl.nist.gov/div898/handbook/pri/section4/pri46.htm).
Use pinned ml-matrix 6.15.0 and jstat 1.9.6 with complete bundled notices. Acceptance uses independently
constructed matrices and statsmodels 0.14.6 / SciPy 1.13.1. Numerical agreement is not a physical experiment.

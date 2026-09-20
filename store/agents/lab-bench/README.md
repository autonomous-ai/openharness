# Lab Bench — Signal

![Lab Bench logo](brand/logo.svg)

Turn a question into evidence you can act on. Describe what you want to learn; the agent builds
an experiment with an editable protocol, randomized run sheet, measurement workflow and a
reproducible analysis. Keep the original observations and the reasoning behind each decision.

> I want to make my cold brew more consistent. Help me compare steeping time and coffee dose,
> plan independent jars, import my measured extraction values, and choose two settings to test
> again. Keep the original data and give me a report I can share.

The initial coffee project is a collection plan with **no invented measurements**. It is fully
editable. Your project can use different factors, categories, blocks, units, procedures and model
terms; the agent authors these from the question and the practical constraints.

## What you can do

- Plan a complete factorial experiment with independent repetitions, complete blocks and scheduled
  midpoint/reference controls. Approve the protocol; collected runs then retain their settings.
- Download or print a collection sheet. Import actual CSV measurements with explicit column and
  unit mapping, or record results directly. Preserve original bytes, hashes and row references.
- Correct a transcription or exclude a known problem with a reason. Keep its original value and
  history, and compare the primary analysis with a fit using all recorded training measurements.
- Inspect raw/run-order plots, model coefficients and intervals, residuals and influential rows.
  Rank and residual-df checks stop analyses the data cannot support.
- Compare practical settings and their shared uncertainty. Append fresh confirmation runs with
  the forecast frozen beforehand, or extend the model with explicitly identified new observations.
- Keep a portable editable studio, complete source, original data, run sheets, figures, report,
  PDFs and a Python script that independently reproduces the delivered calculations.

The studio and exported HTML work offline. No account, remote model API or Python is needed to
interact with them. Setup supplies managed Node and pinned local build/browser tools. Existing
legacy projects and the original synthetic viewer remain available; they are not overwritten.

## Workspace commands

```sh
node tools/build.mjs
node tools/check.mjs
node tools/export.mjs delivery
```

In an installed workspace, `LAB_DSH_DIR` resolves package-local tools. If Node is not on PATH,
use `bash "$LAB_DSH_DIR/toolchain/node.sh"` in place of `node`. Setup and doctor handle readiness.
The browser also exports the complete kit with printable HTML; the command adds actual PDFs.

## Scope and evidence

Small continuous-response experiments, up to six factors and 512 runs: main effects, interactions,
quadratics and fixed blocks. Conventional OLS intervals rely on the declared model and independent
units. They are pointwise; searching settings does not prove an optimum. Confirmation data remain
outside the original training fit. The tool does not perform the physical experiment for you.

See [acceptance evidence](test/ACCEPTANCE.md) and the [method/source contract](skills/bench/references/project.md).
Acceptance response files are explicitly synthetic. No physical experiment, customer result or
installed-agent prompt completion is implied by a browser or numerical test.

## Logo and icon

The original Signal identity remains in `brand/`: [vector icon](brand/icon.svg),
[256px PNG](brand/icon.png), [light logo](brand/logo.svg) and [dark logo](brand/logo-dark.svg).
The same mark appears in the studio, offline favicon and desktop Store/picker/tabs.

## Credit and stewardship

Original implementation and visual identity by OpenHarness contributors, maintained by Autonomous
under the [MIT license](LICENSE). Numerical libraries are bundled with their complete
[third-party notices](template/studio/THIRD_PARTY_LICENSES.txt). Report issues in the OpenHarness repository.

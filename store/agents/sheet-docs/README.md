# Sheet & Docs Studio

One editable source, three real deliverables: a clean Word report, a formula-driven
Excel workbook and a freshly converted PDF in the document viewer. The regional
revenue starter derives prose, totals, changes and growth rates from the same
inputs—changing a number updates the story on the next build.

## First run

Install `autonomous/sheet-docs` from the Harness Store. Install
[LibreOffice](https://www.libreoffice.org/download/) separately, or set
`SOFFICE_BIN`. The managed helper resolves Node 20+.

```sh
sh "$SSD_SKILLS/sheetsdoc/scripts/export.sh"
```

Ask: “Adapt this report to my regional figures, explain the largest changes, and
give me a Word report, a recalculating spreadsheet and a reviewed PDF.”

Edit `doc.json`, not generated output. `comparison` takes a currency code, two
period labels and region/prior/current rows. It produces real SUM, difference and
growth formulas with zero-denominator handling. The workbook freezes headers,
distinguishes editable blue inputs from calculated values, and includes units
and provenance. The starter is explicitly synthetic, not a real company's results.

For a general document, omit `comparison` and use `sheet: {name, rows}` with a
rectangular table of literal strings/numbers. Title, subtitle, paragraphs and
source text stay editable. Generic sheets allow 1–10 columns and 1,000 rows;
the Word report shows at most 30 data rows. Custom layouts require changes to the
portable OOXML writer. PPTX and arbitrary spreadsheet formulas are not implemented.

## Artifacts and verification

- `out.docx`: editable, styled Word document with a real table and headings.
- `out.xlsx`: editable workbook, recalculated and re-saved by LibreOffice.
- `out.pdf`: fresh Word-to-PDF conversion, shown in the shared Doc Viewer.

Every build clears readiness before validating input. Fresh staging and an
isolated LibreOffice profile prevent stale files or an open desktop session from
being mistaken for a new export. Failures preserve the previous successful
preview but mark it unready. Without LibreOffice, DOCX/XLSX are still produced,
but the build exits incomplete and no PDF readiness is claimed.

The starter was converted by real LibreOffice, visually reviewed, and independently
imported and recalculated with a changed-input/restored-input check. Conversion
does not prove factual accuracy or flawless pagination for arbitrary new content.
Review every page and reconcile inputs before handoff. See `.harness/export.log`
and `.harness/export.json`.

Direct edits to an exported workbook can recalculate that workbook, but do not
change `doc.json` or the Word report. Rebuild from source to refresh all three.

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.

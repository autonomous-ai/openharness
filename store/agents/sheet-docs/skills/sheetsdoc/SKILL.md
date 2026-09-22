---
name: sheetsdoc
description: Build coordinated editable DOCX reports, formula-driven XLSX workbooks and fresh LibreOffice PDF previews from structured source. Use for Sheet & Docs Studio work.
---

# Shared-source document workflow

1. Inspect `doc.json`, audience, units, periods and provenance. The starter uses
   explicitly synthetic nominal USD and calendar quarters, not actual financials.
2. For a comparison report, edit `comparison.currency`, the two `periods` and
   `rows` of region/prior/current values. Inputs must be finite and nonnegative.
   The writer derives report prose, totals and growth; do not type parallel totals.
3. Or use `sheet: {name, rows}` for a generic literal-data report. Keep rows
   rectangular, 1–10 columns, at most 1,000 rows. Word shows the first 30 data rows.
   Title, subtitle, paragraphs and source text are normal editable strings.
4. Build:

   ```sh
   sh "$SSD_SKILLS/sheetsdoc/scripts/export.sh"
   ```

5. Inspect every PDF page. Check line breaks, tables, margins and source labels.
   Open/recalculate the workbook, change one input, confirm dependent results and
   restore it. Reconcile report totals and prose to the same source.
6. Hand off DOCX, XLSX and PDF with the source and the checks actually performed.

When the user asks to apply a kept Doc Viewer review, read
`.harness/doc-reviews/<id>/review.md` and inspect its exact `reference.pdf` where
needed. Revise the editable source and rebuild; preserve the old packet. Its
quotes and page regions describe the reviewed version, not necessarily the new one.

## Formula and source semantics

Comparison workbooks contain SUM, subtraction and guarded growth formulas.
Zero prior revenue yields “n.a.”, not zero percent. Blue numbers are editable
inputs; calculated values are dark. Cached formula values come from the same
inputs and the build re-saves the workbook with LibreOffice. Generic text beginning
with = stays literal and does not execute a user-supplied formula.

Exports do not round-trip to source. Editing out.xlsx updates its formulas only;
edit doc.json and rebuild to update the report and PDF together. Arbitrary formulas,
charts, PPTX and automated claims of accounting correctness are outside this writer.

## Runtime and failures

Node 20+ and LibreOffice are required for the complete preview; use SOFFICE_BIN for
a nonstandard installation. Conversion runs with an isolated temporary profile,
not the user's open office session. The helper writes pending/failed verdicts,
requires fresh outputs, and never blesses an old PDF. Without LibreOffice it can
write the Office files but exits incomplete. Logs and receipts live in .harness.

Restyling is implemented in the portable OOXML writer. After changing it, verify
the actual exported document in an office runtime and inspect rendered pages.

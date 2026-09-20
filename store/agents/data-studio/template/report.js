// Self-contained, inert HTML handoff. Export current results, parameters and method, never scripts.
globalThis.DataStudioReport = (bundle, report, notes = "") => {
  const C = globalThis.DataStudioCore,
    esc = (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
  const c = bundle.config;
  return (
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>' +
    esc(c.title) +
    "</title><style>body{font:15px/1.6 system-ui;color:#18362d;max-width:1120px;margin:40px auto;padding:0 24px}h1{font-size:36px}h2{margin-top:40px}small,p{color:#52645c}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:13px}th,td{text-align:left;border-bottom:1px solid #ddd;padding:8px}th{background:#edf4ef}section{overflow:auto}.badge{color:#805600}pre{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:5px 0}@media print{body{margin:0}section{break-inside:avoid}thead{display:table-header-group}}</style><body><p>DATA STUDIO · REPRODUCIBLE ANALYSIS</p><h1>" +
    esc(c.title) +
    '</h1><p class="badge">' +
    (c.example
      ? "Synthetic example data — not real results"
      : "User-supplied data") +
    "</p><p>" +
    esc(c.question) +
    "</p><p>" +
    esc(c.method) +
    "</p><h2>Applied controls</h2><pre>" +
    esc(JSON.stringify(report.parameters, null, 2)) +
    "</pre>" +
    report.results
      .map((r) => {
        const q = c.queries.find((q) => q.id === r.id);
        return (
          "<section><h2>" +
          esc(q.title) +
          "</h2><p>" +
          esc(q.explanation) +
          "</p><table><thead><tr>" +
          r.columns.map((k) => "<th>" + esc(k) + "</th>").join("") +
          "</tr></thead><tbody>" +
          r.rows
            .map(
              (row) =>
                "<tr>" +
                row
                  .map(
                    (v, i) =>
                      "<td>" +
                      esc(C.format(v, q.formats?.[r.columns[i]])) +
                      "</td>",
                  )
                  .join("") +
                "</tr>",
            )
            .join("") +
          "</tbody></table>" +
          (!r.rows.length
            ? "<p>No matching records. Missing is not zero.</p>"
            : "") +
          "</section>"
        );
      })
      .join("") +
    "<h2>Checks and limitations</h2><ul>" +
    report.checks.map((x) => "<li>" + esc(x.description) + "</li>").join("") +
    c.limitations.map((x) => "<li>" + esc(x) + "</li>").join("") +
    "</ul><h2>Review notes</h2><pre>" +
    esc(notes || "No review notes saved.") +
    "</pre><h2>Reproducibility</h2><p>Revision " +
    esc(report.revision) +
    "<br>" +
    esc(report.engine) +
    "</p><p>CSV exports are spreadsheet-safe: formula-looking text is prefixed with an apostrophe. Null exports as an empty CSV field; use the project JSON or SQLite database for exact types and missing values. Source CSVs and saved SQL are in the project; _record is the original CSV record number, including the header as record 1.</p></body></html>"
  );
};

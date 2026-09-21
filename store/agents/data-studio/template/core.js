// Original OpenHarness code. Shared unchanged by Node, the page and the bounded worker.
globalThis.DataStudioCore = (() => {
  "use strict";
  const LIMITS = Object.freeze({
    sourceBytes: 6 * 1024 * 1024,
    rows: 100000,
    cells: 1000000,
    columns: 50,
    tables: 8,
    queries: 12,
    resultRows: 10000,
    resultBytes: 4 * 1024 * 1024,
    totalResultBytes: 8 * 1024 * 1024,
    cell: 4096,
  });
  const fail = (message) => {
    throw new Error(message);
  };
  const bytes = (text) => new TextEncoder().encode(text).length;
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const own = (o, k) => Object.hasOwn(o, k);
  const ident = (value) =>
    typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value) &&
    !/^(sqlite_|pragma_)/i.test(value);
  const path = (value) =>
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(value) &&
    value.split("/").every((p) => p && !p.startsWith("."));
  const list = (v, max, label) =>
    Array.isArray(v) && v.length && v.length <= max
      ? v
      : fail(label + " needs 1–" + max + " entries.");
  function unique(values, label) {
    if (new Set(values).size !== values.length)
      fail("Duplicate " + label + ".");
  }
  function exactKeys(value, allowed, label) {
    if (!object(value)) fail(label + " must be an object.");
    for (const k of Object.keys(value))
      if (!allowed.includes(k)) fail("Unknown " + label + " field: " + k);
  }
  function text(value, label, max = 500) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > max ||
      value.includes("\0")
    )
      fail(label + " must be nonempty text (maximum " + max + " characters).");
    return value;
  }
  function date(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + "T00:00:00Z");
    return (
      Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value
    );
  }
  // RFC-style quoted CSV; a blank physical record is rejected, never silently dropped.
  function parseCSV(input) {
    if (
      typeof input !== "string" ||
      bytes(input) > LIMITS.sourceBytes ||
      input.includes("\0")
    )
      fail("CSV must be UTF-8 text without NUL, at most 6 MiB.");
    input = input.replace(/^\uFEFF/, "");
    const records = [];
    let record = [],
      field = "",
      quoted = false,
      closed = false,
      cellCount = 0;
    const cell = () => {
      if (++cellCount > LIMITS.cells) fail("CSV exceeds 1,000,000 cells.");
      if (field.length > LIMITS.cell) fail("CSV cell exceeds 4096 characters.");
      record.push(field);
      field = "";
      closed = false;
      if (record.length > LIMITS.columns) fail("CSV exceeds 50 columns.");
    };
    const row = () => {
      cell();
      records.push(record);
      record = [];
      if (records.length > LIMITS.rows + 1)
        fail("CSV exceeds 100,000 records.");
    };
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      if (quoted) {
        if (c === '"') {
          if (input[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            quoted = false;
            closed = true;
          }
        } else field += c;
      } else if (c === ",") cell();
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && input[i + 1] === "\n") i++;
        row();
      } else if (c === '"') {
        if (field || closed)
          fail("Unexpected CSV quote at character " + (i + 1) + ".");
        quoted = true;
      } else {
        if (closed) fail("Text after a closing CSV quote.");
        field += c;
      }
      if (field.length > LIMITS.cell) fail("CSV cell exceeds 4096 characters.");
    }
    if (quoted) fail("Unclosed CSV quote.");
    if (field || record.length || closed) row();
    if (!records.length) fail("CSV is empty.");
    const headers = records.shift();
    if (headers.some((h) => !h || h.trim() !== h))
      fail("CSV headers must be nonempty, without surrounding whitespace.");
    unique(headers, "CSV header");
    records.forEach((r, i) => {
      if (r.length !== headers.length)
        fail(
          "CSV record " +
            (i + 2) +
            " has " +
            r.length +
            " fields; expected " +
            headers.length +
            ".",
        );
      if (r.every((v) => v === ""))
        fail("Blank CSV record " + (i + 2) + "; remove it explicitly.");
    });
    return { headers, records };
  }
  function convert(raw, c, label) {
    const value = c.trim ? raw.trim() : raw;
    if ((c.missing ?? [""]).includes(value)) {
      if (c.nullable === true) return null;
      fail(label + " is missing but required.");
    }
    if (c.type === "text") return value;
    if (c.type === "date") {
      if (!date(value)) fail(label + " must be an ISO date (YYYY-MM-DD).");
      return value;
    }
    if (c.type === "integer") {
      if (
        !/^-?(0|[1-9]\d*)$/.test(value) ||
        !Number.isSafeInteger(Number(value))
      )
        fail(label + " must be a safe base-10 integer.");
      return Number(value);
    }
    if (c.type === "decimal") {
      const m = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
      if (!m || (m[3]?.length ?? 0) > c.scale)
        fail(
          label +
            " must be decimal text with at most " +
            c.scale +
            " fractional digits; no rounding is implicit.",
        );
      const n = BigInt((m[1] || "") + m[2] + (m[3] ?? "").padEnd(c.scale, "0"));
      if (
        n > BigInt(Number.MAX_SAFE_INTEGER) ||
        n < BigInt(Number.MIN_SAFE_INTEGER)
      )
        fail(label + " exceeds exact integer storage.");
      return Number(n);
    }
    if (c.type === "real") {
      if (
        !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ||
        !Number.isFinite(Number(value)) ||
        Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER
      )
        fail(label + " must be a finite base-10 number.");
      return Number(value);
    }
    fail("Unsupported column type: " + c.type);
  }
  function validateConfig(c) {
    exactKeys(
      c,
      [
        "spec",
        "title",
        "question",
        "example",
        "method",
        "limitations",
        "tables",
        "relationships",
        "parameters",
        "queries",
        "checks",
      ],
      "analysis",
    );
    if (c.spec !== 1 || typeof c.example !== "boolean")
      fail(
        "analysis.spec must be 1 and example must explicitly be true or false.",
      );
    text(c.title, "Title", 120);
    text(c.question, "Question");
    text(c.method, "Method", 2000);
    if (!Array.isArray(c.limitations) || c.limitations.length > 12)
      fail("Provide a limitations array.");
    c.limitations.forEach((v) => text(v, "Limitation"));
    list(c.tables, LIMITS.tables, "Tables");
    unique(
      c.tables.map((t) => String(t.id).toLowerCase()),
      "table name",
    );
    unique(
      c.tables.map((t) => t.file),
      "source path",
    );
    for (const t of c.tables) {
      exactKeys(t, ["id", "file", "label", "columns", "key"], "table");
      if (!ident(t.id) || !path(t.file) || !t.file.endsWith(".csv"))
        fail("Table needs a safe id and relative .csv file.");
      text(t.label, "Table label");
      list(t.columns, LIMITS.columns, "Columns");
      unique(
        t.columns.map((x) => String(x.name).toLowerCase()),
        "column name",
      );
      unique(
        t.columns.map((x) => x.source),
        "mapped header",
      );
      for (const col of t.columns) {
        exactKeys(
          col,
          [
            "name",
            "source",
            "type",
            "nullable",
            "missing",
            "trim",
            "scale",
            "unit",
          ],
          "column",
        );
        if (
          !ident(col.name) ||
          !["text", "integer", "decimal", "real", "date"].includes(col.type) ||
          typeof col.nullable !== "boolean"
        )
          fail("Column needs a safe name, explicit type and nullable boolean.");
        text(col.source, "Source header", 120);
        if (
          col.type === "decimal" &&
          (!Number.isInteger(col.scale) || col.scale < 0 || col.scale > 6)
        )
          fail("Decimal scale must be 0–6.");
        if (col.type !== "decimal" && col.scale !== undefined)
          fail("Only decimal columns have a scale.");
        if (col.trim !== undefined && typeof col.trim !== "boolean")
          fail("trim must be boolean.");
        if (
          col.missing !== undefined &&
          (!Array.isArray(col.missing) ||
            col.missing.length > 10 ||
            col.missing.some((v) => typeof v !== "string"))
        )
          fail("missing must be an array of strings.");
        if (col.unit !== undefined) text(col.unit, "Unit", 80);
      }
      if (t.key !== undefined) {
        list(t.key, 5, "Key columns");
        unique(t.key, "key column");
        if (
          t.key.some(
            (n) => !t.columns.some((col) => col.name === n && !col.nullable),
          )
        )
          fail("Key columns must exist and be non-nullable.");
      }
    }
    if (!Array.isArray(c.relationships) || c.relationships.length > 12)
      fail("relationships must be an array of at most 12 joins.");
    for (const r of c.relationships) {
      exactKeys(r, ["from", "to", "allowMissing"], "relationship");
      for (const side of ["from", "to"]) {
        exactKeys(r[side], ["table", "column"], "relationship endpoint");
        if (
          !c.tables.some(
            (t) =>
              t.id === r[side].table &&
              t.columns.some((x) => x.name === r[side].column),
          )
        )
          fail("Unknown relationship endpoint.");
      }
      if (typeof r.allowMissing !== "boolean")
        fail("Join allowMissing must be explicit.");
      const target = c.tables.find((t) => t.id === r.to.table);
      if (target.key?.length !== 1 || target.key[0] !== r.to.column)
        fail("Join target must have a single-column unique key.");
      const from = c.tables
          .find((t) => t.id === r.from.table)
          .columns.find((x) => x.name === r.from.column),
        to = target.columns.find((x) => x.name === r.to.column);
      if (from.type !== to.type || from.scale !== to.scale)
        fail("Join key types/scales must match.");
    }
    if (!Array.isArray(c.parameters) || c.parameters.length > 12)
      fail("parameters must be an array of at most 12 controls.");
    unique(
      c.parameters.map((p) => p.id),
      "parameter",
    );
    for (const p of c.parameters) {
      exactKeys(
        p,
        ["id", "label", "type", "default", "choices", "hidden"],
        "parameter",
      );
      if (!ident(p.id) || !["text", "date", "integer", "real"].includes(p.type))
        fail("Invalid parameter.");
      text(p.label, "Parameter label");
      if (p.hidden !== undefined && typeof p.hidden !== "boolean")
        fail("hidden must be boolean.");
      if (
        p.choices !== undefined &&
        (!Array.isArray(p.choices) ||
          !p.choices.length ||
          p.choices.length > 100 ||
          p.choices.some((v) => typeof v !== "string"))
      )
        fail("choices must contain 1–100 text values.");
    }
    parameters(c, {});
    list(c.queries, LIMITS.queries, "Queries");
    unique(
      c.queries.map((q) => q.id),
      "query id",
    );
    unique(
      c.queries.map((q) => q.file),
      "query file",
    );
    for (const q of c.queries) {
      exactKeys(
        q,
        [
          "id",
          "title",
          "file",
          "kind",
          "x",
          "y",
          "formats",
          "explanation",
          "trace",
          "sourceLinks",
        ],
        "query",
      );
      if (
        !ident(q.id) ||
        !path(q.file) ||
        !q.file.endsWith(".sql") ||
        !["table", "metric", "bar", "detail"].includes(q.kind)
      )
        fail("Query needs safe id, .sql file and supported kind.");
      text(q.title, "Query title", 120);
      text(q.explanation, "Query explanation", 1200);
      if (q.kind === "bar" && (!ident(q.x) || !ident(q.y)))
        fail("Bar query needs explicit x and y result columns.");
      if (q.formats !== undefined) {
        if (!object(q.formats)) fail("formats must be an object.");
        for (const [key, f] of Object.entries(q.formats)) {
          if (!ident(key)) fail("Invalid format column.");
          exactKeys(
            f,
            ["style", "currency", "divisor", "digits", "unit"],
            "format",
          );
          if (!["number", "currency", "percent", "text"].includes(f.style))
            fail("Unsupported format.");
          if (
            f.divisor !== undefined &&
            (!Number.isFinite(f.divisor) || f.divisor <= 0)
          )
            fail("Format divisor must be positive.");
          if (
            f.digits !== undefined &&
            (!Number.isInteger(f.digits) || f.digits < 0 || f.digits > 6)
          )
            fail("Format digits must be 0–6.");
          if (f.style === "currency" && !/^[A-Z]{3}$/.test(f.currency))
            fail("Currency needs an explicit three-letter code.");
          if (f.unit !== undefined) text(f.unit, "Format unit", 40);
        }
      }
      if (q.trace) {
        exactKeys(q.trace, ["query", "bindings"], "trace");
        if (
          !c.queries.some(
            (x) => x.id === q.trace.query && x.kind === "detail",
          ) ||
          !object(q.trace.bindings) ||
          !Object.keys(q.trace.bindings).length
        )
          fail("Trace needs a detail query and parameter-to-column bindings.");
        for (const [p, col] of Object.entries(q.trace.bindings))
          if (!c.parameters.some((x) => x.id === p && x.hidden) || !ident(col))
            fail("Trace binding needs a hidden parameter and result column.");
      }
      if (q.sourceLinks) {
        if (!object(q.sourceLinks))
          fail("sourceLinks must map result columns to source table ids.");
        for (const [col, t] of Object.entries(q.sourceLinks))
          if (!ident(col) || !c.tables.some((x) => x.id === t))
            fail("Invalid source link.");
      }
    }
    if (!Array.isArray(c.checks) || c.checks.length > 20)
      fail("checks must be an array of at most 20 reconciliation queries.");
    unique(
      c.checks.map((x) => x.id),
      "check id",
    );
    for (const x of c.checks) {
      exactKeys(x, ["id", "file", "description"], "check");
      if (!ident(x.id) || !path(x.file) || !x.file.endsWith(".sql"))
        fail("Invalid check id or path.");
      text(x.description, "Check description");
    }
    return c;
  }
  function parameters(c, input) {
    if (!object(input)) fail("Parameters must be an object.");
    for (const k of Object.keys(input))
      if (!c.parameters.some((p) => p.id === k))
        fail("Unknown parameter: " + k);
    return Object.fromEntries(
      c.parameters.map((p) => {
        const value = own(input, p.id) ? input[p.id] : p.default;
        if (
          p.type === "text" &&
          (typeof value !== "string" || value.length > 500)
        )
          fail(p.label + " must be text.");
        if (p.type === "date" && (typeof value !== "string" || !date(value)))
          fail(p.label + " must be an ISO date.");
        if (p.type === "integer" && !Number.isSafeInteger(value))
          fail(p.label + " must be an integer.");
        if (
          p.type === "real" &&
          (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        )
          fail(p.label + " must be finite.");
        if (p.choices && !p.choices.includes(value))
          fail(p.label + " is outside its allowed choices.");
        return [p.id, value];
      }),
    );
  }
  function prepare(bundle) {
    exactKeys(bundle, ["config", "sources", "sql"], "bundle");
    const c = validateConfig(bundle.config);
    if (!object(bundle.sources) || !object(bundle.sql))
      fail("Bundle needs source and SQL maps.");
    const paths = c.tables.map((t) => t.file),
      sqlPaths = [...c.queries, ...c.checks].map((q) => q.file);
    unique([...paths, ...new Set(sqlPaths)], "project path");
    if (
      Object.keys(bundle.sources).some((k) => !paths.includes(k)) ||
      Object.keys(bundle.sql).some((k) => !sqlPaths.includes(k))
    )
      fail("Bundle contains undeclared files.");
    let total = 0,
      rowCount = 0,
      cells = 0;
    const tables = [],
      checks = [];
    for (const t of c.tables) {
      const csv = bundle.sources[t.file];
      if (typeof csv !== "string") fail("Missing source " + t.file);
      total += bytes(csv);
      const parsed = parseCSV(csv);
      if (
        parsed.headers.length !== t.columns.length ||
        parsed.headers.some((h) => !t.columns.some((col) => col.source === h))
      )
        fail(
          t.file + ": source headers do not match explicit column mappings.",
        );
      cells += (parsed.records.length + 1) * parsed.headers.length;
      if (cells > LIMITS.cells) fail("Project exceeds 1,000,000 source cells.");
      const indices = t.columns.map((col) =>
        parsed.headers.indexOf(col.source),
      );
      const rows = parsed.records.map((r, i) => [
        i + 2,
        ...t.columns.map((col, j) =>
          convert(
            r[indices[j]],
            col,
            t.file + " record " + (i + 2) + " / " + col.source,
          ),
        ),
      ]);
      rowCount += rows.length;
      const keys = new Set();
      if (t.key)
        for (const r of rows) {
          const key = JSON.stringify(
            t.key.map(
              (n) => r[t.columns.findIndex((col) => col.name === n) + 1],
            ),
          );
          if (keys.has(key))
            fail(t.file + ": duplicate key " + key + " at record " + r[0]);
          keys.add(key);
        }
      tables.push({ ...t, rows, raw: parsed });
      checks.push({
        id: "source_" + t.id,
        passed: true,
        description:
          t.file +
          ": " +
          rows.length +
          " records, explicit types" +
          (t.key ? ", unique " + t.key.join(" + ") : ""),
        nulls: Object.fromEntries(
          t.columns.map((col, j) => [
            col.name,
            rows.filter((r) => r[j + 1] === null).length,
          ]),
        ),
      });
    }
    if (total > LIMITS.sourceBytes || rowCount > LIMITS.rows)
      fail("Project exceeds 6 MiB of CSV or 100,000 total records.");
    for (const r of c.relationships) {
      const from = tables.find((t) => t.id === r.from.table),
        to = tables.find((t) => t.id === r.to.table),
        a = from.columns.findIndex((x) => x.name === r.from.column) + 1,
        b = to.columns.findIndex((x) => x.name === r.to.column) + 1,
        keys = new Set(to.rows.map((row) => row[b]));
      let missing = 0;
      for (const row of from.rows) if (!keys.has(row[a])) missing++;
      if (missing && !r.allowMissing)
        fail(
          r.from.table +
            "." +
            r.from.column +
            ": " +
            missing +
            " records have no matching " +
            r.to.table +
            "." +
            r.to.column,
        );
      checks.push({
        id: "join_" + checks.length,
        passed: true,
        description:
          r.from.table +
          " → " +
          r.to.table +
          ": many-to-one, " +
          missing +
          " unmatched" +
          (r.allowMissing ? " (explicitly allowed)" : ""),
      });
    }
    for (const q of [...c.queries, ...c.checks])
      validateSQL(bundle.sql[q.file], c);
    return { config: c, tables, checks, rowCount, sourceBytes: total };
  }
  // Small lexer only enforces the read-only/single-statement boundary; SQLite parses the SQL.
  function validateSQL(sql, c) {
    if (
      typeof sql !== "string" ||
      !sql.trim() ||
      sql.length > 20000 ||
      sql.includes("\0")
    )
      fail("SQL must be 1–20,000 characters.");
    const tokens = [],
      params = new Set();
    let terminated = false;
    for (let i = 0; i < sql.length; ) {
      const ch = sql[i];
      if (/\s/.test(ch)) {
        i++;
        continue;
      }
      if (sql.slice(i, i + 2) === "--") {
        const end = sql.indexOf("\n", i + 2);
        i = end < 0 ? sql.length : end;
        continue;
      }
      if (sql.slice(i, i + 2) === "/*") {
        const end = sql.indexOf("*/", i + 2);
        if (end < 0) fail("Unclosed SQL comment.");
        i = end + 2;
        continue;
      }
      if (terminated) fail("Only one SELECT statement is allowed.");
      if (ch === ";") {
        terminated = true;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const quote = ch;
        let value = "",
          closed = false;
        i++;
        while (i < sql.length) {
          if (sql[i] === quote) {
            if (sql[i + 1] === quote) {
              value += quote;
              i += 2;
            } else {
              i++;
              closed = true;
              break;
            }
          } else value += sql[i++];
        }
        if (!closed) fail("Unclosed SQL quoted value.");
        if (quote === '"') tokens.push(value.toLowerCase());
        continue;
      }
      if (ch === "`" || ch === "[" || ch === "?" || ch === "@" || ch === "$")
        fail("Use standard quoted identifiers and named :parameters only.");
      if (ch === ":") {
        const match = /^[A-Za-z][A-Za-z0-9_]*/.exec(sql.slice(i + 1));
        if (!match) fail("Invalid SQL parameter.");
        if (!c.parameters.some((p) => p.id === match[0]))
          fail("Undeclared SQL parameter: " + match[0]);
        params.add(match[0]);
        i += match[0].length + 1;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const token = /^[A-Za-z_][A-Za-z0-9_]*/
          .exec(sql.slice(i))[0]
          .toLowerCase();
        tokens.push(token);
        i += token.length;
      } else i++;
    }
    if (!["select", "with"].includes(tokens[0]))
      fail("Only read-only SELECT / WITH queries are allowed.");
    const forbidden = new Set([
      "insert",
      "update",
      "delete",
      "drop",
      "alter",
      "create",
      "replace",
      "attach",
      "detach",
      "pragma",
      "vacuum",
      "reindex",
      "analyze",
      "begin",
      "commit",
      "rollback",
      "savepoint",
      "release",
      "load_extension",
      "writefile",
      "readfile",
    ]);
    if (
      tokens.some(
        (t) =>
          forbidden.has(t) ||
          t.startsWith("pragma_") ||
          t.startsWith("sqlite_db"),
      )
    )
      fail("SQL contains a disabled operation.");
    return [...params];
  }
  function scalar(v) {
    if (typeof v === "bigint") {
      if (
        v > BigInt(Number.MAX_SAFE_INTEGER) ||
        v < BigInt(Number.MIN_SAFE_INTEGER)
      )
        fail("Query integer exceeds JavaScript exact range.");
      return Number(v);
    }
    if (
      v === null ||
      (typeof v === "string" && v.length <= LIMITS.cell) ||
      (typeof v === "number" &&
        Number.isFinite(v) &&
        Math.abs(v) <= Number.MAX_SAFE_INTEGER)
    )
      return v;
    fail("Unsupported or oversized SQL result value.");
  }
  function result(columns, rows, q) {
    if (!columns.length || columns.length > LIMITS.columns)
      fail("Query must return 1–50 named columns.");
    unique(
      columns.map((c) => c.toLowerCase()),
      "query output column",
    );
    if (columns.some((c) => typeof c !== "string" || !c || c.length > 120))
      fail("Invalid query output column.");
    if (rows.length > LIMITS.resultRows)
      fail("Query exceeds 10,000 result rows; narrow the query.");
    rows = rows.map((row) => row.map(scalar));
    if (bytes(JSON.stringify(rows)) > LIMITS.resultBytes)
      fail("Query result exceeds 4 MiB.");
    if (q.kind === "metric" && rows.length !== 1)
      fail("Metric queries must return exactly one row.");
    for (const key of [
      ...Object.keys(q.formats ?? {}),
      ...(q.kind === "bar" ? [q.x, q.y] : []),
      ...Object.values(q.trace?.bindings ?? {}),
      ...Object.keys(q.sourceLinks ?? {}),
    ])
      if (!columns.includes(key)) fail(q.id + ": missing output column " + key);
    if (q.kind === "bar") {
      if (rows.length > 100)
        fail("Bar charts support at most 100 returned categories.");
      const yi = columns.indexOf(q.y);
      if (rows.some((r) => r[yi] !== null && typeof r[yi] !== "number"))
        fail("Bar values must be numeric or null.");
    }
    return { id: q.id, columns, rows };
  }
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (object(v))
      return (
        "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
          .join(",") +
        "}"
      );
    return JSON.stringify(v);
  }
  function validateView(view, c) {
    exactKeys(view, ["parameters", "notes", "selectedQuery"], "view");
    parameters(c, view.parameters);
    if (typeof view.notes !== "string" || view.notes.length > 4000)
      fail("Review notes must be at most 4,000 characters.");
    if (!c.queries.some((q) => q.id === view.selectedQuery))
      fail("The selected query does not exist.");
    return view;
  }
  function validateProject(p) {
    exactKeys(
      p,
      ["format", "spec", "revision", "bundle", "view"],
      "saved project",
    );
    if (
      p.format !== "data-studio" ||
      p.spec !== 1 ||
      !/^[a-f0-9]{64}$/.test(p.revision)
    )
      fail("Not a version 1 Data Studio project.");
    prepare(p.bundle);
    validateView(p.view, p.bundle.config);
    return p;
  }
  function verifyLinks(bundle, results) {
    const prepared = prepare(bundle);
    for (const result of results) {
      const q = bundle.config.queries.find((q) => q.id === result.id);
      for (const [col, id] of Object.entries(q.sourceLinks ?? {})) {
        const t = prepared.tables.find((t) => t.id === id),
          j = result.columns.indexOf(col);
        for (const row of result.rows)
          if (
            row[j] !== null &&
            (!Number.isInteger(row[j]) ||
              row[j] < 2 ||
              row[j] > t.rows.length + 1)
          )
            fail(q.id + ": source record does not exist: " + row[j]);
      }
    }
  }
  function format(value, f = {}) {
    if (value === null) return "Missing";
    if (typeof value !== "number" || f.style === "text") return String(value);
    const n = value / (f.divisor ?? 1),
      opts = {
        maximumFractionDigits: f.digits ?? 2,
        minimumFractionDigits: f.digits ?? 0,
      };
    if (f.style === "currency")
      Object.assign(opts, { style: "currency", currency: f.currency });
    if (f.style === "percent") opts.style = "percent";
    return (
      new Intl.NumberFormat("en-US", opts).format(n) +
      (f.unit ? " " + f.unit : "")
    );
  }
  function csv(columns, rows) {
    const field = (v) => {
      let s = v === null ? "" : String(v);
      if (typeof v === "string" && /^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
    };
    return (
      [columns, ...rows].map((r) => r.map(field).join(",")).join("\r\n") +
      "\r\n"
    );
  }
  return {
    LIMITS,
    parseCSV,
    convert,
    validateConfig,
    prepare,
    parameters,
    validateSQL,
    result,
    stable,
    format,
    csv,
    ident,
    path,
    date,
    scalar,
    validateView,
    validateProject,
    verifyLinks,
  };
})();

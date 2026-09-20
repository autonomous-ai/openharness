import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import "../core.js";
const C = globalThis.DataStudioCore;
const quoted = (name) => '"' + name.replaceAll('"', '""') + '"';
export const revision = (bundle) =>
  createHash("sha256").update(C.stable(bundle)).digest("hex");
export function runAnalysis(bundle, input = {}, database = ":memory:") {
  const prepared = C.prepare(bundle),
    values = C.parameters(prepared.config, input),
    db = new DatabaseSync(database, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
    });
  try {
    db.exec(
      "PRAGMA hard_heap_limit=134217728; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA journal_mode=DELETE; BEGIN",
    );
    for (const t of prepared.tables) {
      db.exec(
        "CREATE TABLE " +
          quoted(t.id) +
          " (_record INTEGER PRIMARY KEY," +
          t.columns
            .map(
              (c) =>
                quoted(c.name) +
                " " +
                (["text", "date"].includes(c.type)
                  ? "TEXT"
                  : c.type === "real"
                    ? "REAL"
                    : "INTEGER") +
                (c.nullable ? "" : " NOT NULL"),
            )
            .join(",") +
          (t.key ? ", UNIQUE (" + t.key.map(quoted).join(",") + ")" : "") +
          ") STRICT",
      );
      const insert = db.prepare(
        "INSERT INTO " +
          quoted(t.id) +
          " VALUES (" +
          Array(t.columns.length + 1)
            .fill("?")
            .join(",") +
          ")",
      );
      for (const row of t.rows) insert.run(...row);
    }
    db.exec("COMMIT; PRAGMA query_only=ON");
    const execute = (q) => {
      const sql = bundle.sql[q.file],
        names = C.validateSQL(sql, prepared.config),
        stmt = db.prepare(sql);
      stmt.setReadBigInts(true);
      const bind = Object.fromEntries(names.map((n) => [":" + n, values[n]])),
        columns = stmt.columns().map((c) => c.name),
        rows = [];
      let size = 0;
      for (const row of stmt.iterate(bind)) {
        const a = columns.map((c) => C.scalar(row[c]));
        rows.push(a);
        size += JSON.stringify(a).length;
        if (rows.length > C.LIMITS.resultRows || size > C.LIMITS.resultBytes)
          throw new Error(q.id + ": query result limit exceeded.");
      }
      return C.result(columns, rows, q);
    };
    let resultBytes = 0;
    const results = prepared.config.queries.map((q) => {
        const r = execute(q);
        resultBytes += Buffer.byteLength(JSON.stringify(r));
        if (resultBytes > C.LIMITS.totalResultBytes)
          throw new Error("Combined results exceed 8 MiB.");
        return r;
      }),
      checks = [...prepared.checks];
    for (const q of prepared.config.checks) {
      const r = execute(q);
      if (
        r.columns.length !== 1 ||
        r.columns[0] !== "violations" ||
        r.rows.length !== 1 ||
        r.rows[0][0] !== 0
      )
        throw new Error(
          q.description + ": expected exactly one violations=0 result.",
        );
      checks.push({ id: q.id, description: q.description, passed: true });
    }
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("SQLite integrity check failed.");
    checks.push({
      id: "integrity",
      description: "Native SQLite integrity_check: ok",
      passed: true,
    });
    return {
      spec: 1,
      revision: revision(bundle),
      engine:
        "Node " +
        process.versions.node +
        " / SQLite " +
        db.prepare("SELECT sqlite_version() version").get().version,
      parameters: values,
      results,
      checks,
      records: prepared.rowCount,
      sourceBytes: prepared.sourceBytes,
    };
  } finally {
    db.close();
  }
}

// Executed after the pinned SQLite and core scripts in a dedicated classic Blob worker.
// No filesystem, OPFS, origin storage, imports, extension loading, or remote query service.
self.onmessage = async ({ data }) => {
  let db;
  try {
    const C = globalThis.DataStudioCore,
      prepared = C.prepare(data.bundle),
      values = C.parameters(prepared.config, data.parameters),
      qname = (s) => '"' + s.replaceAll('"', '""') + '"';
    const sqlite = await sqlite3InitModule({
      instantiateWasm(imports, ready) {
        WebAssembly.instantiate(data.wasm, imports)
          .then(({ instance, module }) => ready(instance, module))
          .catch((error) => self.postMessage({ error: error.message }));
        return {};
      },
    });
    db = new sqlite.oo1.DB();
    db.exec(
      "PRAGMA hard_heap_limit=134217728; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN",
    );
    for (const t of prepared.tables) {
      db.exec(
        "CREATE TABLE " +
          qname(t.id) +
          " (_record INTEGER PRIMARY KEY," +
          t.columns
            .map(
              (c) =>
                qname(c.name) +
                " " +
                (["text", "date"].includes(c.type)
                  ? "TEXT"
                  : c.type === "real"
                    ? "REAL"
                    : "INTEGER") +
                (c.nullable ? "" : " NOT NULL"),
            )
            .join(",") +
          (t.key ? ", UNIQUE (" + t.key.map(qname).join(",") + ")" : "") +
          ") STRICT",
      );
      const stmt = db.prepare(
        "INSERT INTO " +
          qname(t.id) +
          " VALUES (" +
          Array(t.columns.length + 1)
            .fill("?")
            .join(",") +
          ")",
      );
      try {
        for (const row of t.rows) {
          stmt.bind(row).stepReset();
        }
      } finally {
        stmt.finalize();
      }
    }
    db.exec("COMMIT; PRAGMA query_only=ON");
    const execute = (q) => {
      const names = C.validateSQL(data.bundle.sql[q.file], prepared.config),
        stmt = db.prepare(data.bundle.sql[q.file]);
      try {
        if (!stmt.isReadOnly()) throw new Error("Query is not read-only.");
        const columns = stmt.getColumnNames(),
          rows = [];
        if (names.length)
          stmt.bind(Object.fromEntries(names.map((n) => [":" + n, values[n]])));
        let size = 0;
        while (stmt.step()) {
          const row = stmt.get([]).map(C.scalar);
          rows.push(row);
          size += JSON.stringify(row).length;
          if (rows.length > C.LIMITS.resultRows || size > C.LIMITS.resultBytes)
            throw new Error(q.id + ": query result limit exceeded.");
        }
        return C.result(columns, rows, q);
      } finally {
        stmt.finalize();
      }
    };
    let resultBytes = 0;
    const results = prepared.config.queries.map((q) => {
        const r = execute(q);
        resultBytes += new TextEncoder().encode(JSON.stringify(r)).length;
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
    if (db.selectValue("PRAGMA integrity_check") !== "ok")
      throw new Error("SQLite integrity check failed.");
    checks.push({
      id: "integrity",
      description: "Browser SQLite integrity_check: ok",
      passed: true,
    });
    const database = sqlite.capi.sqlite3_js_db_export(db);
    self.postMessage(
      {
        report: {
          spec: 1,
          engine:
            "SQLite " +
            db.selectValue("SELECT sqlite_version()") +
            " (browser)",
          parameters: values,
          results,
          checks,
          records: prepared.rowCount,
          sourceBytes: prepared.sourceBytes,
        },
        database,
      },
      [database.buffer],
    );
  } catch (error) {
    self.postMessage({ error: error.message });
  } finally {
    db?.close();
  }
};

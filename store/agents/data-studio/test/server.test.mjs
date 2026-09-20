import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, writeFile, symlink, rename } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreview } from "../template/tools/serve.mjs";
test("portable server is tokenized, read-only, loopback-only and excludes unrelated files/symlinks", async () => {
  const w = await mkdtemp(join(tmpdir(), "data-server-"));
  await cp(fileURLToPath(new URL("../template", import.meta.url)), w, {
    recursive: true,
  });
  await writeFile(join(w, "private.txt"), "must not be served");
  const server = await createPreview(w);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port,
    p = server.previewPrefix;
  try {
    const page = await fetch(base + p);
    assert.equal(page.status, 200);
    assert.match(
      page.headers.get("content-security-policy"),
      /worker-src blob:/,
    );
    assert.equal((await fetch(base + "/index.html")).status, 404);
    assert.equal((await fetch(base + p + "private.txt")).status, 404);
    assert.equal((await fetch(base + p + "analysis.json")).status, 404);
    assert.equal(
      (await fetch(base + p, { method: "POST", body: "x" })).status,
      405,
    );
    const hostStatus = await new Promise((resolve, reject) => {
      const r = request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: p,
          headers: { Host: "untrusted.example" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      r.on("error", reject);
      r.end();
    });
    assert.equal(hostStatus, 403);
    await rename(join(w, "core.js"), join(w, "saved-core.js"));
    await symlink(join(w, "private.txt"), join(w, "core.js"));
    assert.equal((await fetch(base + p + "core.js")).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

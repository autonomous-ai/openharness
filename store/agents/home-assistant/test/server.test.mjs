import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { get as httpGet } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStudio } from "../template/tools/serve.mjs";
import { savedProject } from "../template/tools/project.mjs";
import { workspace } from "./helpers.mjs";
async function studio(t) {
  const root = await workspace(t),
    server = await createStudio(root);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.stop());
  const base = "http://127.0.0.1:" + server.address().port;
  const page = await fetch(base),
    html = await page.text(),
    token = html.match(/name="habitat-token" content="([a-f0-9]+)"/)[1];
  const request = (path, body, headers = {}) =>
    fetch(base + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-habitat-token": token,
        ...(body === undefined
          ? {}
          : { origin: base, "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { root, server, base, request, page };
}
test("studio limits reads to its allowlist and rejects cross-site, foreign Host and malformed tokens", async (t) => {
  const { root, base, request, page } = await studio(t);
  await writeFile(join(root, "secrets.yaml"), "EXAMPLE PRIVATE FILE");
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await fetch(base + "/secrets.yaml")).status, 404);
  assert.equal((await fetch(base + "/api/project")).status, 403);
  assert.equal(
    (await request("project", undefined, { "x-habitat-token": "é".repeat(64) }))
      .status,
    403,
  );
  assert.equal(
    (await request("project", undefined, { origin: "https://example.test" }))
      .status,
    403,
  );
  const foreignHost = await new Promise((accept, reject) => {
    httpGet(base, { headers: { Host: "example.test" } }, (response) => {
      response.resume();
      accept(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(foreignHost, 403);
  assert.equal(
    (await request("project")).status,
    200,
    "Malformed token must not crash the server",
  );
  assert.equal((await fetch(base + "/tools/engine.py")).status, 404);
  assert.equal((await fetch(base + "/schema.mjs")).status, 200);
});
test("opening JSON is draft-only; save has conflict protection; unchecked export is blocked", async (t) => {
  const { request } = await studio(t),
    original = await (await request("project")).json();
  const source = structuredClone(original.source);
  source.project.notes = "Different draft";
  const opened = await request("open", savedProject(source));
  assert.equal(opened.status, 200);
  assert.deepEqual(
    (await (await request("project")).json()).source,
    original.source,
  );
  assert.equal(
    (
      await request("export", {
        name: "project.zip",
        revision: original.revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (await request("save", { source, baseRevision: original.revision })).status,
    200,
  );
  assert.equal(
    (
      await request("save", {
        source: original.source,
        baseRevision: original.revision,
      })
    ).status,
    409,
  );
  assert.deepEqual((await (await request("project")).json()).source, source);
  assert.equal(
    (await request("open", { ...savedProject(source), yaml: "changed" }))
      .status,
    400,
  );
  assert.equal(
    (await request("open", { data: "x".repeat(3 * 1024 * 1024) })).status,
    413,
  );
});

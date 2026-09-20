import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  cp,
  readFile,
  writeFile,
  access,
  symlink,
  mkdir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
async function workspace() {
  const p = await mkdtemp(join(tmpdir(), "data-toolchain-"));
  await cp(join(root, "template"), p, { recursive: true });
  return p;
}
const run = (script, work, extra = {}) =>
  spawnSync("/bin/sh", [join(root, script)], {
    cwd: work,
    env: {
      ...process.env,
      PATH: dirname(process.execPath) + ":" + process.env.PATH,
      HARNESS_WORKSPACE: work,
      HARNESS_DSH: "autonomous/data-studio",
      ...extra,
    },
    encoding: "utf8",
    timeout: 30000,
  });
test("manifest scripts are executable and doctor verifies real native/browser SQLite", async () => {
  for (const p of [
    "toolchain/setup.sh",
    "toolchain/doctor.sh",
    "toolchain/init-workspace.sh",
    "toolchain/node.sh",
    "skills/data/scripts/update-verdict.sh",
  ])
    await access(join(root, p), constants.X_OK);
  const r = run("toolchain/doctor.sh", root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /native SQLite/);
  assert.match(r.stdout, /pinned SQLite/);
});
test("doctor fails when both PATH and managed Node are absent", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "data-no-node-")),
    bin = join(runtime, "bin");
  await mkdir(bin);
  for (const [name, target] of [
    ["bash", "/bin/bash"],
    ["dirname", "/usr/bin/dirname"],
    ["cat", "/bin/cat"],
  ])
    await symlink(target, join(bin, name));
  const r = run("toolchain/doctor.sh", root, {
    PATH: bin,
    ADAPTER_RUNTIME_DIR: runtime,
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /miss node/);
});
test("actual initializer builds a usable source project but keeps readiness false pending browser proof", async () => {
  const w = await workspace(),
    r = run("toolchain/init-workspace.sh", w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(
    await readFile(join(w, ".harness-initialized"), "utf8"),
    /autonomous\/data-studio/,
  );
  assert.equal(
    JSON.parse(await readFile(join(w, ".harness/verdict.json"))).ready,
    false,
  );
  await access(join(w, "output/analysis.sqlite"));
  await access(join(w, "output/project.zip"));
});
test("missing browser dependency cannot turn a native build into ready", async () => {
  const w = await workspace(),
    r = run("skills/data/scripts/update-verdict.sh", w, {
      PLAYWRIGHT_MODULE: join(w, "missing-playwright.mjs"),
    });
  assert.equal(r.status, 1, r.stderr);
  const v = JSON.parse(await readFile(join(w, ".harness/verdict.json")));
  assert.equal(v.ready, false);
  assert.match(v.findings[0].message, /Playwright is missing/);
});
test("invalid input clears readiness and keeps the previous useful output", async () => {
  const w = await workspace();
  assert.equal(run("toolchain/init-workspace.sh", w).status, 0);
  const zip = await readFile(join(w, "output/project.zip"));
  await writeFile(
    join(w, ".harness/verdict.json"),
    JSON.stringify({ spec: 1, ready: true }),
  );
  await writeFile(join(w, "sources/products.csv"), "wrong,header\nx,y\n");
  assert.equal(run("skills/data/scripts/update-verdict.sh", w).status, 1);
  assert.equal(
    JSON.parse(await readFile(join(w, ".harness/verdict.json"))).ready,
    false,
  );
  assert.deepEqual(await readFile(join(w, "output/project.zip")), zip);
});

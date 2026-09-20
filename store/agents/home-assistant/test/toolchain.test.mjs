import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile, writeFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { packageRoot, workspace, shortSource } from "./helpers.mjs";
import { engine } from "../template/tools/calculate.mjs";

test("manifest entrypoints exist and the native runtime stays outside the copyable template", async () => {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "harness.json")),
  );
  for (const name of [
    manifest.workspace.init,
    manifest.toolchain.setup,
    manifest.toolchain.doctor,
    manifest.viewer.command,
    "skills/home-assistant/scripts/build-automations.sh",
  ])
    await access(join(packageRoot, name), constants.X_OK);
  assert.equal(manifest.viewer.use, undefined);
  assert.equal(manifest.viewer.url, "http://127.0.0.1:${port}/");
  assert.ok(
    !(await readdir(join(packageRoot, "template/tools"))).includes(".venv"),
  );
});
test("legacy source cannot silently use the retired subset model to claim readiness", async (t) => {
  const root = await workspace(t);
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, "skills/home-assistant/scripts/build.mjs")],
    {
      cwd: join(root, "tools"),
      env: { ...process.env, HARNESS_WORKSPACE: join(root, "tools") },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fresh Habitat workspace/);
});
test("abnormal child exits cannot be accepted even after printing plausible JSON", async (t) => {
  const root = await workspace(t),
    fake = join(root, "test-python");
  const result = {
    scenario: "presence",
    engine: { version: "2026.9.3" },
    checks: [],
    traces: [],
    rules: [],
  };
  await writeFile(
    fake,
    "#!" +
      process.execPath +
      "\nprocess.stdout.write(" +
      JSON.stringify(JSON.stringify(result)) +
      ");process.exit(139);\n",
    { mode: 0o700 },
  );
  await assert.rejects(
    engine(root, shortSource(), "presence", { python: fake }),
    /did not complete/,
  );
  assert.deepEqual(await readdir(join(root, ".harness/jobs")), []);
});

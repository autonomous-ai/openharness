import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { workspace, readJSON, shortSource } from "./helpers.mjs";
import {
  readSource,
  revision,
  snapshot,
  runtimeRevision,
  saveSource,
  savedProject,
  openProject,
  safeFile,
  metadata,
  lock,
  json,
  sha,
} from "../template/tools/project.mjs";
import { restore } from "../template/tools/restore.mjs";
import { makeDelivery } from "../template/tools/delivery.mjs";
import { zip, unzip } from "../template/tools/archive.mjs";

test("draft checksums bind all source fields; malformed UI structures cannot replace the draft", () => {
  const source = shortSource(),
    saved = savedProject(source);
  assert.deepEqual(openProject(saved), source);
  for (const mutate of [
    (s) => (s.project.notes = "different"),
    (s) => (s.yaml += "\n"),
    (s) => s.project.scenarios[0].until++,
  ]) {
    const other = structuredClone(saved);
    mutate(other);
    assert.throws(() => openProject(other), /checksum/);
  }
  for (const mutate of [
    (s) => (s.project.entities[0] = null),
    (s) => (s.project.scenarios[0].expect.calls[0].between = null),
    (s) => (s.project.scenarios[0].steps = null),
  ]) {
    const other = structuredClone(source);
    mutate(other);
    assert.throws(() => savedProject(other));
  }
});
test("explicit save preserves old source and rejects a conflicting external edit", async (t) => {
  const root = await workspace(t),
    before = await readSource(root),
    candidate = structuredClone(before);
  candidate.project.notes = "A new decision";
  const result = await saveSource(root, candidate, revision(before));
  assert.deepEqual(await readSource(root), candidate);
  assert.deepEqual(
    await readJSON(join(root, ".harness", result.history, "project.json")),
    before.project,
  );
  assert.equal(
    (await readJSON(join(root, ".harness/verdict.json"))).ready,
    false,
  );
  await assert.rejects(
    saveSource(root, before, revision(before)),
    /workspace changed/,
  );
  assert.deepEqual(await readSource(root), candidate);
});
test("restore refuses existing work, verifies checksums and includes a self-contained runtime", async (t) => {
  const root = await workspace(t),
    source = await readSource(root),
    file = join(root, "saved.habitat.json"),
    target = join(root, "reopened");
  await writeFile(file, json(savedProject(source)));
  await restore(file, target, root);
  assert.deepEqual(await readSource(target), source);
  assert.equal(
    runtimeRevision(await snapshot(target)),
    runtimeRevision(await snapshot(root)),
  );
  await assert.rejects(restore(file, target, root), /new or empty/);
  const corrupted = savedProject(source);
  corrupted.yaml += "\n";
  await writeFile(file, json(corrupted));
  await assert.rejects(restore(file, join(root, "invalid"), root), /checksum/);
});
test("source, metadata and output ancestor symlinks cannot escape the workspace", async (t) => {
  const root = await workspace(t),
    outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "private");
  await symlink(outside, join(root, "link"));
  await assert.rejects(safeFile(root, "link/secret"), /symlink/);
  await assert.rejects(safeFile(root, "../secret"), /Unsafe/);
  await symlink(outside, join(root, ".harness"));
  await assert.rejects(metadata(root), /real workspace directory/);
  assert.deepEqual(await readdir(outside), ["secret"]);
});
test("the workspace lock prevents overlapping mutation", async (t) => {
  const root = await workspace(t);
  await lock(root, async () =>
    assert.rejects(
      lock(root, async () => {}),
      /Another save\/build/,
    ),
  );
  await lock(root, async () => {});
});
test("portable archives allow only named project files and escape report text", async (t) => {
  const root = await workspace(t),
    source = await readSource(root),
    runtime = await snapshot(root);
  source.project.title = "</script><img src=x onerror=alert(1)>";
  await writeFile(join(root, "secrets.yaml"), "NOT FOR EXPORT");
  const result = {
    complete: true,
    passed: true,
    sourceRevision: revision(source),
    runtimeRevision: runtimeRevision(runtime),
    engine: "2026.9.3",
    at: "2026-09-20T00:00:00Z",
    results: [],
  };
  const delivery = makeDelivery(source, result, runtime),
    file = (name) => delivery.find((f) => f.name === name).bytes;
  const archive = unzip(file("project.zip"));
  assert.equal(archive.get("automations.yaml").toString(), source.yaml);
  assert.equal(archive.has("secrets.yaml"), false);
  assert.equal(
    [...archive.keys()].some(
      (n) => n.includes(".harness") || n.includes("node_modules"),
    ),
    false,
  );
  assert.ok(!file("report.html").toString().includes("<img"));
  assert.ok(file("report.html").toString().includes("&lt;img"));
  for (const entry of JSON.parse(file("manifest.json")).files)
    assert.equal(sha(file(entry.name)), entry.sha256);
  assert.throws(
    () => makeDelivery(source, { ...result, complete: false }, runtime),
    /Run all/,
  );
  assert.throws(
    () => makeDelivery(source, { ...result, sourceRevision: "stale" }, runtime),
    /Run all/,
  );
  const bytes = zip([{ name: "safe.txt", bytes: Buffer.from("content") }]);
  const corrupt = Buffer.from(bytes);
  corrupt[38] ^= 1;
  assert.throws(() => unzip(corrupt));
});

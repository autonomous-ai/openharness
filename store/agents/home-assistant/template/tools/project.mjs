import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  lstat,
  realpath,
  rename,
  mkdtemp,
  rm,
  readdir,
} from "node:fs/promises";
import { join, dirname, sep } from "node:path";
import { checkDraft } from "./schema.mjs";
export const CORE_VERSION = "2026.9.3";
export const SOURCE_NAMES = ["project.json", "automations.yaml"];
export const RUNTIME_NAMES = [
  ".gitignore",
  "index.html",
  "studio.mjs",
  "style.css",
  "brand.svg",
  "PROJECT.md",
  "LICENSE",
  "tools/engine.py",
  "tools/pyproject.toml",
  "tools/uv.lock",
  "tools/setup.sh",
  "tools/project.mjs",
  "tools/schema.mjs",
  "tools/calculate.mjs",
  "tools/archive.mjs",
  "tools/delivery.mjs",
  "tools/build.mjs",
  "tools/serve.mjs",
  "tools/restore.mjs",
  "tools/proof.mjs",
];
export const json = (value) => JSON.stringify(value, null, 2) + "\n";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function checkSource(value) {
  checkDraft(value);
  return { project: structuredClone(value.project), yaml: value.yaml };
}
export const revision = (value) => sha(JSON.stringify(checkSource(value)));
export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
export async function safeFile(root, name, limit = 4 * 1024 * 1024) {
  if (
    !/^[a-zA-Z0-9.][a-zA-Z0-9._/-]*$/.test(name) ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Unsafe project path.");
  let path = root;
  for (const part of name.split("/")) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Project files may not be symlinks: " + name);
  }
  const info = await lstat(path),
    actual = await realpath(path);
  if (
    !info.isFile() ||
    info.size > limit ||
    !actual.startsWith((await realpath(root)) + sep)
  )
    throw new Error("File is unavailable or too large: " + name);
  return readFile(path);
}
export async function readSource(root) {
  return checkSource({
    project: JSON.parse(await safeFile(root, "project.json")),
    yaml: (await safeFile(root, "automations.yaml")).toString("utf8"),
  });
}
export async function snapshot(root, names = RUNTIME_NAMES) {
  const files = [];
  for (const name of names)
    files.push({ name, bytes: await safeFile(root, name) });
  if (files.reduce((n, f) => n + f.bytes.length, 0) > 16 * 1024 * 1024)
    throw new Error("Runtime files exceed 16 MiB.");
  return files;
}
export async function unchanged(root, files) {
  for (const file of files)
    if (sha(await safeFile(root, file.name)) !== sha(file.bytes))
      throw new Error(
        "A source/runtime file changed during testing: " +
          file.name +
          ". Run the tests again.",
      );
}
export function runtimeRevision(files) {
  return sha(
    JSON.stringify(files.map((f) => ({ name: f.name, sha256: sha(f.bytes) }))),
  );
}
export async function metadata(root) {
  const dir = join(root, ".harness");
  if (await exists(dir)) {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(".harness must be a real workspace directory.");
  } else await mkdir(dir);
  for (const name of ["history", "jobs"]) {
    const path = join(dir, name);
    if (await exists(path)) {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(".harness/" + name + " must not be a symlink.");
    } else await mkdir(path);
  }
  return dir;
}
export async function atomic(path, bytes) {
  if ((await exists(path)) && (await lstat(path)).isSymbolicLink())
    throw new Error("Refusing to replace a symlink.");
  const temporary = path + "." + randomUUID() + ".tmp";
  await writeFile(temporary, bytes, { flag: "wx" });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function verdict(root, summary, extra = {}) {
  const dir = await metadata(root);
  await atomic(
    join(dir, "verdict.json"),
    json({
      spec: 1,
      ready: false,
      summary,
      findings: [],
      artifact: "index.html",
      updatedAt: new Date().toISOString(),
      ...extra,
    }),
  );
}
export async function lock(root, action) {
  const dir = await metadata(root),
    target = join(dir, "habitat.lock");
  try {
    await mkdir(target);
  } catch (e) {
    if (e.code === "EEXIST")
      throw new Error(
        "Another save/build owns .harness/habitat.lock. Verify its process has stopped before removing a stale lock.",
      );
    throw e;
  }
  try {
    await writeFile(
      join(target, "owner.json"),
      json({ pid: process.pid, at: new Date().toISOString() }),
    );
    return await action(dir);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}
export async function saveSource(root, candidate, baseRevision) {
  const source = checkSource(candidate);
  return lock(root, async (dir) => {
    const before = await readSource(root);
    if (revision(before) !== baseRevision) {
      const error = new Error(
        "The workspace changed. Download your draft or reload the new source before saving.",
      );
      error.status = 409;
      throw error;
    }
    const history = await mkdtemp(join(dir, "history/save-"));
    const old = await snapshot(root, SOURCE_NAMES);
    for (const file of old)
      await writeFile(join(history, file.name), file.bytes);
    await verdict(
      root,
      "Source saved as a draft; run all scenarios before delivery.",
    );
    try {
      await atomic(join(root, "project.json"), json(source.project));
      await atomic(join(root, "automations.yaml"), source.yaml);
    } catch (error) {
      for (const file of old) await atomic(join(root, file.name), file.bytes);
      throw error;
    }
    return {
      source,
      revision: revision(source),
      history: history.split(sep).slice(-2).join("/"),
    };
  });
}
export function savedProject(source) {
  source = checkSource(source);
  return {
    format: "habitat",
    spec: 1,
    engine: CORE_VERSION,
    revision: revision(source),
    ...source,
  };
}
export function openProject(value) {
  if (
    !value ||
    value.format !== "habitat" ||
    value.spec !== 1 ||
    value.engine !== CORE_VERSION
  )
    throw new Error("Unsupported Habitat project or engine version.");
  const source = checkSource(value);
  if (revision(source) !== value.revision)
    throw new Error("Saved project checksum does not match its contents.");
  return source;
}
export async function emptyDirectory(root) {
  if (await exists(root)) {
    const info = await lstat(root);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (await readdir(root)).length
    )
      throw new Error("Restore only into a new or empty directory.");
  } else await mkdir(root, { recursive: true });
}

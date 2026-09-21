import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  lstat,
  realpath,
  rename,
  copyFile,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, basename, sep } from "node:path";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = (value) => JSON.stringify(value, null, 2) + "\n";
export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function source(workspace, name) {
  let path = workspace;
  for (const component of name.split("/")) {
    path = join(path, component);
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Source symlinks are not portable: " + name);
  }
  const info = await lstat(path);
  if (!info.isFile() || info.size > 32 * 1024 * 1024)
    throw new Error(
      "Source must be a regular file no larger than 32 MiB: " + name,
    );
  if (!(await realpath(path)).startsWith((await realpath(workspace)) + sep))
    throw new Error("Source escapes workspace: " + name);
  return readFile(path);
}
export async function snapshot(workspace, names) {
  const files = [];
  let total = 0;
  for (const name of names) {
    const bytes = await source(workspace, name);
    total += bytes.length;
    files.push({ name, bytes });
  }
  if (total > 64 * 1024 * 1024) throw new Error("Sources exceed 64 MiB.");
  return files;
}
export async function unchanged(workspace, files) {
  for (const file of files)
    if (sha(await source(workspace, file.name)) !== sha(file.bytes))
      throw new Error(
        "Source changed during build; rebuild the saved project: " + file.name,
      );
}
export async function save(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
export async function atomic(path, bytes) {
  const temp = path + "." + process.pid + ".tmp";
  await writeFile(temp, bytes);
  await rename(temp, path);
}
export async function publish(workspace, state, stage, names) {
  if (
    (await exists(join(state, "history"))) &&
    (await lstat(join(state, "history"))).isSymbolicLink()
  )
    throw new Error("History must not be a symlink.");
  const history = join(state, "history", basename(stage));
  await mkdir(history, { recursive: true });
  const saved = [],
    installed = [];
  try {
    if (await exists(join(state, "analysis-result.json")))
      await copyFile(
        join(state, "analysis-result.json"),
        join(history, "analysis-result.json"),
      );
    for (const name of names) {
      if (await exists(join(workspace, name))) {
        await rename(join(workspace, name), join(history, name));
        saved.push(name);
      }
      await rename(join(stage, name), join(workspace, name));
      installed.push(name);
    }
    return history;
  } catch (error) {
    const failures = [];
    for (const name of installed.reverse())
      try {
        await rename(join(workspace, name), join(stage, name));
      } catch (error) {
        failures.push(error.message);
      }
    for (const name of saved.reverse())
      try {
        await rename(join(history, name), join(workspace, name));
      } catch (error) {
        failures.push(error.message);
      }
    if (failures.length)
      throw new Error(
        "Publication failed; recover saved artifacts from " +
          history +
          ": " +
          failures.join("; "),
      );
    throw error;
  }
}
export async function transaction(workspace, run) {
  const state = join(workspace, ".harness");
  if ((await exists(state)) && (await lstat(state)).isSymbolicLink())
    throw new Error(".harness must not be a symlink.");
  await mkdir(state, { recursive: true });
  const lock = join(state, "data-build.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another build owns .harness/data-build.lock. Confirm its process has stopped before removing a stale lock.",
      );
    throw error;
  }
  let stage;
  const verdict = (value) =>
    atomic(
      join(state, "verdict.json"),
      json({
        spec: 1,
        ready: false,
        findings: [],
        artifact: null,
        ...value,
        updatedAt: new Date().toISOString(),
      }),
    );
  try {
    await writeFile(
      join(lock, "owner.json"),
      json({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await verdict({
      summary: "Building typed data and checking saved analysis rules",
    });
    stage = await mkdtemp(join(state, "data-"));
    return await run({ state, stage, verdict });
  } catch (error) {
    await verdict({
      summary: "Data Studio build failed",
      findings: [{ severity: "error", kind: "build", message: error.message }],
    });
    throw error;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

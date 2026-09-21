// Restore a downloaded JSON project into a NEW or empty directory. Never overwrite work.
import {
  mkdir,
  readdir,
  writeFile,
  readFile,
  copyFile,
  lstat,
  realpath,
} from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeFiles } from "./build.mjs";
import { revision } from "./engine-node.mjs";
import "../core.js";
const C = globalThis.DataStudioCore;
export async function restore(projectFile, target) {
  const info = await lstat(projectFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 12 * 1024 * 1024)
    throw new Error("Project must be a regular JSON file at most 12 MiB.");
  const p = C.validateProject(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readFile(projectFile),
      ),
    ),
  );
  if (revision(p.bundle) !== p.revision)
    throw new Error(
      "Project revision checksum does not match its sources and queries.",
    );
  const output = resolve(target),
    root = fileURLToPath(new URL("../", import.meta.url));
  try {
    const info = await lstat(output);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await readdir(output)).length
    )
      throw new Error("Restore target must be a new or empty directory.");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await mkdir(output, { recursive: true });
  const files = {
    "analysis.json": JSON.stringify(p.bundle.config, null, 2) + "\n",
    "view.json": JSON.stringify(p.view, null, 2) + "\n",
    ...p.bundle.sources,
    ...p.bundle.sql,
  };
  if (Object.keys(files).some((n) => !C.path(n) || runtimeFiles.includes(n)))
    throw new Error("Project path conflicts with runtime files.");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await writeFile(join(output, name), text, { flag: "wx" });
  }
  for (const name of runtimeFiles) {
    await mkdir(dirname(join(output, name)), { recursive: true });
    await copyFile(join(root, name), join(output, name), 1);
  }
  return {
    workspace: output,
    revision: p.revision,
    next: "Run node tools/build.mjs in the restored directory.",
  };
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 4)
      throw new Error(
        "Usage: node tools/restore.mjs saved.data-studio.json NEW_DIRECTORY",
      );
    console.log(
      JSON.stringify(await restore(process.argv[2], process.argv[3]), null, 2),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

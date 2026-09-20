import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openProject, json, snapshot, emptyDirectory } from "./project.mjs";

export async function restore(
  file,
  target,
  runtimeRoot = fileURLToPath(new URL("../", import.meta.url)),
) {
  const bytes = await readFile(file);
  if (bytes.length > 3 * 1024 * 1024)
    throw new Error("Saved project exceeds 3 MiB.");
  const source = openProject(JSON.parse(bytes)),
    runtime = await snapshot(runtimeRoot);
  const root = resolve(target);
  await emptyDirectory(root);
  for (const item of runtime) {
    const path = join(root, item.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, item.bytes, { flag: "wx" });
  }
  await writeFile(join(root, "project.json"), json(source.project), {
    flag: "wx",
  });
  await writeFile(join(root, "automations.yaml"), source.yaml, { flag: "wx" });
  return root;
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  try {
    if (!process.argv[2] || !process.argv[3])
      throw new Error(
        "Usage: node tools/restore.mjs saved.habitat.json NEW_DIRECTORY",
      );
    console.log(
      "Restored editable source to " +
        (await restore(process.argv[2], process.argv[3])) +
        ". Run setup and build before relying on its results.",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

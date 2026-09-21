import {
  writeFile,
  mkdtemp,
  rename,
  rm,
  realpath,
  lstat,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { calculate } from "./calculate.mjs";
import { makeDelivery } from "./delivery.mjs";
import {
  readSource,
  revision,
  snapshot,
  unchanged,
  json,
  lock,
  verdict,
  exists,
  atomic,
  safeFile,
} from "./project.mjs";

export async function build(workspace, options = {}) {
  const root = await realpath(resolve(workspace));
  return lock(root, async (state) => {
    await verdict(
      root,
      "Running actual Home Assistant scenarios; no home is connected.",
    );
    try {
      const source = await readSource(root),
        inputs = await snapshot(root, ["project.json", "automations.yaml"]),
        runtime = await snapshot(root);
      const result = await calculate(root, source, { ...options, runtime });
      await atomic(join(state, "last-run.json"), json(result));
      await unchanged(root, inputs);
      await unchanged(root, runtime);
      if (!result.passed)
        throw new Error(
          "Scenario/coverage checks failed: " +
            [
              ...result.results.filter((r) => !r.passed),
              ...result.suiteChecks.filter((c) => !c.passed),
            ]
              .map((r) => r.name)
              .join(", ") +
            ". Inspect .harness/last-run.json; previous delivery is unchanged.",
        );
      const files = makeDelivery(source, result, runtime);
      const stage = await mkdtemp(join(state, "delivery-"));
      const output = join(root, "output");
      let previous;
      try {
        for (const file of files)
          await writeFile(join(stage, file.name), file.bytes);
        if (await exists(output)) {
          const info = await lstat(output);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error(
              "Refusing to replace a non-directory/symlink output.",
            );
          const manifest = JSON.parse(
            await safeFile(root, "output/manifest.json"),
          );
          if (manifest.harness !== "autonomous/home-assistant")
            throw new Error(
              "The output folder is not a Habitat delivery. Keep it and choose a fresh workspace.",
            );
          previous = join(state, "history", "delivery-" + Date.now());
          await rename(output, previous);
        }
        try {
          await rename(stage, output);
        } catch (error) {
          if (previous) await rename(previous, output);
          throw error;
        }
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
      await verdict(
        root,
        "All " +
          result.results.length +
          " Core scenarios passed. Browser review is still required.",
        {
          findings: [
            { severity: "info", kind: "scope", message: result.scope },
          ],
          sourceRevision: revision(source),
        },
      );
      return result;
    } catch (error) {
      await verdict(
        root,
        "Home Assistant checks failed; last delivery preserved.",
        {
          findings: [
            { severity: "error", kind: "engine", message: error.message },
          ],
        },
      );
      throw error;
    }
  });
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await build(process.argv[2] || process.cwd(), {
      progress: (p) =>
        console.log("test " + (p.index + 1) + "/" + p.total + " · " + p.name),
    });
    console.log(
      "ok   Home Assistant Core " +
        result.engine +
        " · " +
        result.results.length +
        " scenarios · output/project.zip",
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// Compatibility entrypoint. The retired subset model cannot produce a verdict.
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
try {
  const root = resolve(process.env.HARNESS_WORKSPACE || process.cwd());
  process.env.HA_DSH_DIR ||= fileURLToPath(
    new URL("../../..", import.meta.url),
  );
  const { build } = await import(pathToFileURL(root + "/tools/build.mjs"));
  const result = await build(root, {
    progress: (p) => console.log(`test ${p.index + 1}/${p.total} · ${p.name}`),
  });
  console.log(
    `ok   ${result.results.length} native scenarios; browser check still required`,
  );
} catch (error) {
  console.error(
    error.message +
      "\nKeep legacy YAML and create a fresh Habitat workspace if the runtime files are missing.",
  );
  process.exitCode = 1;
}

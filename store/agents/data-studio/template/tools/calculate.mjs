// Run in a bounded child process; an expensive query cannot hang the parent build.
import { readFile, writeFile } from "node:fs/promises";
import { runAnalysis } from "./engine-node.mjs";
const [input, output, database] = process.argv.slice(2);
try {
  const { bundle, parameters } = JSON.parse(await readFile(input, "utf8"));
  await writeFile(
    output,
    JSON.stringify(runAnalysis(bundle, parameters, database)),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

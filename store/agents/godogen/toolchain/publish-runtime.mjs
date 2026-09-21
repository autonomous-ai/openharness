#!/usr/bin/env node
// The Babylon/Claude subset of Godogen's publish.sh, expressed with Node's standard library so
// installing the game does not require rsync or Python. The upstream checkout remains untouched.
// Godogen is MIT licensed, copyright 2026 Alex Ermolov. See LICENSE-godogen.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "upstream"),
  target = join(root, "runtime");
const render = (value, replacements) =>
  Object.entries(replacements).reduce(
    (text, [key, replacement]) =>
      text.replaceAll("$" + "{" + key + "}", replacement),
    value,
  );
const replacements = {
  AGENT_NAME: "Claude",
  ASSET_GEN_SKILL_DIR: ".claude/skills/asset-gen",
  ASSET_SKILL_COMMAND: "/asset-gen",
  RUNTIME_ASSET_DIR: "src/assets",
};
if (!existsSync(join(source, "asset-gen/SKILL.md")))
  throw new Error("Pinned Godogen checkout is missing");
const skills = join(target, ".claude/skills");
rmSync(skills, { recursive: true, force: true });
mkdirSync(skills, { recursive: true });
cpSync(join(source, "asset-gen"), join(skills, "asset-gen"), {
  recursive: true,
  filter: (path) => !path.split("/").includes("__pycache__"),
});
function renderTree(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) renderTree(path);
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      let original;
      try {
        original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      const result = render(original, replacements);
      if (result !== original) writeFileSync(path, result);
    }
  }
}
renderTree(skills);
writeFileSync(
  join(target, "CLAUDE.md"),
  render(readFileSync(join(source, "prompts/runtime.md"), "utf8"), {
    ENGINE_NAME: "Babylon.js",
    ENGINE_GUIDE_FILE: "babylon.md",
    ASSET_SKILL_COMMAND: "/asset-gen",
  }),
);
cpSync(join(source, "engines/babylon.md"), join(target, "babylon.md"));
console.log("ok   Godogen Babylon.js workflow and asset-generation skill");

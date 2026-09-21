#!/usr/bin/env node
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.HARNESS_DSH_DIR;
if (!root) throw new Error("HARNESS_DSH_DIR is required");
mkdirSync(".harness", { recursive: true });
if (!existsSync("node_modules"))
  symlinkSync(join(root, "node_modules"), "node_modules", "dir");
if (!existsSync(".harness/progress.json"))
  writeFileSync(
    ".harness/progress.json",
    JSON.stringify({ phase: "world", message: "" }),
  );
writeFileSync(
  ".harness/verdict.json",
  JSON.stringify({
    spec: 1,
    ready: false,
    summary: "Opening your first world",
    findings: [],
    artifact: "index.html",
    updatedAt: new Date().toISOString(),
  }),
);

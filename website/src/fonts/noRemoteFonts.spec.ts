import fs from "fs";
import path from "path";

// next/font/google downloads at build time, so a Google hiccup fails `next build`; fonts are vendored instead.
// The module name is built so this file does not match its own text.
const GOOGLE_FONTS = ["next/font", "google"].join("/");
const IMPORTS = new RegExp(`["']${GOOGLE_FONTS}["']`);
const SRC = path.resolve(__dirname, "..");
const SOURCE = /\.(ts|tsx|js|mjs|css)$/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return SOURCE.test(entry.name) ? [full] : [];
  });
}

describe("fonts", () => {
  it("no source file loads fonts from Google", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => IMPORTS.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders, `${GOOGLE_FONTS} imported in: ${offenders.join(", ")}`).toEqual([]);
  });
});

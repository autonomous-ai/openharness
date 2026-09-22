import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { randomBytes } from "node:crypto";

const inside = (root, path) => path === root || path.startsWith(root + sep);
const validId = (id) => typeof id === "string" && /^[a-f0-9]{24}$/.test(id);
const boundedObject = (value, limit, name) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be a JSON object`);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit) throw new Error(`${name} is too large`);
  return JSON.parse(json);
};

/** Saved moments belong to the workspace; temporary preview pruning never deletes them. */
export function playtestStore(workspace) {
  workspace = realpathSync(workspace);
  function folder(create = false) {
    let current = workspace;
    for (const name of ["out", "playtests"]) {
      current = join(current, name);
      if (create && !existsSync(current)) mkdirSync(current);
      if (!existsSync(current)) return null;
      if (!inside(workspace, realpathSync(current)))
        throw new Error("Playtest folder must stay in the project");
    }
    return current;
  }
  function read(id) {
    if (!validId(id)) throw new Error("Invalid playtest moment");
    const root = folder();
    if (!root) throw new Error("Playtest moment not found");
    const dir = realpathSync(join(root, id));
    if (!inside(realpathSync(root), dir))
      throw new Error("Invalid playtest folder");
    const file = realpathSync(join(dir, "moment.json"));
    if (!inside(dir, file) || statSync(file).size > 100_000)
      throw new Error("Invalid playtest record");
    const moment = JSON.parse(readFileSync(file, "utf8"));
    if (
      moment.spec !== 1 ||
      moment.id !== id ||
      !/^[a-f0-9]{14}$/.test(moment.revision?.id)
    )
      throw new Error("Invalid playtest record");
    const game = realpathSync(join(dir, "game"));
    if (!inside(dir, game)) throw new Error("Invalid saved game folder");
    return { moment, dir, game };
  }
  const summary = (moment) => ({
    id: moment.id,
    at: moment.at,
    kind: moment.kind,
    note: moment.note,
    revision: moment.revision,
    stats: moment.snapshot.stats,
    image: moment.image ? `/api/playtests/${moment.id}/image` : null,
    path: `out/playtests/${moment.id}/moment.json`,
  });
  return {
    read,
    list() {
      const root = folder();
      if (!root) return [];
      return readdirSync(root)
        .filter(validId)
        .flatMap((id) => {
          try {
            return [summary(read(id).moment)];
          } catch {
            return [];
          }
        })
        .sort((a, b) => b.at.localeCompare(a.at));
    },
    save(revision, body) {
      if (!["keep", "change", "explore"].includes(body.kind))
        throw new Error("Choose a moment type");
      if (typeof body.note !== "string" || body.note.trim().length > 2000)
        throw new Error("Notes can contain up to 2,000 characters");
      const snapshot = {
        mode: body.snapshot?.mode || "play",
        state: boundedObject(body.snapshot?.state, 65536, "Game state"),
        stats: boundedObject(
          body.snapshot?.stats || {},
          8192,
          "Game statistics",
        ),
      };
      if (!["play", "explore"].includes(snapshot.mode))
        throw new Error("Invalid preview mode");
      let screenshot;
      if (body.image != null) {
        if (
          typeof body.image !== "string" ||
          !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.image)
        )
          throw new Error("Screenshot must be a JPEG image");
        screenshot = Buffer.from(body.image.split(",")[1], "base64");
        if (
          screenshot.length > 500_000 ||
          screenshot[0] !== 255 ||
          screenshot[1] !== 216
        )
          throw new Error("Invalid or oversized screenshot");
      }
      // Frozen builds must be self contained, including public assets.
      let bytes = 0,
        files = 0;
      function checkTree(path) {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink())
          throw new Error("Saved game assets cannot be symbolic links");
        if (stat.isDirectory())
          for (const name of readdirSync(path)) checkTree(join(path, name));
        else if (stat.isFile()) {
          bytes += stat.size;
          if (++files > 10000 || bytes > 512 * 1024 * 1024)
            throw new Error("Saved build exceeds 512 MB or 10,000 files");
        } else throw new Error("Unsupported saved game asset");
      }
      checkTree(revision.dir);
      const root = folder(true),
        id = randomBytes(12).toString("hex");
      const staging = join(root, ".saving-" + id),
        target = join(root, id);
      const original = revision.originalRevision || revision;
      const moment = {
        spec: 1,
        id,
        at: new Date().toISOString(),
        kind: body.kind,
        note: body.note.trim(),
        revision: {
          id: original.id,
          number: original.number,
          at: original.at,
          label: original.label,
          project: original.project,
        },
        snapshot,
        image: screenshot ? "screenshot.jpg" : null,
      };
      try {
        mkdirSync(staging);
        cpSync(revision.dir, join(staging, "game"), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        if (screenshot)
          writeFileSync(join(staging, "screenshot.jpg"), screenshot);
        writeFileSync(
          join(staging, "moment.json"),
          JSON.stringify(moment) + "\n",
        );
        renameSync(staging, target);
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
      return summary(moment);
    },
  };
}

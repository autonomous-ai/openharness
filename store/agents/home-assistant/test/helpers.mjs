import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export async function workspace(t, fixture) {
  const root = await mkdtemp(join(tmpdir(), "habitat-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(packageRoot, "template"), root, { recursive: true });
  if (fixture)
    await cp(join(packageRoot, "test/fixtures", fixture), root, {
      recursive: true,
    });
  return root;
}
export const readJSON = async (path) =>
  JSON.parse(await readFile(path, "utf8"));
export function shortSource() {
  return {
    project: {
      spec: 1,
      title: "A reading light",
      brief: "Turn on after sustained presence; finish with a timed turn-off.",
      example: true,
      timezone: "UTC",
      latitude: 0,
      longitude: 0,
      entities: [
        {
          id: "binary_sensor.reading",
          name: "Reading presence",
          kind: "state",
          state: "off",
        },
        {
          id: "light.reading",
          name: "Reading light",
          kind: "light",
          state: "off",
        },
      ],
      scenarios: [
        {
          id: "presence",
          name: "Sustained presence",
          why: "Native hold and chained delay must use the same elapsed clock.",
          start: "2026-04-06T12:00:00Z",
          steps: [{ at: 0, entity: "binary_sensor.reading", state: "on" }],
          until: 3,
          expect: {
            calls: [
              {
                service: "light.turn_on",
                entities: ["light.reading"],
                between: [1, 1.5],
              },
              {
                service: "light.turn_off",
                entities: ["light.reading"],
                between: [2, 2.6],
              },
            ],
            states: { "light.reading": { state: "off" } },
          },
        },
      ],
    },
    yaml: JSON.stringify([
      {
        id: "reading",
        alias: "Reading light",
        initial_state: false,
        mode: "restart",
        triggers: [
          {
            trigger: "state",
            entity_id: "binary_sensor.reading",
            to: "on",
            for: { seconds: 1 },
          },
        ],
        actions: [
          { action: "light.turn_on", target: { entity_id: "light.reading" } },
          { delay: { seconds: 1 } },
          { action: "light.turn_off", target: { entity_id: "light.reading" } },
        ],
      },
    ]),
  };
}

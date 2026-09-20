import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { workspace, shortSource, readJSON, packageRoot } from "./helpers.mjs";
import { engine, calculate } from "../template/tools/calculate.mjs";
import { build } from "../template/tools/build.mjs";
import { readSource, json } from "../template/tools/project.mjs";
const native = { skip: !process.env.HA_PYTHON, timeout: 180000 };
const options = { python: process.env.HA_PYTHON };

test(
  "native Core: hallway and distinct laundry cases execute cleanly with every rule covered",
  native,
  async (t) => {
    for (const fixture of [undefined, "laundry"]) {
      const root = await workspace(t, fixture),
        result = await calculate(root, await readSource(root), options);
      assert.ok(
        result.passed,
        JSON.stringify(
          result.results.map((r) => r.checks.filter((c) => !c.passed)),
        ),
      );
      assert.ok(result.suiteChecks.every((c) => c.passed));
      assert.equal(result.coverage.length, fixture ? 2 : 1);
      assert.ok(
        result.results.every(
          (r) =>
            r.engine.version === "2026.9.3" &&
            r.engine.storage.includes("non-persistent"),
        ),
      );
      assert.ok(result.results.some((r) => !r.calls.length));
    }
  },
);
test(
  "native Core: controlled timers agree with normal real-clock hold + chained delay",
  native,
  async (t) => {
    const root = await workspace(t),
      source = shortSource();
    const controlled = await engine(root, source, "presence", options);
    const real = await engine(root, source, "presence", {
      ...options,
      realClock: true,
    });
    for (const result of [controlled, real])
      assert.ok(result.passed, JSON.stringify(result.checks));
    assert.deepEqual(
      real.calls.map((c) => c.service),
      controlled.calls.map((c) => c.service),
    );
    for (let i = 0; i < 2; i++)
      assert.ok(Math.abs(real.calls[i].at - controlled.calls[i].at) < 0.6);
    assert.equal(real.engine.clock, "real UTC + normal asyncio");
  },
);
test(
  "native Core: exact schema, undeclared references and fixture capabilities fail closed",
  native,
  async (t) => {
    const root = await workspace(t),
      source = shortSource();
    for (const [yaml, pattern] of [
      ["- id: a\n  id: b\n", /Duplicate YAML key/],
      ["- !include secrets.yaml", /includes, secrets, tags/],
      [
        source.yaml.replaceAll(
          "binary_sensor.reading",
          "binary_sensor.missing",
        ),
        /Undeclared entity/,
      ],
      [
        source.yaml.replace('"initial_state":false', '"initial_state":true'),
        /initial_state/,
      ],
      [
        source.yaml.replace('"trigger":"state"', '"trigger":"mqtt"'),
        /external trigger adapter/,
      ],
      [
        source.yaml.replace('"seconds":1', '"seconds":"nonsense"'),
        /expected float/,
      ],
    ])
      await assert.rejects(
        engine(root, { ...source, yaml }, "presence", options),
        pattern,
      );
    const spoof = structuredClone(source);
    spoof.project.entities[1].attributes = { supported_features: 65535 };
    await assert.rejects(
      engine(root, spoof, "presence", options),
      /cannot override native/,
    );
    const dynamic = structuredClone(source),
      rules = JSON.parse(dynamic.yaml);
    rules[0].conditions = [
      {
        condition: "template",
        value_template: "{{ states('sensor.missing') == 'on' }}",
      },
    ];
    dynamic.yaml = JSON.stringify(rules);
    await assert.rejects(
      engine(root, dynamic, "presence", options),
      /Undeclared entity reference/,
    );
  },
);
test(
  "native Core: unknown service is an error; an untriggered rule cannot earn a full passing suite",
  native,
  async (t) => {
    const root = await workspace(t),
      source = shortSource(),
      rules = JSON.parse(source.yaml);
    rules[0].actions = [
      { action: "notify.mobile_app_phone", data: { message: "Example only" } },
    ];
    const bad = await engine(
      root,
      { ...source, yaml: JSON.stringify(rules) },
      "presence",
      options,
    );
    assert.equal(bad.passed, false);
    assert.ok(
      bad.checks.some(
        (c) => c.name === "No engine execution errors" && !c.passed,
      ),
    );
    source.project.scenarios[0].steps = [];
    source.project.scenarios[0].expect.calls = [];
    const uncovered = await calculate(root, source, options);
    assert.ok(uncovered.results.every((r) => r.passed));
    assert.equal(uncovered.passed, false);
    assert.equal(uncovered.suiteChecks[0].passed, false);
  },
);
test(
  "native Core: cancellation and wall timeout leave no child job directories",
  native,
  async (t) => {
    const root = await workspace(t),
      source = shortSource(),
      controller = new AbortController();
    const running = engine(root, source, "presence", {
      ...options,
      realClock: true,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(running, /cancelled/);
    await assert.rejects(
      engine(root, source, "presence", { ...options, timeout: 10 }),
      /wall-clock budget/,
    );
    assert.deepEqual(await readdir(join(root, ".harness/jobs")), []);
  },
);
test(
  "native Core: failed revision preserves last delivery and clears readiness",
  native,
  async (t) => {
    const root = await workspace(t),
      source = shortSource();
    await writeFile(join(root, "project.json"), json(source.project));
    await writeFile(join(root, "automations.yaml"), source.yaml);
    await build(root, options);
    const before = await readFile(join(root, "output/project.zip"));
    source.project.scenarios[0].expect.calls[0].between = [0, 0.1];
    await writeFile(join(root, "project.json"), json(source.project));
    await assert.rejects(build(root, options), /checks failed/);
    assert.ok(before.equals(await readFile(join(root, "output/project.zip"))));
    assert.equal(
      (await readJSON(join(root, ".harness/verdict.json"))).ready,
      false,
    );
  },
);
test(
  "native Core: local-time trigger crosses the spring DST jump and time-pattern timers repeat",
  native,
  async (t) => {
    const root = await workspace(t),
      source = shortSource(),
      rule = JSON.parse(source.yaml)[0],
      c = source.project.scenarios[0];
    source.project.timezone = "Europe/London";
    c.start = "2026-03-29T00:59:58Z";
    c.steps = [];
    c.until = 5;
    rule.triggers = [{ trigger: "time", at: "02:00:01" }];
    rule.actions = [rule.actions[0]];
    c.expect = {
      calls: [
        {
          service: "light.turn_on",
          entities: ["light.reading"],
          between: [3.05, 3.501],
        },
      ],
      states: { "light.reading": { state: "on" } },
    };
    source.yaml = JSON.stringify([rule]);
    const local = await engine(root, source, c.id, options);
    assert.ok(local.passed, JSON.stringify(local.checks));
    rule.triggers = [{ trigger: "time_pattern", seconds: "/2" }];
    source.yaml = JSON.stringify([rule]);
    // Core deliberately assigns each time-pattern tracker a 50–500 ms phase to
    // avoid synchronized callbacks. A matching start second is included.
    c.expect.calls = [0, 2, 4].map((at) => ({
      service: "light.turn_on",
      entities: ["light.reading"],
      between: [at + 0.05, at + 0.501],
    }));
    const repeated = await engine(root, source, c.id, options);
    assert.ok(repeated.passed, JSON.stringify(repeated.checks));
  },
);
test(
  "native Core: held template trigger, rendered action and wait-template complete in order",
  native,
  async (t) => {
    const root = await workspace(t),
      source = shortSource(),
      rule = JSON.parse(source.yaml)[0],
      c = source.project.scenarios[0];
    rule.triggers = [
      {
        trigger: "template",
        value_template: "{{ is_state('binary_sensor.reading', 'on') }}",
        for: { seconds: 1 },
      },
    ];
    rule.actions[0].data = { brightness_pct: "{{ 20 + 25 }}" };
    rule.actions[1] = {
      wait_template: "{{ is_state('binary_sensor.reading', 'off') }}",
      timeout: 2,
      continue_on_timeout: false,
    };
    c.steps.push({ at: 2, entity: "binary_sensor.reading", state: "off" });
    c.expect.calls[0].data = { brightness_pct: 45 };
    source.yaml = JSON.stringify([rule]);
    const result = await engine(root, source, c.id, options);
    assert.ok(result.passed, JSON.stringify(result.checks));
  },
);
test(
  "native Core: custom event drives native fan, switch and numeric-helper services",
  native,
  async (t) => {
    const root = await workspace(t),
      source = shortSource(),
      c = source.project.scenarios[0];
    source.project.entities = [
      {
        id: "fan.example_air",
        name: "Example air",
        kind: "fan",
        state: "on",
        attributes: { percentage: 20 },
      },
      {
        id: "switch.example_indicator",
        name: "Example indicator",
        kind: "switch",
        state: "off",
      },
      {
        id: "input_number.example_level",
        name: "Example level",
        kind: "input_number",
        state: "0",
      },
    ];
    c.steps = [
      { at: 0, event: "example_scene" },
      { at: 0.5, entity: "fan.example_air", state: "off" },
    ];
    c.until = 1;
    c.expect = {
      calls: [
        {
          service: "fan.set_percentage",
          entities: ["fan.example_air"],
          data: { percentage: 50 },
          between: [0, 0.1],
        },
        {
          service: "switch.turn_on",
          entities: ["switch.example_indicator"],
          between: [0, 0.1],
        },
        {
          service: "input_number.set_value",
          entities: ["input_number.example_level"],
          data: { value: 12.3 },
          between: [0, 0.1],
        },
      ],
      states: {
        "fan.example_air": { state: "off", attributes: { percentage: 0 } },
        "switch.example_indicator": { state: "on" },
        "input_number.example_level": { state: "12.3" },
      },
    };
    source.yaml = JSON.stringify([
      {
        id: "example_scene",
        alias: "Example scene",
        initial_state: false,
        triggers: [{ trigger: "event", event_type: "example_scene" }],
        actions: c.expect.calls.map((call) => ({
          action: call.service,
          target: { entity_id: call.entities },
          data: call.data || {},
        })),
      },
    ]);
    const result = await engine(root, source, c.id, options);
    assert.ok(result.passed, JSON.stringify(result.checks));
  },
);
test(
  "native isolation denies network, subprocess and out-of-config writes before effects",
  native,
  async (t) => {
    const root = await workspace(t),
      config = join(root, "guard-config");
    await mkdir(config);
    const { stdout } = await promisify(execFile)(
      options.python,
      [
        "-I",
        join(packageRoot, "test/guard_probe.py"),
        join(root, "tools/engine.py"),
        config,
      ],
      { timeout: 10000 },
    );
    assert.equal(JSON.parse(stdout).denied, 6);
  },
);

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalize,
  simulate,
  checkTrigger,
  checkCondition,
} from "../skills/home-assistant/scripts/model.mjs";
const rule = normalize([
  {
    id: "a",
    alias: "Welcome",
    triggers: [
      { trigger: "state", entity_id: "person.demo", from: "away", to: "home" },
    ],
    conditions: [
      { condition: "state", entity_id: "sun.sun", state: "below_horizon" },
    ],
    actions: [{ action: "light.turn_on" }],
  },
])[0];
test("state transition and conditions produce intent only", () => {
  assert.equal(
    simulate(
      rule,
      { entity: "person.demo", from: "away", to: "home" },
      { "sun.sun": "below_horizon" },
    ).status,
    "would-run",
  );
  assert.equal(
    simulate(
      rule,
      { entity: "person.demo", from: "away", to: "home" },
      { "sun.sun": "above_horizon" },
    ).status,
    "blocked",
  );
  assert.equal(
    simulate(
      rule,
      { entity: "person.demo", from: "home", to: "home" },
      { "sun.sun": "below_horizon" },
    ).status,
    "no-trigger",
  );
});
test("numeric triggers require entering strict bounds", () => {
  const r = { trigger: "numeric_state", entity_id: "sensor.a", above: 1000 };
  assert.equal(
    checkTrigger(r, { entity: "sensor.a", from: "900", to: "1100" }),
    true,
  );
  assert.equal(
    checkTrigger(r, { entity: "sensor.a", from: "1050", to: "1100" }),
    false,
  );
  assert.equal(
    checkTrigger(r, { entity: "sensor.a", from: "900", to: "1000" }),
    false,
  );
  assert.equal(
    checkTrigger(r, { entity: "sensor.a", from: "unknown", to: "1100" }),
    null,
  );
});
test("unsupported semantics cannot pass", () => {
  for (const extra of [
    { for: "00:02:00" },
    { attribute: "mode" },
    { to: "{{ value }}" },
  ])
    assert.equal(
      checkTrigger(
        { ...rule.triggers[0], ...extra },
        { entity: "person.demo", from: "away", to: "home" },
      ),
      null,
    );
  assert.equal(
    checkCondition({ condition: "template", value_template: "true" }, {}),
    null,
  );
  assert.equal(
    simulate(
      { ...rule, actions: [{ delay: 10 }] },
      { entity: "person.demo", from: "away", to: "home" },
      { "sun.sun": "below_horizon" },
    ).status,
    "unknown",
  );
});
test("modern and legacy keys normalize; duplicates and missing structure fail", () => {
  assert.equal(
    normalize([
      {
        id: "a",
        alias: "A",
        trigger: { platform: "time", at: "09:00" },
        action: { action: "light.turn_on" },
      },
    ])[0].triggers.length,
    1,
  );
  assert.throws(
    () => normalize([{ ...rule, triggers: [], actions: [] }]),
    /trigger/,
  );
  assert.throws(() => normalize([rule, rule]), /unique/);
  assert.throws(
    () => normalize([{ ...rule, trigger: rule.triggers }]),
    /not both/,
  );
});
test("fixed-time comparison and missing state", () => {
  assert.equal(
    checkTrigger({ trigger: "time", at: "23:00:00" }, { time: "23:00" }),
    true,
  );
  assert.equal(
    checkTrigger({ trigger: "time", at: "25:00" }, { time: "25:00" }),
    null,
  );
  assert.equal(checkCondition(rule.conditions[0], {}), null);
});

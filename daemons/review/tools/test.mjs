import { load } from "./dom-test.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { openingTimeline, risingRows } from "./player.mjs";
import {
  rollTraits,
  individualFlags,
  oneIn,
  renderIndividualSprite,
} from "../../tools/render.mjs";
import { eggColor, individualColor } from "../../tools/bake.mjs";
const daemon = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of ["index.html", "overnight/index.html"])
  load(path.join(daemon, file));
assert.deepEqual(risingRows(["head", "body", "feet"], ["shell"], 4, 5, 1), [
  "",
  "",
  "head",
  "shell",
]);
assert.deepEqual(risingRows(["head", "body", "feet"], ["shell"], 4, 5, 3), [
  "head",
  "body",
  "feet",
  "shell",
]);
const R = JSON.parse(
  readFileSync(path.resolve(daemon, "../roster.json"), "utf8"),
);
const P = JSON.parse(
  readFileSync(path.resolve(daemon, "../plates.json"), "utf8"),
);
{
  const a = load(path.join(daemon, "traits.html"), { reduced: true });
  const groups = JSON.parse(a.$("#traits-data").textContent);
  for (const group of groups)
    for (const sample of group.samples) {
      const traits = rollTraits(R, group.id, sample.traits.seed),
        sp = R.daemons.find((d) => d.id === group.id);
      assert.deepEqual(sample.traits, traits);
      assert.equal(sample.flags, individualFlags(R, group.id, traits));
      assert.equal(sample.oneIn, oneIn(R, group.id, traits));
      assert.equal(
        sample.oneLine,
        renderIndividualSprite(R, group.id, traits, 2, "idle", {
          motion: false,
        }),
      );
      assert.ok(sample.oneLine.length <= R.rules.statusCells);
      for (const mat of [".", "m", "e", ...(traits.extra ? ["a"] : [])])
        assert.equal(
          a.context.DaemonReview.individualColor(
            R,
            sp,
            traits,
            24,
            7,
            "@",
            mat,
          ),
          individualColor(R, sp, traits, 24, 7, "@", mat),
        );
    }
  console.log(
    "PASS all 60 seeds, flags, odds, status sprites and reference material colours",
  );
}
for (const file of ["eggs.html", "lookbook.html"]) {
  const a = load(path.join(daemon, file));
  const { $, document, click, input, advance } = a;
  const data = JSON.parse($("#eggs-data").textContent);
  for (const [kind, egg] of Object.entries(data)) {
    for (const stage of [
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
      "rock",
      "burst",
      "tumble",
      "open",
    ])
      assert.deepEqual(egg[stage], P.eggs[kind].reveal[stage]);
    const timeline = openingTimeline(egg, R.rules.plate.eggMs, 8);
    assert.equal(timeline[0].stage, "rock");
    assert.equal(timeline.at(-1).rise, 8);
    assert.equal(
      timeline.find((s) => s.stage === "burst").ms,
      R.rules.plate.eggMs.burstHold,
    );
    for (const light of ["plain", "common", "rare", "legendary", "secret"])
      for (const mat of [
        ".",
        "g",
        "p",
        ...(R.rules.eggs[kind].stars ? ["s"] : []),
      ])
        assert.equal(
          a.context.DaemonReview.eggColor(R, kind, 24, 7, "@", mat, { light }),
          eggColor(R, kind, 24, 7, "@", mat, { light }),
        );
  }
  const firstFrame = $("#eggArt").firstChild;
  advance(80);
  assert.equal(
    $("#eggArt").firstChild,
    firstFrame,
    "Same frame must not repaint",
  );
  assert.equal(document.querySelectorAll("#eggGrid button").length, 8);
  if (file === "eggs.html")
    assert.equal(document.querySelectorAll("#states figure").length, 9);
  for (const kind of [
    "first",
    "setup",
    "turn",
    "week",
    "marathon",
    "night",
    "easter",
    "history",
  ]) {
    click(`#eggGrid [data-value="${kind}"]`);
    click('#eggProgress [data-value="0"]');
    assert.equal($("#eggHatch").disabled, true);
    assert.match($("#eggNote").textContent, /Still earning/);
    click([...document.querySelectorAll("#eggProgress button")].at(-1));
    assert.equal($("#eggHatch").disabled, false);
    for (const b of document.querySelectorAll("#eggRarity button"))
      if (!b.disabled) {
        click(b);
        click("#eggHatch");
        advance(120);
        click("#eggPause");
        const still = $("#eggArt").innerHTML;
        advance(120);
        assert.equal($("#eggArt").innerHTML, still, "Paused frame must hold");
        click("#eggPause");
        input("#eggScrub", $("#eggScrub").max);
        assert.match($("#eggWords").textContent, /fork\(\) returned 0/);
        assert.equal($("#eggPause").disabled, true);
        click("#eggReset");
        assert.equal($("#eggFrameCount").textContent, "—");
      }
    input("#eggScrub", $("#eggScrub").max);
    assert.match($("#eggWords").textContent, /fork\(\) returned 0/);
  }
  click("[data-review-motion]");
  const t = a.context.Review.now();
  assert.equal(a.timers.size, 0, "Paused motion has no clock timer");
  advance(1000);
  assert.equal(a.context.Review.now(), t);
  click("#eggReset");
  click("#eggHatch");
  assert.match($("#eggWords").textContent, /fork\(\) returned 0/);
  console.log(
    "PASS",
    file,
    "all egg kinds, rarities, progress, pause/resume, replay, seeking, global motion",
  );
  const reduced = load(path.join(daemon, file), { reduced: true });
  reduced.click("#eggHatch");
  assert.match(reduced.$("#eggWords").textContent, /fork\(\) returned 0/);
}
{
  const a = load(path.join(daemon, "eggs.html"));
  a.click("#eggHatch");
  a.advance(12000);
  assert.match(a.$("#eggWords").textContent, /fork\(\) returned 0/);
  a.document.hidden = true;
  a.event(a.document, "visibilitychange");
  assert.equal(a.timers.size, 0, "Hidden pages have no clock timer");
  const time = a.context.Review.now();
  a.advance(1000);
  assert.equal(a.context.Review.now(), time);
  console.log("PASS complete timed hatch and hidden-page suspension");
}
{
  const a = load(path.join(daemon, "traits.html"));
  const { $, document, click, input } = a;
  assert.equal(document.querySelectorAll(".sample-card").length, 60);
  assert.equal($("#traitCount").textContent, "60 of 60 samples");
  input("#speciesFilter", "tim", "change");
  assert.equal($("#traitCount").textContent, "6 of 60 samples");
  input("#traitFilter", "extra", "change");
  assert.ok(
    [...document.querySelectorAll(".sample-card")].filter((el) => !el.hidden)
      .length < 6,
  );
  input("#traitSearch", "no-such-trait");
  assert.equal($("#traitEmpty").hidden, false);
  click("#clearFilters");
  assert.equal($("#traitCount").textContent, "60 of 60 samples");
  input("#traitSearch", "beanie");
  assert.ok(
    [...document.querySelectorAll(".sample-card")].some((el) => !el.hidden),
  );
  click("#speciesLinks a");
  assert.equal($("#traitCount").textContent, "60 of 60 samples");
  console.log("PASS traits filters, empty state, reset, species links");
}

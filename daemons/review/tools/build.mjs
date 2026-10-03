// Build standalone HTML with inline scripts, styles, and current model data. No server or npm install.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { plate, crop, cropBox } from "../../tools/plate.mjs";
import { plateSource } from "../../tools/bake.mjs";
import {
  eggLine,
  eggStage,
  rollTraits,
  individualFlags,
  oneIn,
  renderIndividualSprite,
  renderSprite,
} from "../../tools/render.mjs";
import { openingTimeline, risingRows } from "./player.mjs";

const here = dirname(fileURLToPath(import.meta.url)),
  review = resolve(here, ".."),
  repo = resolve(review, "../..");
const read = (path) => readFileSync(path, "utf8"),
  local = (name) => read(resolve(here, name));
const check = process.argv.includes("--check"),
  rebake = process.argv.includes("--rebake");
const roster = JSON.parse(read(resolve(repo, "daemons/roster.json"))),
  plates = JSON.parse(read(resolve(repo, "daemons/plates.json")));
if (plates.source !== plateSource(repo, roster))
  throw new Error(
    "Canonical plates are stale. Run node daemons/tools/generate.mjs first.",
  );
const held = new Set(roster.drops.filter((d) => d.hold).map((d) => d.id));
const daemons = roster.daemons.filter((d) => !held.has(d.drop));
const sampleSeeds = [1363, 839, 2727, 210, 2138, 2621];
const timSeeds = [
  1641, 171, 2942, 525, 3626, 1888, 1414, 2362, 1935, 2097, 2632, 1515,
];
const hash = createHash("sha256").update(
  JSON.stringify({ roster, sampleSeeds, timSeeds }),
);
for (const file of [
  "daemons/tools/plate.mjs",
  "daemons/tools/render.mjs",
  ...daemons.map((d) => "daemons/plates/" + d.id + ".mjs"),
])
  hash.update(read(resolve(repo, file)));
const source = hash.digest("hex");
function cached(file, id) {
  if (rebake || !existsSync(resolve(review, file))) return null;
  const html = read(resolve(review, file));
  if (!html.includes('name="daemon-review-source" content="' + source + '"'))
    return null;
  return JSON.parse(
    html.match(
      new RegExp(
        '<script type="application/json" id="' + id + '">([\\s\\S]*?)</script>',
      ),
    )[1],
  );
}
async function samples(id, seeds, previous) {
  const model = await import(
    new URL("../../plates/" + id + ".mjs", import.meta.url)
  );
  const output = [];
  for (const seed of seeds) {
    const traits = rollTraits(roster, id, seed);
    let frames = previous?.find((s) => s.traits.seed === seed)?.frames;
    if (!frames) {
      if (check)
        throw new Error(
          "Sample art is stale. Run node daemons/review/tools/build.mjs",
        );
      const raw = [],
        mats = [];
      for (let i = 0; i < roster.rules.plate.frames.idle; i++) {
        const material = [];
        raw.push(
          plate(
            model.model({
              t: (i / roster.rules.plate.frames.idle) * Math.PI * 2,
              mood: "idle",
              age: "2.0",
              traits,
            }),
            roster.rules.plate.cols.reveal,
            { mats: material },
          ),
        );
        mats.push(material);
      }
      const box = cropBox(raw),
        rows = crop(raw, box),
        materials = crop(mats, box);
      frames = rows.map((r, i) => ({
        rows: r.join("\n"),
        mats: materials[i].join("\n"),
      }));
    }
    output.push({
      id,
      traits,
      flags: individualFlags(roster, id, traits),
      oneIn: oneIn(roster, id, traits),
      oneLine: renderIndividualSprite(roster, id, traits, 2, "idle", {
        motion: false,
      }),
      frames,
    });
  }
  return output;
}
const previous = cached("traits.html", "traits-data"),
  traitData = [];
for (const d of daemons) {
  traitData.push({
    id: d.id,
    samples: await samples(
      d.id,
      sampleSeeds,
      previous?.find((s) => s.id === d.id)?.samples,
    ),
  });
  if (!check) console.log("Prepared six " + d.id + " samples");
}
const timData = await samples(
  "tim",
  timSeeds,
  cached("lookbook.html", "tims-data"),
);
const { earn, firstEgg, setupEgg } = roster.rules;
const reviewEggs = {
  first: {
    need: firstEgg.need,
    unit: "habits",
    short: `Your first ${firstEgg.need} habits`,
    detail: `Complete ${firstEgg.need} distinct habits, including a finished turn. The first egg leans toward tim.`,
  },
  setup: {
    need: setupEgg.need,
    unit: "habits",
    short: `${setupEgg.need} habits, one setup egg`,
    detail: `Complete ${setupEgg.need} distinct habits. This setup egg is earned once.`,
  },
  turn: {
    need: earn.turn.every,
    unit: "turns",
    short: `Every ${earn.turn.every} counted turns`,
    detail: `Finish ${earn.turn.every} counted turns. At most ${earn.turn.dailyCap} count each day; long turns count once more per ${earn.turn.minutesPerTurn} agent-minutes.`,
  },
  week: {
    need: earn.week.days,
    unit: "days",
    short: `${earn.week.days} days in one week`,
    detail: `Work on ${earn.week.days} different days within one week.`,
  },
  marathon: {
    need: earn.marathon.turns,
    unit: "turns",
    short: `${earn.marathon.turns} turns or ${earn.marathon.machines} computers`,
    detail: `Reach ${earn.marathon.turns} counted turns, or connect a second computer.`,
  },
  night: {
    need: earn.night.nights,
    unit: "nights",
    short: "Three nights of work",
    detail: `On ${earn.night.nights} nights, a turn you started finishes between ${earn.night.fromHour}:00 and 0${earn.night.toHour}:59 while you have been away for ${earn.night.awayMinutes} minutes. Can hold a secret.`,
  },
  easter: {
    need: 1,
    unit: "word",
    short: "A hidden word",
    detail:
      "A hidden word earns an egg once. Can hold a legendary or a secret.",
  },
  history: {
    need: 1,
    unit: "turn",
    short: "A week in computing history",
    detail: `Finish a turn during a computing anniversary’s ${earn.history.days}-day window. An eligible, unowned historical species hatches first; otherwise the normal draw applies.`,
  },
};
const R = {
  ...roster,
  daemons,
  reviewEggs,
  reviewSprites: Object.fromEntries(
    daemons.map((d) => [
      d.id,
      renderSprite(roster, d, 0, "idle", { motion: false }),
    ]),
  ),
  banner: JSON.parse(read(resolve(repo, "daemons/banner.json"))),
  plates: {
    frameMs: plates.frameMs,
    daemons: Object.fromEntries(
      daemons.map((d) => [d.id, plates.daemons[d.id]]),
    ),
  },
};
const eggs = Object.fromEntries(
  Object.entries(plates.eggs).map(([k, v]) => [
    k,
    { ...v.reveal, thumb: v.portrait.p4 },
  ]),
);
const json = (id, value) =>
  '<script type="application/json" id="' +
  id +
  '">' +
  JSON.stringify(value).replace(/</g, "\\u003c") +
  "</script>";
const script = (code) => "<script>\n" + code + "\n</script>";
// Embed the actual reference colour functions, without their Node-only baking imports.
const colors = read(resolve(repo, "daemons/tools/bake.mjs")).split(
  "export function plateColor",
)[1];
const api =
  "window.DaemonReview=(()=>{\nfunction plateColor" +
  colors.replaceAll("export function", "function") +
  "\n" +
  [eggLine, eggStage, openingTimeline, risingRows]
    .map((fn) => fn.toString())
    .join("\n") +
  "\nreturn {plateColor,eggColor,individualColor,eggLine,eggStage,openingTimeline,risingRows};})();";
const pages = [
  {
    file: "index.html",
    name: "Overview",
    title: "A field guide to daemons.",
    kicker: "Local review / drop init",
    description:
      "The art, the little differences, and the moment an egg opens. Every preview lives here in the repository.",
  },
  {
    file: "eggs.html",
    name: "Eggs",
    title: "A little life, earned.",
    kicker: "01 / Eggs & hatching",
    description:
      "Eight egg kinds, nine shell stages, and a hatch player you can pause and inspect frame by frame.",
  },
  {
    file: "traits.html",
    name: "Traits",
    title: "Same species. Entirely yours.",
    kicker: "02 / Individuals & traits",
    description:
      "Sixty samples from the ten species in drop init. Explore the colours, shapes, markings, and rare extras that make each hatch its own.",
  },
  {
    file: "lookbook.html",
    name: "Lookbook",
    title: "Meet the daemons.",
    kicker: "03 / The lookbook",
    description:
      "The reviewed terminal world, refreshed with current art: drop init, moods, growth, twelve tims, and eggs.",
  },
  {
    file: "overnight/index.html",
    name: "Build report",
    title: "One night of building.",
    kicker: "Archive / 26–27 September 2026",
    description:
      "The original overnight report, preserved with its screenshots. A historical snapshot, with a link to the later handoff.",
  },
];
const indexBody =
  '<main class="wrap" id="review-main" tabindex="-1"><div class="review-index">' +
  pages
    .slice(1)
    .map(
      (p, i) =>
        '<a class="review-destination" href="' +
        p.file +
        '"><span class="review-kicker">0' +
        (i + 1) +
        " / " +
        p.name +
        "</span><h2>" +
        p.title +
        "</h2><p>" +
        p.description +
        "</p><span>Open " +
        p.name.toLowerCase() +
        " →</span></a>",
    )
    .join("") +
  '</div><aside class="review-notice">The first three pages use the current roster and models. The build report preserves the earlier implementation. Motion follows your system preference and can be paused on every animated page.</aside></main>';
for (const page of pages) {
  const prefix = page.file.startsWith("overnight/") ? "../" : "";
  const archive = page.file.startsWith("overnight/");
  const nav =
    '<nav class="review-nav" aria-label="Review pages">' +
    pages
      .map(
        (p) =>
          '<a href="' +
          prefix +
          p.file +
          '"' +
          (p === page ? ' aria-current="page"' : "") +
          ">" +
          p.name +
          "</a>",
      )
      .join("") +
    (!archive && page.file !== "index.html"
      ? '<button type="button" data-review-motion aria-pressed="false">Pause motion</button>'
      : "") +
    "</nav>";
  const header =
    '<a class="review-skip" href="#review-main">Skip to content</a><header class="review-header">' +
    nav +
    '<div class="review-kicker">' +
    page.kicker +
    "</div><h1>" +
    page.title +
    "</h1><p>" +
    page.description +
    "</p></header>";
  const footer =
    '<footer class="review-footer"><a href="' +
    prefix +
    'index.html">All reviews</a><a href="' +
    prefix +
    '../../docs/research/2026-09-27-daemons-handoff.md">Build handoff</a><span>Local files · no account, server, or external assets required</span></footer>';
  let body,
    extraCss = "";
  if (page.file === "index.html") body = indexBody;
  else if (page.file === "eggs.html")
    body =
      '<main class="wrap" id="review-main" tabindex="-1">' +
      local("eggs-body.html") +
      "</main>" +
      json("eggs-data", eggs) +
      json("roster-data", R) +
      script(local("eggs.js"));
  else if (page.file === "traits.html")
    body =
      '<main class="wrap" id="review-main" tabindex="-1">' +
      local("traits-body.html") +
      "</main>" +
      json("traits-data", traitData) +
      json("roster-data", { ...R, plates: undefined, banner: undefined }) +
      script(local("traits.js"));
  else if (page.file === "lookbook.html") {
    extraCss = local("lookbook.css");
    body = local("lookbook-body.html")
      .replace("<!-- review:tims-data -->", json("tims-data", timData))
      .replace("<!-- review:traits-script -->", script(local("traits.js")))
      .replace(
        "<!-- review:egg-player -->",
        local("eggs-body.html").match(
          /<!-- eggs:start -->([\s\S]*?)<!-- eggs:end -->/,
        )[1].trim(),
      )
      .replace("<!-- review:eggs-data -->", json("eggs-data", eggs))
      .replace("<!-- review:eggs-script -->", script(local("eggs.js")))
      .replace("<!-- review:roster-data -->", json("roster-data", R));
  } else {
    extraCss = local("overnight.css");
    body = local("overnight-body.html");
  }
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="daemon-review-source" content="' +
    source +
    '">\n<title>' +
    page.name +
    " · Daemons review</title>\n<style>\n" +
    extraCss +
    "\n" +
    local("review.css") +
    "\n</style>\n" +
    (!archive && page.file !== "index.html"
      ? script(local("review.js")) + script(api)
      : "") +
    "\n</head>\n<body>\n" +
    header +
    "\n" +
    body +
    '\n<noscript><p class="review-notice">Enable JavaScript to use the interactive previews. All data is included in this file; no network connection is needed.</p></noscript>\n' +
    footer +
    "\n</body>\n</html>\n";
  const output = resolve(review, page.file);
  if (check) {
    if (read(output) !== html)
      throw new Error(
        page.file + " is stale. Run node daemons/review/tools/build.mjs",
      );
  } else {
    writeFileSync(output, html);
    console.log("Wrote " + page.file);
  }
}
if (check) console.log("All five daemon review pages match their sources.");

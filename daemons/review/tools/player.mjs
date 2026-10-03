// A deterministic, seekable opening sequence. Timings come from the shipping roster.
export function openingTimeline(egg, timings, rows) {
  const timeline = [];
  const add = (stage, ms) =>
    egg[stage].forEach((_, index) =>
      timeline.push({
        stage,
        index,
        ms: typeof ms === "function" ? ms(index) : ms,
      }),
    );
  add("rock", timings.rock);
  add("rock", timings.rock);
  add("burst", (i) => (i === 0 ? timings.burstHold : timings.burst));
  add("tumble", timings.tumble);
  add("open", timings.open);
  for (let rise = 1; rise <= rows; rise++)
    timeline.push({ stage: "hatchling", index: 0, rise, ms: 55 });
  return timeline;
}

// Keep the floor fixed and reveal the head first. Paint the full creature before cropping,
// so its gradient does not change as each new row becomes visible.
export function risingRows(creature, shell, creatureWidth, shellWidth, count) {
  const width = Math.max(creatureWidth, shellWidth);
  const indent = (row, cols) =>
    " ".repeat(Math.max(0, Math.floor((width - cols) / 2))) + row;
  const n = Math.max(0, Math.min(creature.length, count));
  return [
    ...Array(creature.length - n).fill(""),
    ...creature.slice(0, n).map((row) => indent(row, creatureWidth)),
    ...shell.map((row) => indent(row, shellWidth)),
  ];
}

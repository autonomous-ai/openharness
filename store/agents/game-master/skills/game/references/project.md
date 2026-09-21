# Relay source contract

`game/project.json` stores the project without `rules`; `game/rules.mjs` stores the full import-free
ES module. Downloaded `.relay.json` bundles them into one source file. `tools/build.mjs` bundles the
studio and a worker into `game/index.html`, with all game data and original embedded artwork.
The offline HTML still plays, edits and exports. The server viewer adds optimistic source saves
and `.harness/history/*.relay.json` backups of both data and rules.

## Project

Version 1: `spec`, stable `id`, `title`, `subtitle`, `players` (1–6), `rulebook` sections
(`heading`, `body`), `settings`, `components`, `boards`. In the bundled form, also `rules` text.
`revision` is a derived SHA-256 of canonical complete source, never an authored identifier.

Settings have a stable `id`, `label`, numeric `value`, `min`, `max`, `step`. Rules must validate
integers when required. Components have `id`, `name`, `body`, `kind` (`card`, `token`, `tile`),
`widthMm`, `heightMm`, `quantity`, hex `color` and `ink`, `symbol`, a plain `values` object of
numbers/text/booleans, optional `locked`, and optional embedded image `face`. The renderer uses
component values for human-readable captions and the printed inventory; rules choose their
meaning. Quantity controls real physical copies. Rules must conserve pieces/decks as appropriate.

`face` is a base64 `data:image/png|jpeg|webp|svg+xml` URL (one actual MIME type). It renders as an
image, never inline supplied SVG markup. It owns the entire printed face, including text. Keep
original artwork provenance. Without custom artwork, cards have a generated face; tiles with a
`values.ports` string of `N`, `E`, `S`, `W` have connecting paths. This is an optional rendering
convention, not a gameplay constraint. The agent can extend source rendering for other designs.

Boards have `id`, `name`, `widthMm`, `heightMm`, `cols`, `rows`, and a row-major array of
`{label,color}` cells. The studio uses their coordinates; SVG/PDF exports retain physical sizes. Printed boards reserve
12 mm at the top for the title: each cell measures `widthMm / cols` by `(heightMm - 12) / rows`.
For edge-to-edge tile connections, make those dimensions equal to the physical tile size.
There is no claim that an arbitrary large board fits a phone at playable scale.

Limits: 3 MB complete project; 200 KB rules; 160 designs / 600 physical pieces; 1–100 copies/design;
12–190 mm width and 12–273 mm height; eight A4 landscape boards with up to 20 rows/columns;
30 settings; 40 rulebook sections. Imported artwork is at most 500 KB per file. A component whose
text does not fit must be shortened/enlarged or given an appropriate original face. Generated cards reject overflowing text. Tokens show a name/symbol; connecting tiles show the
name/ports. Their remaining values stay in the printed inventory. Use a custom face when the
piece itself needs additional instructions.

## Rules exports

Every state is plain finite JSON with `player` (zero-based active player). Every hook is synchronous.
State/project inputs are frozen copies. Do not mutate module globals, use time/network/unseeded
randomness, or import dependencies. Use `ctx.shuffle(array, streamName)` or `ctx.random(streamName)`;
keep the returned generator for successive draws. Reopening the same named stream starts it again.
Context seeds include the game seed and action index; give independent concerns distinct names.

```js
export function initial(project, ctx) { return {player: 0, /* own state */}; }
export function legal(state, project) { return [{id: 'draw', label: 'Draw a card'}]; }
export function apply(state, action, project, ctx) { /* return a new changed state */ }
export function observe(state, player, project) {
  return {
    title: 'Your turn', message: 'Choose a card.', private: true,
    scores: [{label: 'Points', value: 0}],
    zones: [{id:'hand', label:'Your hand', items:[
      {key:'copy-1', component:'card-id', action:'draw'}
    ]}]
  };
}
export function outcome(state, project) { return null; /* or {title,winners:[0],...} */ }
export function validate(state, project) { return true; /* or a readable error */ }
export function bot(observation, legalActions, {random}) { return legalActions[0].id; }
```

Optional zone `board` refers to a board id. Items use `cell` (row-major index), `rotation` in
clockwise degrees, optional `badge`, `faceDown`. Card actions must refer to a current legal id.
Keep observation-only views honest: do not put other players' private hands in them. The current
legal actions must themselves be safe to show to that player. The policy only receives the
observation and actions, but package code is not a hostile-code security sandbox.

Finished games return an outcome and no legal actions. Active games must offer 1–500 unique,
readable legal actions. A playtest has at most 2,000 actions. State and observation each stay below
1 MB. Rule invocation has a browser worker time limit; simulation has a 30-second limit. Node
checks have a 60-second worker budget. Limits produce errors; they do not justify claiming all
possible games or all seeds terminate.

## Editions, checks and delivery

The table retains its running edition while source drafts change. Applying edits downloads the
prior playable game/replay before starting the new one. Replay files bind actions, seed and exact
final state to the complete source revision; changed source cannot silently reinterpret a replay.
A replay carries full state, including hidden information. Undo is a testing affordance.

`tools/check.mjs` runs uniform-choice simulations twice, checks outcomes/turn caps/errors and
rebuilds every replay. `tools/export.mjs destination` checks an initial rules state, builds source,
produces SVG/HTML/PDF files and ZIP. This export check does not establish human playability.
The browser exports the current validated edition and its actual session replay; its print views
support the browser's Save PDF. Custom source changes also need actual human-input and physical
rulebook review. Do not claim PDF export, passing simulations, or a screenshot proves a good game.

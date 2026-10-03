// Entry point for `fleet models --machine ID`: copied to that machine beside inventory.mjs and
// candidates.mjs and run by its own Node, so the table describes that machine — its disk, its engines,
// its memory — not the controller's.
import { inventory, summarize } from './inventory.mjs';

const found = await inventory();
console.log(process.argv.includes('--summary') ? summarize(found) : JSON.stringify(found));

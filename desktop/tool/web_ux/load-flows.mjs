// Every flow in flows/<group>.mjs for one fixture build. A new file in that
// folder is picked up as it is; a flow name in two files is an error.
//
// step: ['click', name] button by accessible name (substring)
//       ['exact', name] button by exact accessible name
//       ['text', text]  first element showing that text
//       ['rclick', name] right-click a control
//       ['key', key]    a key press
// `wide` / `compact` steps replace `steps` at >= 720 px / below it; a flow
// with `only: 'wide'|'compact'` is skipped at the other widths. `fixture`
// names the build it runs on: 'app' (tool/web_ux_fixture.dart, the default)
// or 'super-tab' (tool/super_tab_mobile_fixture.dart).
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = join(dirname(fileURLToPath(import.meta.url)), 'flows');

export async function loadFlows(fixture = 'app') {
  const all = [];
  const files = readdirSync(folder).filter((f) => f.endsWith('.mjs') && f !== 'steps.mjs').sort();
  for (const file of files) {
    const { FLOWS } = await import(join(folder, file));
    for (const flow of FLOWS) all.push({ ...flow, group: file.replace(/\.mjs$/, '') });
  }
  const seen = new Map();
  for (const flow of all) {
    if (seen.has(flow.name)) {
      throw new Error(`Flow "${flow.name}" is in both ${seen.get(flow.name)} and ${flow.group}`);
    }
    seen.set(flow.name, flow.group);
  }
  return all.filter((flow) => (flow.fixture ?? 'app') === fixture);
}

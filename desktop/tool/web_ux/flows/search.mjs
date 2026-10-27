// Flows for the search on a phone: the results alone, a row's details behind a Back, and the
// list again (owner, 2026-10-27: "split it into slides instead of stacking two blocks").
// A wider window shows the same flows with the list and preview together, as before.
//
// Fix group: phone search drill-down. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
import { menu } from './steps.mjs';

const machines = menu('Machines');

export const FLOWS = [
  { name: 'search-machines', scenario: 'workspace', steps: machines },
  { name: 'search-machine-details', scenario: 'workspace', steps: [...machines, ['text', 'Studio Mac']] },
  {
    name: 'search-machines-back',
    scenario: 'workspace',
    only: 'compact',
    steps: [...machines, ['text', 'Studio Mac'], ['exact', 'Back']],
  },
  { name: 'search-harnesses', scenario: 'workspace', steps: [...machines, ['click', 'Harnesses']] },
  {
    name: 'search-harness-details',
    scenario: 'workspace',
    only: 'compact',
    steps: [...machines, ['click', 'Harnesses'], ['click', 'Details']],
  },
];

// Flows for first load and connect speed.
//
// Fix group: speed (first load and connect). Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
export const FLOWS = [
  { name: 'first-machine-saved', scenario: 'first-machine-saved' },
  { name: 'finder-part', scenario: 'finder-part', only: 'wide' },
];

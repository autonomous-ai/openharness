// Flows for start-up; the bundle's load time is load-time.mjs.
//
// Fix group: 7, first load. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
export const FLOWS = [
  { name: 'booting', scenario: 'booting' },
];

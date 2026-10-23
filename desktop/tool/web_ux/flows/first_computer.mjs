// Flows for the first-computer page and an offline workspace.
//
// Fix group: 4, first computer and offline workspace. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
export const FLOWS = [
  { name: 'first-machine', scenario: 'first-machine' },
  { name: 'first-machine-loading', scenario: 'first-machine-loading' },
  { name: 'first-machine-failed', scenario: 'first-machine-failed' },
  { name: 'link-machine', scenario: 'link-machine' },
  { name: 'computers', scenario: 'computers' },
  { name: 'link-password', scenario: 'link-machine', steps: [['exact', 'Connect']] },
  { name: 'offline-only', scenario: 'offline-only' },
  { name: 'offline-back', scenario: 'offline-back' },
];

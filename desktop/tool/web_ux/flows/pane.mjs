// Flows for terminal panes, their states and header pickers.
//
// Fix group: 3, pane header and states. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
export const FLOWS = [
  { name: 'workspace-one', scenario: 'workspace-one' },
  { name: 'connecting', scenario: 'connecting' },
  { name: 'reconnecting', scenario: 'reconnecting' },
  { name: 'offline', scenario: 'offline' },
  { name: 'view-only', scenario: 'view-only' },
  { name: 'opening', scenario: 'opening' },
  { name: 'taken-over', scenario: 'taken-over' },
  { name: 'terminal-error', scenario: 'terminal-error' },
  { name: 'agent-picker', scenario: 'workspace', steps: [['click', 'Agent: ']] },
  { name: 'model-picker', scenario: 'workspace', steps: [['click', 'Model: ']] },
];

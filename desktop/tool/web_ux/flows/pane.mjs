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
  // A computer's header names agent and model; a phone's puts both behind one menu.
  { name: 'agent-picker', scenario: 'workspace', only: 'wide', steps: [['click', 'Agent: ']] },
  { name: 'model-picker', scenario: 'workspace', only: 'wide', steps: [['click', 'Model: ']] },
  // Group 3's own: three panes (two columns on a tablet), and the phone's Agent and model menu.
  { name: 'pane-three', scenario: 'pane-three' },
  { name: 'agent-model-menu', scenario: 'workspace-one', only: 'compact', steps: [['exact', 'Agent and model']] },
];

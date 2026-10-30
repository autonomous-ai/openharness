// Flows more than one fix group reviews.
//
// Fix group: none (shared). Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
import { menu } from './steps.mjs';

export const FLOWS = [
  { name: 'workspace', scenario: 'workspace' },
  { name: 'notifications', scenario: 'workspace', steps: [['exact', 'Notifications']] },
  { name: 'open-harness', scenario: 'workspace', steps: [['exact', 'Open Harness']] },
  { name: 'models', scenario: 'workspace', steps: menu('Models') },
  { name: 'history', scenario: 'workspace', steps: menu('History') },
  { name: 'appearance', scenario: 'workspace', steps: menu('Appearance') },
  { name: 'add-phone', scenario: 'workspace', only: 'wide', steps: [['exact', 'Add Phone']] },
  { name: 'harness-monitor', scenario: 'workspace', only: 'wide', steps: [['click', 'Click to open Harness Monitor']] },
];

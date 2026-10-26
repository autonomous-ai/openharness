// Flows for sign-in, the New tab pages, the New Harness form and the shortcuts page.
//
// Fix group: 5, welcome pages, hints and downloads. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
import { menu, settings } from './steps.mjs';

export const FLOWS = [
  { name: 'signin', scenario: 'signin' },
  { name: 'signin-waiting', scenario: 'signin-waiting' },
  { name: 'signin-error', scenario: 'signin-error' },
  { name: 'signin-expired', scenario: 'signin-expired' },
  { name: 'signin-qr', scenario: 'signin-qr' },
  { name: 'signin-confirm', scenario: 'signin-confirm' },
  { name: 'new-tab', scenario: 'workspace', steps: [['exact', 'New Tab']] },
  { name: 'empty-tab', scenario: 'empty-tab' },
  { name: 'split-pane', scenario: 'workspace', steps: menu('Split pane') },
  settings('Keyboard shortcuts'),
];

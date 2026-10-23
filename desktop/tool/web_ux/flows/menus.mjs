// Flows for the web menus, tabs, the footer dropdown and Settings' Back.
//
// Fix group: 1, web menus, commands and hit sizes. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
import { menu } from './steps.mjs';

export const FLOWS = [
  { name: 'app-menu', scenario: 'workspace', steps: [['exact', 'Menu']] },
  { name: 'many-tabs', scenario: 'many-tabs' },
  { name: 'tab-switcher', scenario: 'many-tabs', only: 'compact', steps: [['click', 'Tabs:']] },
  { name: 'tab-menu', scenario: 'many-tabs', only: 'wide', steps: [['rclick', 'docs']] },
  { name: 'footer-menu', scenario: 'workspace', only: 'compact', steps: [['click', 'Status:']] },
  { name: 'all-commands', scenario: 'workspace', steps: menu('All commands') },
  { name: 'machines', scenario: 'workspace', steps: menu('Machines') },
  { name: 'settings', scenario: 'workspace', steps: menu('Settings') },
  // Group 1's own: what New Swarm opens, and the phone tab menu's Rename Tab… dialog.
  { name: 'new-swarm', scenario: 'workspace', steps: menu('New Swarm') },
  // The same Swarm by its key, for comparison with the menu's.
  { name: 'new-swarm-key', scenario: 'workspace', steps: [['key', 'Alt+s']] },
  { name: 'tab-menu-rename', scenario: 'many-tabs', only: 'wide', steps: [['rclick', 'docs'], ['text', 'Rename Tab…']] },
];

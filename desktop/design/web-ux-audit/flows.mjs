// What capture.mjs photographs: a fixture scenario (tool/web_ux_scenarios.dart),
// an optional path, and the clicks a person makes to get there. Steps name the
// control as a screen reader hears it, so a flow that cannot be clicked
// through fails instead of being faked.
//
// step: ['click', name] button by accessible name (substring)
//       ['exact', name] button by exact accessible name
//       ['text', text]  first element showing that text
//       ['rclick', name] right-click a control
//       ['key', key]    a key press
// `wide` / `compact` steps replace `steps` at >= 720 px / below it; a flow
// with `only: 'wide'|'compact'` is skipped at the other widths.

const SETTINGS = [
  'Account', 'Appearance', 'Notifications', 'Privacy', 'Keyboard shortcuts',
  'Usage', 'Routing', 'Tab invites', 'Experimental', 'About',
];

export const FLOWS = [
  // Sign-in and start-up
  { name: 'signin', scenario: 'signin' },
  { name: 'signin-waiting', scenario: 'signin-waiting' },
  { name: 'signin-error', scenario: 'signin-error' },
  { name: 'signin-expired', scenario: 'signin-expired' },
  { name: 'booting', scenario: 'booting' },
  // First computer
  { name: 'first-machine', scenario: 'first-machine' },
  { name: 'first-machine-loading', scenario: 'first-machine-loading' },
  { name: 'link-machine', scenario: 'link-machine' },
  { name: 'computers', scenario: 'computers' },
  { name: 'link-password', scenario: 'link-machine', steps: [['exact', 'Connect']] },
  // Workspace shell
  { name: 'workspace', scenario: 'workspace' },
  { name: 'workspace-one', scenario: 'workspace-one' },
  { name: 'new-tab', scenario: 'workspace', steps: [['exact', 'New Tab']] },
  { name: 'empty-tab', scenario: 'empty-tab' },
  { name: 'many-tabs', scenario: 'many-tabs' },
  { name: 'error-banner', scenario: 'error-banner' },
  { name: 'new-device', scenario: 'new-device' },
  { name: 'app-menu', scenario: 'workspace', steps: [['exact', 'Menu']] },
  { name: 'tab-switcher', scenario: 'many-tabs', only: 'compact', steps: [['click', 'Tabs:']] },
  { name: 'tab-menu', scenario: 'many-tabs', only: 'wide', steps: [['rclick', 'docs']] },
  { name: 'footer-menu', scenario: 'workspace', only: 'compact', steps: [['click', 'Status:']] },
  { name: 'notifications', scenario: 'workspace', steps: [['exact', 'Notifications']] },
  { name: 'open-harness', scenario: 'workspace', steps: [['exact', 'Open Harness']] },
  { name: 'agent-picker', scenario: 'workspace', steps: [['click', 'Agent: ']] },
  { name: 'model-picker', scenario: 'workspace', steps: [['click', 'Model: ']] },
  { name: 'machines', scenario: 'workspace', steps: [['exact', 'Menu'], ['exact', 'Machines']] },
  { name: 'models', scenario: 'workspace', steps: [['exact', 'Menu'], ['exact', 'Models']] },
  { name: 'history', scenario: 'workspace', steps: [['exact', 'Menu'], ['exact', 'History']] },
  { name: 'all-commands', scenario: 'workspace', steps: [['exact', 'Menu'], ['exact', 'All commands']] },
  { name: 'appearance', scenario: 'workspace', steps: [['exact', 'Menu'], ['exact', 'Appearance']] },
  { name: 'split-pane', scenario: 'workspace', steps: [['exact', 'Menu'], ['exact', 'Split pane']] },
  { name: 'add-phone', scenario: 'workspace', only: 'wide', steps: [['exact', 'Add Phone']] },
  { name: 'harness-monitor', scenario: 'workspace', only: 'wide', steps: [['click', 'Click to open Harness Monitor']] },
  {
    name: 'store',
    scenario: 'workspace',
    wide: [['exact', 'Harness Store']],
    compact: [['exact', 'Menu'], ['exact', 'Store']],
  },
  {
    name: 'store-product',
    scenario: 'workspace',
    wide: [['exact', 'Harness Store'], ['text', 'Work with Claude directly']],
    compact: [['exact', 'Menu'], ['exact', 'Store'], ['text', 'Work with Claude directly']],
  },
  // Terminal panes
  { name: 'connecting', scenario: 'connecting' },
  { name: 'reconnecting', scenario: 'reconnecting' },
  { name: 'offline', scenario: 'offline' },
  { name: 'view-only', scenario: 'view-only' },
  { name: 'opening', scenario: 'opening' },
  { name: 'taken-over', scenario: 'taken-over' },
  { name: 'terminal-error', scenario: 'terminal-error' },
  // Settings, one section each
  { name: 'settings', scenario: 'workspace', steps: [['exact', 'Menu'], ['exact', 'Settings']] },
  ...SETTINGS.map((section) => ({
    name: `settings-${section.toLowerCase().replace(/ /g, '-')}`,
    scenario: 'workspace',
    steps: [['exact', 'Menu'], ['exact', 'Settings'], ['exact', section]],
  })),
  // Links opened from outside the app
  { name: 'shared-link', scenario: 'signin', path: '/s/0b6f6a8e-2c1d-4f3e-9a7b-5d4c3b2a1f00#key=fixture' },
  { name: 'viewer-incomplete', scenario: 'workspace', path: '/?viewer=1' },
  { name: 'viewer-page', scenario: 'workspace', path: '/?viewer=1&machine=m1&agent=a1' },
];

// Flows for tool/super_tab_mobile_fixture.dart (the Super Tab review fixture
// from PR #1570), captured with FLOWS=./super-tab-flows.mjs.
export const FLOWS = [
  { name: 'super-tab', scenario: 'rich' },
  { name: 'super-tab-group', scenario: 'rich', path: '/?group=wg-blocked' },
  { name: 'super-tab-one', scenario: 'one' },
  { name: 'super-tab-empty', scenario: 'empty' },
  { name: 'super-tab-viewer', scenario: 'viewer' },
  { name: 'super-tab-offline', scenario: 'offline' },
  { name: 'super-tab-roster', scenario: 'rich', steps: [['click', 'Members and machines']] },
  { name: 'super-tab-conversations', scenario: 'rich', only: 'compact', steps: [['click', 'Conversations']] },
  { name: 'super-tab-terminals', scenario: 'rich', steps: [['click', 'Group terminals']] },
  { name: 'super-tab-pull-requests', scenario: 'rich', steps: [['click', 'Pull requests']] },
];

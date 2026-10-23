// Flows for error and empty states, device bands, outside links, Settings pages and the Super Tab.
//
// Fix group: 6, error states, bands and copy. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
import { settings } from './steps.mjs';

// The Super Tab flows run on tool/super_tab_mobile_fixture.dart (FIXTURE=super-tab).
const superTab = (name, scenario, more = {}) => ({ fixture: 'super-tab', name, scenario, ...more });

export const FLOWS = [
  { name: 'error-banner', scenario: 'error-banner' },
  { name: 'new-device', scenario: 'new-device' },
  { name: 'shared-link', scenario: 'signin', path: '/s/0b6f6a8e-2c1d-4f3e-9a7b-5d4c3b2a1f00#key=fixture' },
  { name: 'viewer-incomplete', scenario: 'workspace', path: '/?viewer=1' },
  { name: 'viewer-page', scenario: 'workspace', path: '/?viewer=1&machine=m1&agent=a1' },
  ...['Account', 'Appearance', 'Notifications', 'Privacy', 'Usage', 'Routing',
    'Tab invites', 'Experimental', 'About'].map(settings),
  superTab('super-tab', 'rich'),
  superTab('super-tab-group', 'rich', { path: '/?group=wg-blocked' }),
  superTab('super-tab-one', 'one'),
  superTab('super-tab-empty', 'empty'),
  superTab('super-tab-viewer', 'viewer'),
  superTab('super-tab-offline', 'offline'),
  superTab('super-tab-roster', 'rich', { steps: [['click', 'Members and machines']] }),
  superTab('super-tab-conversations', 'rich', { only: 'compact', steps: [['click', 'Conversations']] }),
  superTab('super-tab-terminals', 'rich', { steps: [['click', 'Group terminals']] }),
  superTab('super-tab-pull-requests', 'rich', { steps: [['click', 'Pull requests']] }),
];

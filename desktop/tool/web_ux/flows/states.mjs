// Flows for error and empty states, device bands, outside links and Settings pages.
//
// Fix group: 6, error states, bands and copy. Each group keeps its flows here, so parallel groups never
// edit the same file; load-flows.mjs reads every file in this folder.
import { settings } from './steps.mjs';

export const FLOWS = [
  { name: 'error-banner', scenario: 'error-banner' },
  { name: 'new-device', scenario: 'new-device' },
  { name: 'shared-link', scenario: 'signin', path: '/s/0b6f6a8e-2c1d-4f3e-9a7b-5d4c3b2a1f00#key=fixture' },
  { name: 'viewer-incomplete', scenario: 'workspace', path: '/?viewer=1' },
  { name: 'viewer-page', scenario: 'workspace', path: '/?viewer=1&machine=m1&agent=a1' },
  ...['Account', 'Appearance', 'Notifications', 'Privacy', 'Usage', 'Routing',
    'Tab invites', 'Experimental', 'About'].map(settings),
  // Usage in a browser with the account's subscriptions read (P6).
  { ...settings('Usage'), name: 'settings-usage-subscriptions', scenario: 'subscriptions' },
];

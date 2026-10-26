// Click paths more than one flow file uses.

/// ☰ then a row of the web app menu.
export const menu = (row) => [['exact', 'Menu'], ['exact', row]];

/// One Settings section, opened from the app menu: flow `settings-<section>`.
export const settings = (section) => ({
  name: `settings-${section.toLowerCase().replace(/ /g, '-')}`,
  scenario: 'workspace',
  steps: [...menu('Settings'), ['exact', section]],
});

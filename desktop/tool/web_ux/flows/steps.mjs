// Click paths more than one flow file uses.

/// + then a row of the web's New menu.
export const menu = (row) => [['exact', 'New'], ['exact', row]];

/// The avatar then a row of its account menu.
export const account = (row) => [['exact', 'Account'], ['exact', row]];

/// A mode of the search box, at every width: `@` machines, `:` models.
export const picker = (prefix) => [['exact', 'Open Harness'], ['key', prefix]];

/// One Settings section, opened from the account menu: flow `settings-<section>`.
export const settings = (section) => ({
  name: `settings-${section.toLowerCase().replace(/ /g, '-')}`,
  scenario: 'workspace',
  steps: [...account('Settings'), ['exact', section]],
});

/** Stands in for lib/computerName.ts in a bundled CLI, so a test knows the label a new machine is sent with. */
export const FAKE_COMPUTER_NAME = 'Test Lab Mac'

export const computerName = (): string => FAKE_COMPUTER_NAME

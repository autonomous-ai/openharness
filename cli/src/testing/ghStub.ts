/**
 * The `gh` an end-to-end daemon finds first on its PATH (e2e/harness/daemon.ts). The daemon runs `gh` for a shared tab's
 * tasks (messages/tasks.ts); without this, a test daemon would use the developer's own GitHub login. A test that needs
 * answers writes its own script over this file in the daemon's bin folder.
 */
export const GH_FORBIDDEN_MESSAGE = 'The real gh is forbidden in tests: this is a stub. A test supplies its own canned answers.'
export const GH_FORBIDDEN_STUB = `#!/bin/sh\necho '${GH_FORBIDDEN_MESSAGE}' >&2\nexit 97\n`

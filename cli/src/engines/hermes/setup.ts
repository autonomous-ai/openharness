import { env as hookEnvironment } from '../../config/env.js'
import { HERMES_SESSION_PANE, HERMES_CONFIG_HOMES } from './contract.js'


/** pre_llm_call registers resumed sessions too; on_session_start only fires for a new one. */
export const HERMES_HOOK_SETTINGS = {
  home: hookEnvironment.HERMES_HOME,
  homes: HERMES_CONFIG_HOMES,
  begin: '# machine-adapter: session discovery (managed block — safe to delete)',
  end: '# machine-adapter: end',
  events: ['on_session_start', 'pre_llm_call'],
  timeout: 10,
  allowlist: 'shell-hooks-allowlist.json',
  ownership: ['notify.mjs', '--engine hermes'],
  messages: {
    missing: '[hooks] no Hermes config at {file} — skipping (run hermes once first)',
    foreign: '[hooks] {file} has its own `hooks:` block — leaving it untouched.',
    manual: '[hooks] add these entries under it manually to mirror Hermes sessions:',
    current: '[hooks] Hermes session hooks already installed',
    installed: '[hooks] installed Hermes session hooks → {file}',
    collapsed: '[hooks] installed Hermes session hooks (collapsed {removed} stale blocks) → {file}',
    after: '[hooks] (takes effect on the next hermes session start)',
    failed: '[hooks] failed to write Hermes config.yaml:',
  },
  // Each session then carries the pane it was opened from (`HERMES_SESSION_PANE`). Hermes 0.21 ignores the key.
  passthrough: {
    section: 'terminal', key: 'client_env_passthrough', names: HERMES_SESSION_PANE.names,
    unlisted: '[hooks] {file} has no terminal.client_env_passthrough list to add Harness\'s pane names to:'
      + ' sessions from a shared Hermes gateway (Hermes 0.22+) will not bind to their harness',
  },
} as const satisfies import('../kit/nativeHookYaml.js').NativeYamlHooks


export const HERMES_HOOKS_SAID = {
  removed: "[hooks] removed Harness's Hermes hooks → {file}",
  kept: "[hooks] could not remove Harness's Hermes hooks from {file} · {reason}",
  unknown: "[hooks] Hermes's version could not be read · its session hooks are kept",
} as const
